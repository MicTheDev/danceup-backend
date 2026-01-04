const admin = require("firebase-admin");
const authService = require("./auth.service");
const studentsService = require("./students.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling studio enrollment operations
 */
class StudioEnrollmentService {
  /**
   * Enroll a user as a student for a studio
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string>} Created student document ID
   */
  async enrollStudent(studioOwnerId, authUid) {
    const db = getFirestore();

    // Check if already enrolled
    const isEnrolled = await this.checkEnrollmentStatus(studioOwnerId, authUid);
    if (isEnrolled) {
      throw new Error("User is already enrolled as a student for this studio");
    }

    // Get user profile from usersStudentProfiles
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) {
      throw new Error("Student profile not found. Please complete your profile first.");
    }

    const studentProfileData = studentProfileDoc.data();

    // Create student document in students collection
    const studentData = {
      firstName: studentProfileData.firstName || "",
      lastName: studentProfileData.lastName || "",
      email: studentProfileData.email || null,
      phone: studentProfileData.phone || null,
      authUid: authUid,
      credits: 0,
    };

    const studentId = await studentsService.createStudent(studentData, studioOwnerId);

    // Add studioOwnerId to user's studioIds array
    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const userProfileDoc = await userProfileRef.get();
    const currentData = userProfileDoc.data();
    const studioIds = currentData.studioIds || [];

    if (!studioIds.includes(studioOwnerId)) {
      await userProfileRef.update({
        studioIds: admin.firestore.FieldValue.arrayUnion(studioOwnerId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return studentId;
  }

  /**
   * Unenroll a user from a studio
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<void>}
   */
  async unenrollStudent(studioOwnerId, authUid) {
    const db = getFirestore();

    // Find student document by authUid and studioOwnerId
    const studentsRef = db.collection("students");
    const snapshot = await studentsRef
        .where("authUid", "==", authUid)
        .where("studioOwnerId", "==", studioOwnerId)
        .limit(1)
        .get();

    if (snapshot.empty) {
      throw new Error("Student enrollment not found");
    }

    const studentDoc = snapshot.docs[0];
    const studentId = studentDoc.id;

    // Delete student document
    await studentsRef.doc(studentId).delete();

    // Remove studioOwnerId from user's studioIds array
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (studentProfileDoc) {
      const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
      await userProfileRef.update({
        studioIds: admin.firestore.FieldValue.arrayRemove(studioOwnerId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  /**
   * Check if a user is enrolled as a student for a studio
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<boolean>} True if enrolled, false otherwise
   */
  async checkEnrollmentStatus(studioOwnerId, authUid) {
    const db = getFirestore();
    const studentsRef = db.collection("students");
    const snapshot = await studentsRef
        .where("authUid", "==", authUid)
        .where("studioOwnerId", "==", studioOwnerId)
        .limit(1)
        .get();

    return !snapshot.empty;
  }
}

module.exports = new StudioEnrollmentService();

