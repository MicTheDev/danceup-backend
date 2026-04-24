import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";
import { createConnectedProduct } from "./stripe.service";

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
}

export default new PackagesService();
