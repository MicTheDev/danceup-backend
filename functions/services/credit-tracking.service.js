const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for managing student credits with expiration tracking.
 * The credits subcollection (students/{studentId}/credits) is the single
 * source of truth — no cached totals are written anywhere else.
 */
class CreditTrackingService {
  /**
   * Add credits to a student's account with expiration date
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {number} credits - Number of credits to add
   * @param {number} expirationDays - Number of days until expiration
   * @param {string} packageId - Optional package ID that was purchased
   * @param {string} classId - Optional class ID for class-specific credits (null for general credits)
   * @returns {Promise<string>} Credit entry document ID
   */
  async addCredits(studentId, studioOwnerId, credits, expirationDays, packageId = null, classId = null) {
    const db = getFirestore();

    if (!studentId || !studioOwnerId || !credits || credits <= 0) {
      throw new Error("Invalid parameters for adding credits");
    }

    if (!expirationDays || expirationDays <= 0) {
      throw new Error("expirationDays must be a positive number");
    }

    const purchaseDate = admin.firestore.Timestamp.now();
    const expirationDate = admin.firestore.Timestamp.fromMillis(
        purchaseDate.toMillis() + (expirationDays * 24 * 60 * 60 * 1000)
    );

    const creditsRef = db.collection("students").doc(studentId).collection("credits");
    const creditEntry = {
      credits: credits,
      purchaseDate: purchaseDate,
      expirationDate: expirationDate,
      packageId: packageId,
      classId: classId || null,
      studioOwnerId: studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await creditsRef.add(creditEntry);
    return docRef.id;
  }

  /**
   * Get total available (non-expired) credits for a student directly from the subcollection.
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {string} classId - Class ID to check class-specific credits, or null for all credits
   * @returns {Promise<number>} Total available credits
   */
  async getAvailableCredits(studentId, studioOwnerId, classId = null) {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();
    const creditsRef = db.collection("students").doc(studentId).collection("credits");

    let snapshot;
    if (classId) {
      snapshot = await creditsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .where("classId", "==", classId)
          .where("expirationDate", ">", now)
          .get();
    } else {
      snapshot = await creditsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .where("expirationDate", ">", now)
          .get();
    }

    let total = 0;
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (classId === null || data.classId === classId || data.classId === null) {
        total += data.credits || 0;
      }
    });

    return total;
  }

  /**
   * Get total available credits for a student identified by their Firebase Auth UID.
   * Looks up the student document then queries the credits subcollection.
   * @param {string} authUid - Firebase Auth UID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<number>} Total available credits
   */
  async getLiveCreditsForAuthUser(authUid, studioOwnerId) {
    const db = getFirestore();
    const snapshot = await db.collection("students")
        .where("authUid", "==", authUid)
        .where("studioOwnerId", "==", studioOwnerId)
        .limit(1)
        .get();

    if (snapshot.empty) return 0;
    return this.getAvailableCredits(snapshot.docs[0].id, studioOwnerId);
  }

  /**
   * Use one credit from the student's account (FIFO - oldest expiring first)
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {string} classId - Class ID to use class-specific credits, or null for general credits
   * @returns {Promise<string>} Credit entry document ID that was used
   */
  async useCredit(studentId, studioOwnerId, classId = null) {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();
    const creditsRef = db.collection("students").doc(studentId).collection("credits");

    let snapshot;
    if (classId) {
      snapshot = await creditsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .where("classId", "==", classId)
          .where("expirationDate", ">", now)
          .orderBy("expirationDate", "asc")
          .orderBy("purchaseDate", "asc")
          .get();
    } else {
      snapshot = await creditsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .where("classId", "==", null)
          .where("expirationDate", ">", now)
          .orderBy("expirationDate", "asc")
          .orderBy("purchaseDate", "asc")
          .get();
    }

    if (snapshot.empty) {
      throw new Error("No available credits");
    }

    let creditEntryDoc = null;
    for (const doc of snapshot.docs) {
      if (doc.data().credits > 0) {
        creditEntryDoc = doc;
        break;
      }
    }

    if (!creditEntryDoc) {
      throw new Error("No available credits");
    }

    const currentCredits = creditEntryDoc.data().credits || 0;
    if (currentCredits <= 0) {
      throw new Error("No available credits");
    }

    await creditsRef.doc(creditEntryDoc.id).update({
      credits: currentCredits - 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return creditEntryDoc.id;
  }

  /**
   * Restore a credit that was previously used (e.g. when removing an attendance record)
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {string} creditUsedId - Credit entry document ID that was used
   * @returns {Promise<void>}
   */
  async restoreCredit(studentId, studioOwnerId, creditUsedId) {
    const db = getFirestore();
    const creditsRef = db.collection("students").doc(studentId).collection("credits");
    const creditEntryRef = creditsRef.doc(creditUsedId);

    const creditEntryDoc = await creditEntryRef.get();
    if (!creditEntryDoc.exists) {
      throw new Error("Credit entry not found");
    }

    const creditEntryData = creditEntryDoc.data();
    if (creditEntryData.studioOwnerId !== studioOwnerId) {
      throw new Error("Credit entry does not belong to this studio");
    }

    const now = admin.firestore.Timestamp.now();
    if (creditEntryData.expirationDate && creditEntryData.expirationDate.toMillis() < now.toMillis()) {
      throw new Error("Cannot restore expired credit");
    }

    const currentCredits = creditEntryData.credits || 0;
    await creditEntryRef.update({
      credits: currentCredits + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Remove a specified number of credits from a student's account (FIFO — oldest expiring first).
   * Used for manual studio adjustments.
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {number} amount - Number of credits to remove (must be > 0)
   * @returns {Promise<void>}
   */
  async removeCredits(studentId, studioOwnerId, amount) {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();
    const creditsRef = db.collection("students").doc(studentId).collection("credits");

    const snapshot = await creditsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .where("expirationDate", ">", now)
        .orderBy("expirationDate", "asc")
        .get();

    let available = 0;
    snapshot.forEach((doc) => { available += doc.data().credits || 0; });

    if (available < amount) {
      throw new Error(`Not enough credits. Student has ${available}, tried to remove ${amount}.`);
    }

    let remaining = amount;
    const batch = db.batch();

    for (const doc of snapshot.docs) {
      if (remaining <= 0) break;
      const current = doc.data().credits || 0;
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

  /**
   * Delete expired credit entries from the subcollection.
   * Called by the scheduled credit-expiration function.
   * @returns {Promise<Object>} Summary of expired credits
   */
  async expireCredits() {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();

    const studentsSnapshot = await db.collection("students").get();

    let totalExpired = 0;
    let affectedStudents = 0;

    for (const studentDoc of studentsSnapshot.docs) {
      const creditsRef = db.collection("students").doc(studentDoc.id).collection("credits");
      const expiredSnapshot = await creditsRef
          .where("expirationDate", "<=", now)
          .get();

      if (expiredSnapshot.empty) continue;

      const batch = db.batch();
      let studentExpired = 0;

      expiredSnapshot.forEach((doc) => {
        studentExpired += doc.data().credits || 0;
        batch.delete(doc.ref);
      });

      await batch.commit();
      totalExpired += studentExpired;
      affectedStudents++;
    }

    return {totalExpired, affectedStudents};
  }
}

module.exports = new CreditTrackingService();
