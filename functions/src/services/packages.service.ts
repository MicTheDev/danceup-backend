import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";
import { createConnectedProduct } from "./stripe.service";

export interface PackageStat {
  packageId: string;
  packageName: string;
  price: number;
  credits: number;
  unitsSold: number;
  activeStudents: number;
  totalCreditsRemaining: number;
  totalCreditsUsed: number;
  renewalCount: number;
  estimatedRevenue: number;
}

export interface ExpiringPackage {
  studentId: string;
  studentName: string;
  packageId: string;
  packageName: string;
  creditsRemaining: number;
  expirationDate: string;
  daysUntilExpiry: number;
}

export interface NeverUsedPackage {
  studentId: string;
  studentName: string;
  packageId: string;
  packageName: string;
  creditsRemaining: number;
  purchaseDate: string;
  daysSincePurchase: number;
}

export interface PackageAnalyticsResult {
  perPackage: PackageStat[];
  expiringIn30Days: ExpiringPackage[];
  neverUsed: NeverUsedPackage[];
}

export class PackagesService {
  async getStudioOwnerId(authUid: string): Promise<string | null> {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) return null;
    return userDoc.id;
  }

  async getPackages(studioOwnerId: string): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const snapshot = await db.collection("packages")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    return snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        ...data,
        classIds: Array.isArray(data["classIds"]) ? (data["classIds"] as string[]) : [],
      };
    });
  }

  async getPackageById(
    packageId: string, studioOwnerId: string,
  ): Promise<(Record<string, unknown> & { id: string }) | null> {
    const db = getFirestore();
    const doc = await db.collection("packages").doc(packageId).get();
    if (!doc.exists) return null;
    const packageData = doc.data() as Record<string, unknown>;
    if (packageData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Package does not belong to this studio owner");
    }
    return {
      id: doc.id,
      ...packageData,
      classIds: Array.isArray(packageData["classIds"]) ? (packageData["classIds"] as string[]) : [],
    };
  }

  async createPackage(packageData: Record<string, unknown>, studioOwnerId: string): Promise<string> {
    const db = getFirestore();
    const studioOwnerDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioOwnerData = studioOwnerDoc.exists ? (studioOwnerDoc.data() as Record<string, unknown>) : {};
    const studioName = (studioOwnerData["studioName"] as string) || "";
    const connectedAccountId = (studioOwnerData["stripeAccountId"] as string) || null;

    let stripeProductId: string | null = null;
    if (connectedAccountId) {
      try {
        const stripeProduct = await createConnectedProduct(packageData, studioOwnerId, studioName, connectedAccountId);
        stripeProductId = stripeProduct.id;
      } catch (error) {
        console.error("Failed to create Stripe product on connected account for package:", error);
        throw error;
      }
    }

    const docRef = await db.collection("packages").add({
      ...packageData,
      studioOwnerId,
      stripeProductId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async updatePackage(
    packageId: string, packageData: Record<string, unknown>, studioOwnerId: string,
  ): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("packages").doc(packageId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Package not found");
    const existingData = doc.data() as Record<string, unknown>;
    if (existingData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Package does not belong to this studio owner");
    }
    await ref.update({ ...packageData, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  async deletePackage(packageId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("packages").doc(packageId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Package not found");
    const packageData = doc.data() as Record<string, unknown>;
    if (packageData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Package does not belong to this studio owner");
    }
    await ref.delete();
  }

  async getPackageAnalytics(studioOwnerId: string): Promise<PackageAnalyticsResult> {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();
    const in30Days = admin.firestore.Timestamp.fromMillis(
      now.toMillis() + 30 * 24 * 60 * 60 * 1000,
    );

    // Load all packages and students in parallel
    const [packagesSnapshot, studentsSnapshot] = await Promise.all([
      db.collection("packages").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
    ]);

    const packageMap = new Map<string, { id: string; name: string; price: number; credits: number }>();
    for (const doc of packagesSnapshot.docs) {
      const d = doc.data() as Record<string, unknown>;
      packageMap.set(doc.id, {
        id: doc.id,
        name: (d["name"] as string) || "Unknown",
        price: (d["price"] as number) || 0,
        credits: (d["credits"] as number) || 0,
      });
    }

    // Per-package accumulators
    const statMap = new Map<string, {
      packageId: string; packageName: string; price: number; originalCredits: number;
      unitsSold: number; activeStudents: Set<string>;
      totalCreditsRemaining: number; totalCreditsUsed: number;
      studentPurchaseCounts: Map<string, number>;
    }>();
    for (const [id, pkg] of packageMap) {
      statMap.set(id, {
        packageId: id, packageName: pkg.name, price: pkg.price, originalCredits: pkg.credits,
        unitsSold: 0, activeStudents: new Set(), totalCreditsRemaining: 0, totalCreditsUsed: 0,
        studentPurchaseCounts: new Map(),
      });
    }

    const expiringIn30Days: ExpiringPackage[] = [];
    const neverUsed: NeverUsedPackage[] = [];

    // Fan out across all students (fetch all credit subcollections in parallel)
    await Promise.all(studentsSnapshot.docs.map(async (studentDoc) => {
      const studentId = studentDoc.id;
      const sd = studentDoc.data() as Record<string, unknown>;
      const studentName =
        `${(sd["firstName"] as string) || ""} ${(sd["lastName"] as string) || ""}`.trim() || "Unknown";

      const creditsSnapshot = await db
        .collection("students").doc(studentId).collection("credits")
        .where("studioOwnerId", "==", studioOwnerId)
        .where("expirationDate", ">", now)
        .get();

      for (const creditDoc of creditsSnapshot.docs) {
        const credit = creditDoc.data() as Record<string, unknown>;
        const packageId = credit["packageId"] as string | null;
        if (!packageId) continue;

        const pkg = packageMap.get(packageId);
        const stat = statMap.get(packageId);
        if (!pkg || !stat) continue;

        const remaining = (credit["credits"] as number) || 0;

        const expirationDate = credit["expirationDate"] as admin.firestore.Timestamp;
        const purchaseDate = credit["purchaseDate"] as admin.firestore.Timestamp | undefined;

        // Count every credit entry as a unit sold (even if fully used), but only treat >0 as active balance.
        stat.unitsSold++;
        stat.studentPurchaseCounts.set(
          studentId, (stat.studentPurchaseCounts.get(studentId) || 0) + 1,
        );

        if (remaining > 0) {
          stat.activeStudents.add(studentId);
          stat.totalCreditsRemaining += remaining;
        }
        stat.totalCreditsUsed += Math.max(0, pkg.credits - Math.max(0, remaining));

        // Expiring in the next 30 days
        if (remaining > 0 && expirationDate.toMillis() <= in30Days.toMillis()) {
          const daysUntilExpiry = Math.ceil(
            (expirationDate.toMillis() - now.toMillis()) / (24 * 60 * 60 * 1000),
          );
          expiringIn30Days.push({
            studentId, studentName, packageId, packageName: pkg.name,
            creditsRemaining: remaining,
            expirationDate: expirationDate.toDate().toISOString(),
            daysUntilExpiry,
          });
        }

        // Never used — full original balance still intact
        if (remaining === pkg.credits) {
          const daysSincePurchase = purchaseDate
            ? Math.floor((now.toMillis() - purchaseDate.toMillis()) / (24 * 60 * 60 * 1000))
            : 0;
          neverUsed.push({
            studentId, studentName, packageId, packageName: pkg.name,
            creditsRemaining: remaining,
            purchaseDate: purchaseDate ? purchaseDate.toDate().toISOString() : "",
            daysSincePurchase,
          });
        }
      }
    }));

    const perPackage: PackageStat[] = Array.from(statMap.values())
      .filter((s) => s.unitsSold > 0)
      .map((s) => ({
        packageId: s.packageId,
        packageName: s.packageName,
        price: s.price,
        credits: s.originalCredits,
        unitsSold: s.unitsSold,
        activeStudents: s.activeStudents.size,
        totalCreditsRemaining: s.totalCreditsRemaining,
        totalCreditsUsed: s.totalCreditsUsed,
        renewalCount: Array.from(s.studentPurchaseCounts.values()).filter((c) => c > 1).length,
        estimatedRevenue: s.unitsSold * s.price,
      }))
      .sort((a, b) => b.estimatedRevenue - a.estimatedRevenue);

    expiringIn30Days.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
    neverUsed.sort((a, b) => b.daysSincePurchase - a.daysSincePurchase);

    return { perPackage, expiringIn30Days, neverUsed };
  }
}

export default new PackagesService();
