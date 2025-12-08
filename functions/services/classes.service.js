const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling class management operations
 */
class ClassesService {
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
   * Get all classes for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of classes
   */
  async getClasses(studioOwnerId) {
    const db = getFirestore();
    const classesRef = db.collection("classes");
    const snapshot = await classesRef
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const classes = [];
    snapshot.forEach((doc) => {
      classes.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return classes;
  }

  /**
   * Get a single class by ID
   * @param {string} classId - Class document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object | null>} Class data or null if not found
   */
  async getClassById(classId, studioOwnerId) {
    const db = getFirestore();
    const classRef = db.collection("classes").doc(classId);
    const doc = await classRef.get();

    if (!doc.exists) {
      return null;
    }

    const classData = doc.data();
    if (classData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Class does not belong to this studio owner");
    }

    return {
      id: doc.id,
      ...classData,
    };
  }

  /**
   * Create a new class
   * @param {Object} classData - Class data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created class document ID
   */
  async createClass(classData, studioOwnerId) {
    const db = getFirestore();
    const classDataWithMetadata = {
      ...classData,
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("classes").add(classDataWithMetadata);
    return docRef.id;
  }

  /**
   * Update an existing class
   * @param {string} classId - Class document ID
   * @param {Object} classData - Updated class data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateClass(classId, classData, studioOwnerId) {
    const db = getFirestore();
    const classRef = db.collection("classes").doc(classId);
    const doc = await classRef.get();

    if (!doc.exists) {
      throw new Error("Class not found");
    }

    const existingData = doc.data();
    if (existingData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Class does not belong to this studio owner");
    }

    const updateData = {
      ...classData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await classRef.update(updateData);
  }

  /**
   * Delete a class
   * @param {string} classId - Class document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteClass(classId, studioOwnerId) {
    const db = getFirestore();
    const classRef = db.collection("classes").doc(classId);
    const doc = await classRef.get();

    if (!doc.exists) {
      throw new Error("Class not found");
    }

    const classData = doc.data();
    if (classData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Class does not belong to this studio owner");
    }

    await classRef.delete();
  }
}

module.exports = new ClassesService();
