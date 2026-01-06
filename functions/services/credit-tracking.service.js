const admin = require("firebase-admin");
const authService = require("./auth.service");
const studioEnrollmentService = require("./studio-enrollment.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for managing student credits with expiration tracking
 */
class CreditTrackingService {
  /**
   * Add credits to a student's account with expiration date
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {number} credits - Number of credits to add
   * @param {number} expirationDays - Number of days until expiration
   * @param {string} packageId - Optional package ID that was purchased
   * @returns {Promise<string>} Credit entry document ID
   */
  async addCredits(studentId, studioOwnerId, credits, expirationDays, packageId = null) {
    const db = getFirestore();
    
    if (!studentId || !studioOwnerId || !credits || credits <= 0) {
      throw new Error("Invalid parameters for adding credits");
    }

    if (!expirationDays || expirationDays <= 0) {
      throw new Error("expirationDays must be a positive number");
    }

    // Calculate expiration date
    const purchaseDate = admin.firestore.Timestamp.now();
    const expirationDate = admin.firestore.Timestamp.fromMillis(
        purchaseDate.toMillis() + (expirationDays * 24 * 60 * 60 * 1000)
    );

    // Create credit entry in subcollection
    const creditsRef = db.collection("students").doc(studentId).collection("credits");
    const creditEntry = {
      credits: credits,
      purchaseDate: purchaseDate,
      expirationDate: expirationDate,
      packageId: packageId,
      studioOwnerId: studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await creditsRef.add(creditEntry);

    // Update cached credit totals
    await this.syncCreditBalance(studentId, studioOwnerId);

    return docRef.id;
  }

  /**
   * Get total available (non-expired) credits for a student
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<number>} Total available credits
   */
  async getAvailableCredits(studentId, studioOwnerId) {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();

    const creditsRef = db.collection("students").doc(studentId).collection("credits");
    const snapshot = await creditsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .where("expirationDate", ">", now)
        .get();

    let total = 0;
    snapshot.forEach((doc) => {
      const data = doc.data();
      total += data.credits || 0;
    });

    // If no credits found in subcollection, check cached value (for backward compatibility)
    // This handles the case where credits were purchased before the new system was implemented
    if (total === 0) {
      const studentRef = db.collection("students").doc(studentId);
      const studentDoc = await studentRef.get();
      
      if (studentDoc.exists) {
        const studentData = studentDoc.data();
        // Only use cached value if student belongs to this studio
        if (studentData.studioOwnerId === studioOwnerId && studentData.credits > 0) {
          // Migrate the cached credits to the new format
          console.log(`[CreditTracking] Migrating ${studentData.credits} credits from cached value for student ${studentId}`);
          try {
            await this.addCredits(
                studentId,
                studioOwnerId,
                studentData.credits,
                365, // Default 1 year expiration for migrated credits
                null // No package ID for migrated credits
            );
            // After migration, get the total again
            const migratedSnapshot = await creditsRef
                .where("studioOwnerId", "==", studioOwnerId)
                .where("expirationDate", ">", now)
                .get();
            
            total = 0;
            migratedSnapshot.forEach((doc) => {
              const data = doc.data();
              total += data.credits || 0;
            });
          } catch (error) {
            console.error(`[CreditTracking] Error migrating credits: ${error.message}`);
            // Fall back to cached value if migration fails
            return studentData.credits || 0;
          }
        }
      }
    }

    return total;
  }

  /**
   * Use one credit from the student's account (FIFO - oldest first)
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Credit entry document ID that was used
   */
  async useCredit(studentId, studioOwnerId) {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();

    // Get all non-expired credit entries for this studio, ordered by purchase date (oldest first)
    const creditsRef = db.collection("students").doc(studentId).collection("credits");
    const snapshot = await creditsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .where("expirationDate", ">", now)
        .orderBy("expirationDate", "asc")
        .orderBy("purchaseDate", "asc")
        .get();

    if (snapshot.empty) {
      throw new Error("No available credits");
    }

    // Find the first entry with credits > 0
    let creditEntryDoc = null;
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.credits > 0) {
        creditEntryDoc = doc;
        break;
      }
    }

    if (!creditEntryDoc) {
      throw new Error("No available credits");
    }

    const creditEntryData = creditEntryDoc.data();
    const currentCredits = creditEntryData.credits || 0;

    if (currentCredits <= 0) {
      throw new Error("No available credits");
    }

    // Decrement credit by 1
    const creditEntryRef = creditsRef.doc(creditEntryDoc.id);
    await creditEntryRef.update({
      credits: currentCredits - 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update cached credit totals
    await this.syncCreditBalance(studentId, studioOwnerId);

    return creditEntryDoc.id;
  }

  /**
   * Restore a credit that was previously used
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

    // Check if credit entry has expired
    const now = admin.firestore.Timestamp.now();
    if (creditEntryData.expirationDate && creditEntryData.expirationDate.toMillis() < now.toMillis()) {
      throw new Error("Cannot restore expired credit");
    }

    // Increment credit by 1
    const currentCredits = creditEntryData.credits || 0;
    await creditEntryRef.update({
      credits: currentCredits + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update cached credit totals
    await this.syncCreditBalance(studentId, studioOwnerId);
  }

  /**
   * Expire credits that have passed their expiration date
   * This is called by the scheduled function
   * @returns {Promise<Object>} Summary of expired credits
   */
  async expireCredits() {
    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();

    // Get all students
    const studentsRef = db.collection("students");
    const studentsSnapshot = await studentsRef.get();

    let totalExpired = 0;
    const affectedStudentsMap = new Map(); // Map<studentId, studioOwnerId>

    // Process each student's credit subcollection
    for (const studentDoc of studentsSnapshot.docs) {
      const studentId = studentDoc.id;
      const creditsRef = studentsRef.doc(studentId).collection("credits");
      
      // Find expired credit entries
      const expiredSnapshot = await creditsRef
          .where("expirationDate", "<=", now)
          .get();

      if (expiredSnapshot.empty) {
        continue;
      }

      // Delete expired entries
      const batch = db.batch();
      let studentExpired = 0;
      let studioOwnerId = null;

      expiredSnapshot.forEach((doc) => {
        const data = doc.data();
        studioOwnerId = data.studioOwnerId;
        studentExpired += data.credits || 0;
        batch.delete(doc.ref);
      });

      if (studentExpired > 0) {
        await batch.commit();
        totalExpired += studentExpired;
        if (studioOwnerId) {
          affectedStudentsMap.set(studentId, studioOwnerId);
        }
      }
    }

    // Update cached credit totals for affected students
    for (const [studentId, studioOwnerId] of affectedStudentsMap) {
      await this.syncCreditBalance(studentId, studioOwnerId);
    }

    return {
      totalExpired,
      affectedStudents: affectedStudentsMap.size,
    };
  }

  /**
   * Sync credit balance between credit subcollection and cached totals
   * Updates both students.credits and usersStudentProfiles.studios[studioId].credits
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async syncCreditBalance(studentId, studioOwnerId) {
    const db = getFirestore();
    
    // Calculate total available credits from subcollection
    const totalCredits = await this.getAvailableCredits(studentId, studioOwnerId);

    // Get student document to find authUid
    const studentRef = db.collection("students").doc(studentId);
    const studentDoc = await studentRef.get();
    
    if (!studentDoc.exists) {
      throw new Error("Student not found");
    }

    const studentData = studentDoc.data();
    const authUid = studentData.authUid;

    if (!authUid) {
      // If no authUid, only update students collection
      await studentRef.update({
        credits: totalCredits,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    // Update both collections atomically
    const batch = db.batch();

    // Update students collection
    batch.update(studentRef, {
      credits: totalCredits,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update usersStudentProfiles collection
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (studentProfileDoc) {
      const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
      const userProfileData = (await userProfileRef.get()).data();
      
      // Ensure studios structure exists
      const studios = studioEnrollmentService.ensureStudiosStructure(userProfileData);
      studios[studioOwnerId] = { credits: totalCredits };
      
      batch.update(userProfileRef, {
        studios: studios,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
  }
}

module.exports = new CreditTrackingService();

