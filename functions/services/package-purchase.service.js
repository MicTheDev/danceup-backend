const admin = require("firebase-admin");
const authService = require("./auth.service");
const packagesService = require("./packages.service");
const studentsService = require("./students.service");
const studioEnrollmentService = require("./studio-enrollment.service");
const creditTrackingService = require("./credit-tracking.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling package purchase operations
 */
class PackagePurchaseService {
  /**
   * Purchase a package for an authenticated user
   * @param {string} packageId - Package document ID
   * @param {string} authUid - Firebase Auth UID of the purchasing user
   * @param {string} studioOwnerId - Studio owner document ID (package owner)
   * @returns {Promise<Object>} Updated credit balance and purchase details
   */
  async purchasePackageForUser(packageId, authUid, studioOwnerId) {
    const db = getFirestore();

    // Validate package exists and belongs to studio
    const packageData = await packagesService.getPackageById(packageId, studioOwnerId);
    if (!packageData) {
      throw new Error("Package not found or does not belong to this studio");
    }

    if (!packageData.isActive) {
      throw new Error("Package is not active");
    }

    // Get user profile
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) {
      throw new Error("Student profile not found");
    }

    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const userProfileData = (await userProfileRef.get()).data();

    // Ensure studios structure exists (backward compatibility)
    const studios = studioEnrollmentService.ensureStudiosStructure(userProfileData);
    
    // Ensure user is enrolled in this studio
    if (!studios[studioOwnerId]) {
      throw new Error("User is not enrolled in this studio");
    }

    // Find student document
    const studentsRef = db.collection("students");
    const studentSnapshot = await studentsRef
        .where("authUid", "==", authUid)
        .where("studioOwnerId", "==", studioOwnerId)
        .limit(1)
        .get();

    if (studentSnapshot.empty) {
      throw new Error("Student record not found for this studio");
    }

    const studentDoc = studentSnapshot.docs[0];
    const studentId = studentDoc.id;

    // Get expiration days from package (default to 365 if not set)
    const expirationDays = packageData.expirationDays || 365;
    const creditsToAdd = packageData.credits || 0;

    // Add credits using credit tracking service
    await creditTrackingService.addCredits(
        studentId,
        studioOwnerId,
        creditsToAdd,
        expirationDays,
        packageId
    );

    // Get updated credit balance
    const newCreditBalance = await creditTrackingService.getAvailableCredits(studentId, studioOwnerId);

    return {
      packageId: packageId,
      packageName: packageData.name,
      creditsAdded: creditsToAdd,
      newCreditBalance: newCreditBalance,
      studioOwnerId: studioOwnerId,
    };
  }

  /**
   * Purchase a package for a student (by studio owner)
   * @param {string} packageId - Package document ID
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object>} Updated credit balance and purchase details
   */
  async purchasePackageForStudent(packageId, studentId, studioOwnerId) {
    const db = getFirestore();

    // Validate package exists and belongs to studio
    const packageData = await packagesService.getPackageById(packageId, studioOwnerId);
    if (!packageData) {
      throw new Error("Package not found or does not belong to this studio");
    }

    if (!packageData.isActive) {
      throw new Error("Package is not active");
    }

    // Get student document
    const studentDoc = await studentsService.getStudentById(studentId, studioOwnerId);
    if (!studentDoc) {
      throw new Error("Student not found");
    }

    const authUid = studentDoc.authUid;
    if (!authUid) {
      throw new Error("Student record does not have an associated auth UID");
    }

    // Get user profile
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) {
      throw new Error("Student profile not found");
    }

    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const userProfileData = (await userProfileRef.get()).data();

    // Ensure studios structure exists (backward compatibility)
    const studios = studioEnrollmentService.ensureStudiosStructure(userProfileData);
    
    // Ensure user is enrolled in this studio
    if (!studios[studioOwnerId]) {
      studios[studioOwnerId] = { credits: 0 };
    }

    // Get expiration days from package (default to 365 if not set)
    const expirationDays = packageData.expirationDays || 365;
    const creditsToAdd = packageData.credits || 0;

    // Add credits using credit tracking service
    await creditTrackingService.addCredits(
        studentId,
        studioOwnerId,
        creditsToAdd,
        expirationDays,
        packageId
    );

    // Get updated credit balance
    const newCreditBalance = await creditTrackingService.getAvailableCredits(studentId, studioOwnerId);

    return {
      packageId: packageId,
      packageName: packageData.name,
      creditsAdded: creditsToAdd,
      newCreditBalance: newCreditBalance,
      studentId: studentId,
      studioOwnerId: studioOwnerId,
    };
  }
}

module.exports = new PackagePurchaseService();

