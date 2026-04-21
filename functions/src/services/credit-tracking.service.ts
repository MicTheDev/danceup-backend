import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";

interface ExpireCreditsResult {
  totalExpired: number;
  affectedStudents: number;
}

export class CreditTrackingService {
  async addCredits(
    studentId: string,
    studioOwnerId: string,
    credits: number,
    expirationDays: number,
    packageId: string | null = null,
    classId: string | null = null,
  ): Promise<string> {
    const db = getFirestore();
    if (!studentId || !studioOwnerId || !credits || credits <= 0) {
      throw new Error("Invalid parameters for adding credits");
    }
    if (!expirationDays || expirationDays <= 0) {
      throw new Error("expirationDays must be a positive number");
    }

    const purchaseDate = admin.firestore.Timestamp.now();
    const expirationDate = admin.firestore.Timestamp.fromMillis(
      purchaseDate.toMillis() + expirationDays * 24 * 60 * 60 * 1000,
    );

    const creditsRef = db.collection("students").doc(studentId).collection("credits");
    const docRef = await creditsRef.add({
      credits,
      purchaseDate,
      expirationDate,
      packageId,
      classId: classId ?? null,
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async getAvailableCredits(studentId: string, studioOwnerId: string, classId: string | null = null): Promise<number> {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();
    const creditsRef = db.collection("students").doc(studentId).collection("credits");

    const snapshot = classId
      ? await creditsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .where("classId", "==", classId)
          .where("expirationDate", ">", now)
          .get()
      : await creditsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .where("expirationDate", ">", now)
          .get();

    let total = 0;
    snapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      if (classId === null || data["classId"] === classId || data["classId"] === null) {
        total += (data["credits"] as number) || 0;
      }
    });
    return total;
  }

  async getLiveCreditsForAuthUser(authUid: string, studioOwnerId: string): Promise<number> {
    const db = getFirestore();
    const snapshot = await db.collection("students")
      .where("authUid", "==", authUid)
      .where("studioOwnerId", "==", studioOwnerId)
      .limit(1)
      .get();
    if (snapshot.empty) return 0;
    const firstDoc = snapshot.docs[0];
    if (!firstDoc) return 0;
    return this.getAvailableCredits(firstDoc.id, studioOwnerId);
  }

  async useCredit(studentId: string, studioOwnerId: string, classId: string | null = null): Promise<string> {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();
    const creditsRef = db.collection("students").doc(studentId).collection("credits");

    const snapshot = classId
      ? await creditsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .where("classId", "==", classId)
          .where("expirationDate", ">", now)
          .orderBy("expirationDate", "asc")
          .orderBy("purchaseDate", "asc")
          .get()
      : await creditsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .where("classId", "==", null)
          .where("expirationDate", ">", now)
          .orderBy("expirationDate", "asc")
          .orderBy("purchaseDate", "asc")
          .get();

    if (snapshot.empty) throw new Error("No available credits");

    let creditEntryDoc = null;
    for (const doc of snapshot.docs) {
      if ((doc.data() as Record<string, unknown>)["credits"] as number > 0) {
        creditEntryDoc = doc;
        break;
      }
    }
    if (!creditEntryDoc) throw new Error("No available credits");

    const currentCredits = ((creditEntryDoc.data() as Record<string, unknown>)["credits"] as number) || 0;
    if (currentCredits <= 0) throw new Error("No available credits");

    await creditsRef.doc(creditEntryDoc.id).update({
      credits: currentCredits - 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return creditEntryDoc.id;
  }

  async restoreCredit(studentId: string, studioOwnerId: string, creditUsedId: string): Promise<void> {
    const db = getFirestore();
    const creditsRef = db.collection("students").doc(studentId).collection("credits");
    const creditEntryRef = creditsRef.doc(creditUsedId);
    const creditEntryDoc = await creditEntryRef.get();

    if (!creditEntryDoc.exists) throw new Error("Credit entry not found");

    const creditEntryData = creditEntryDoc.data() as Record<string, unknown>;
    if (creditEntryData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Credit entry does not belong to this studio");
    }

    const now = admin.firestore.Timestamp.now();
    const expirationDate = creditEntryData["expirationDate"] as admin.firestore.Timestamp | undefined;
    if (expirationDate && expirationDate.toMillis() < now.toMillis()) {
      throw new Error("Cannot restore expired credit");
    }

    const currentCredits = (creditEntryData["credits"] as number) || 0;
    await creditEntryRef.update({
      credits: currentCredits + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async removeCredits(studentId: string, studioOwnerId: string, amount: number): Promise<void> {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();
    const creditsRef = db.collection("students").doc(studentId).collection("credits");

    const snapshot = await creditsRef
      .where("studioOwnerId", "==", studioOwnerId)
      .where("expirationDate", ">", now)
      .orderBy("expirationDate", "asc")
      .get();

    let available = 0;
    snapshot.forEach((doc) => {
      available += ((doc.data() as Record<string, unknown>)["credits"] as number) || 0;
    });

    if (available < amount) {
      throw new Error(`Not enough credits. Student has ${available}, tried to remove ${amount}.`);
    }

    let remaining = amount;
    const batch = db.batch();

    for (const doc of snapshot.docs) {
      if (remaining <= 0) break;
      const current = ((doc.data() as Record<string, unknown>)["credits"] as number) || 0;
      if (current <= 0) continue;

      if (current <= remaining) {
        batch.delete(doc.ref);
        remaining -= current;
      } else {
        batch.update(doc.ref, {
          credits: current - remaining,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        remaining = 0;
      }
    }

    await batch.commit();
  }

  async expireCredits(): Promise<ExpireCreditsResult> {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();
    const studentsSnapshot = await db.collection("students").get();

    let totalExpired = 0;
    let affectedStudents = 0;

    for (const studentDoc of studentsSnapshot.docs) {
      const creditsRef = db.collection("students").doc(studentDoc.id).collection("credits");
      const expiredSnapshot = await creditsRef.where("expirationDate", "<=", now).get();
      if (expiredSnapshot.empty) continue;

      const batch = db.batch();
      let studentExpired = 0;

      expiredSnapshot.forEach((doc) => {
        studentExpired += ((doc.data() as Record<string, unknown>)["credits"] as number) || 0;
        batch.delete(doc.ref);
      });

      await batch.commit();
      totalExpired += studentExpired;
      affectedStudents++;
    }

    return { totalExpired, affectedStudents };
  }
}

export default new CreditTrackingService();
