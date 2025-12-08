const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling instructor management operations
 */
class InstructorsService {
  /**
   * Get studio owner ID from Firebase Auth UID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string | null>} Studio owner document ID
   */
  async getStudioOwnerId(authUid) {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) {
      return null;
    }
    return userDoc.id;
  }

  /**
   * Get all instructors for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of instructors
   */
  async getInstructors(studioOwnerId) {
    const db = getFirestore();
    const instructorsRef = db.collection("instructors");
    const snapshot = await instructorsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const instructors = [];
    snapshot.forEach((doc) => {
      instructors.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return instructors;
  }

  /**
   * Get a single instructor by ID
   * @param {string} instructorId - Instructor document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object | null>} Instructor data or null if not found
   */
  async getInstructorById(instructorId, studioOwnerId) {
    const db = getFirestore();
    const instructorRef = db.collection("instructors").doc(instructorId);
    const doc = await instructorRef.get();

    if (!doc.exists) {
      return null;
    }

    const instructorData = doc.data();
    if (instructorData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Instructor does not belong to this studio owner");
    }

    return {
      id: doc.id,
      ...instructorData,
    };
  }

  /**
   * Create a new instructor
   * @param {Object} instructorData - Instructor data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created instructor document ID
   */
  async createInstructor(instructorData, studioOwnerId) {
    const db = getFirestore();
    const instructorDataWithMetadata = {
      ...instructorData,
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("instructors").add(instructorDataWithMetadata);
    return docRef.id;
  }

  /**
   * Update an existing instructor
   * @param {string} instructorId - Instructor document ID
   * @param {Object} instructorData - Updated instructor data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateInstructor(instructorId, instructorData, studioOwnerId) {
    const db = getFirestore();
    const instructorRef = db.collection("instructors").doc(instructorId);
    const doc = await instructorRef.get();

    if (!doc.exists) {
      throw new Error("Instructor not found");
    }

    const existingData = doc.data();
    if (existingData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Instructor does not belong to this studio owner");
    }

    const updateData = {
      ...instructorData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await instructorRef.update(updateData);
  }

  /**
   * Delete an instructor
   * @param {string} instructorId - Instructor document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteInstructor(instructorId, studioOwnerId) {
    const db = getFirestore();
    const instructorRef = db.collection("instructors").doc(instructorId);
    const doc = await instructorRef.get();

    if (!doc.exists) {
      throw new Error("Instructor not found");
    }

    const instructorData = doc.data();
    if (instructorData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Instructor does not belong to this studio owner");
    }

    await instructorRef.delete();
  }
}

module.exports = new InstructorsService();
