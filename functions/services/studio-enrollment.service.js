const admin = require("firebase-admin");
const authService = require("./auth.service");
const studentsService = require("./students.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling studio enrollment operations
 */
class StudioEnrollmentService {
  /**
   * Convert studioIds array to studios object structure
   * @param {Array<string>} studioIds - Array of studio owner IDs
   * @returns {Object} Studios object with credits initialized to 0
   */
  convertStudioIdsToStudios(studioIds) {
    if (!Array.isArray(studioIds)) {
      return {};
    }
    const studios = {};
    studioIds.forEach((studioId) => {
      studios[studioId] = { credits: 0 };
    });
    return studios;
  }

  /**
   * Ensure user profile has studios object structure (backward compatibility)
   * @param {Object} userProfileData - User profile data
   * @returns {Object} Studios object
   */
  ensureStudiosStructure(userProfileData) {
    if (userProfileData.studios && typeof userProfileData.studios === 'object') {
      return userProfileData.studios;
    }
    // Backward compatibility: convert studioIds array to studios object
    if (Array.isArray(userProfileData.studioIds)) {
      return this.convertStudioIdsToStudios(userProfileData.studioIds);
    }
    return {};
  }

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

    // Update user profile with studios object structure
    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const userProfileDoc = await userProfileRef.get();
    const currentData = userProfileDoc.data();
    
    // Ensure studios object exists and convert from studioIds if needed
    const studios = this.ensureStudiosStructure(currentData);
    
    // Add new studio with 0 credits if not already present
    if (!studios[studioOwnerId]) {
      studios[studioOwnerId] = { credits: 0 };
      
      const updateData = {
        studios: studios,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      
      // If studioIds array exists, remove it (migration)
      if (Array.isArray(currentData.studioIds)) {
        updateData.studioIds = admin.firestore.FieldValue.delete();
      }
      
      await userProfileRef.update(updateData);
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

    // Remove studio from user's studios object
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (studentProfileDoc) {
      const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
      const currentData = (await userProfileRef.get()).data();
      
      const studios = this.ensureStudiosStructure(currentData);
      
      // Remove studio from studios object
      if (studios[studioOwnerId]) {
        delete studios[studioOwnerId];
        
        const updateData = {
          studios: studios,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        
        // Also remove from studioIds array if it exists (backward compatibility)
        if (Array.isArray(currentData.studioIds) && currentData.studioIds.includes(studioOwnerId)) {
          updateData.studioIds = admin.firestore.FieldValue.arrayRemove(studioOwnerId);
        }
        
        await userProfileRef.update(updateData);
      }
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

