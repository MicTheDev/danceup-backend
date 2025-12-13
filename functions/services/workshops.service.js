const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling workshop management operations
 */
class WorkshopsService {
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
   * Get all workshops for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of workshops
   */
  async getWorkshops(studioOwnerId) {
    const db = getFirestore();
    const workshopsRef = db.collection("workshops");
    const snapshot = await workshopsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const workshops = [];
    snapshot.forEach((doc) => {
      workshops.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return workshops;
  }

  /**
   * Get a single workshop by ID
   * @param {string} workshopId - Workshop document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object | null>} Workshop data or null if not found
   */
  async getWorkshopById(workshopId, studioOwnerId) {
    const db = getFirestore();
    const workshopRef = db.collection("workshops").doc(workshopId);
    const doc = await workshopRef.get();

    if (!doc.exists) {
      return null;
    }

    const workshopData = doc.data();
    if (workshopData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Workshop does not belong to this studio owner");
    }

    return {
      id: doc.id,
      ...workshopData,
    };
  }

  /**
   * Create a new workshop
   * @param {Object} workshopData - Workshop data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created workshop document ID
   */
  async createWorkshop(workshopData, studioOwnerId) {
    const db = getFirestore();
    const workshopDataWithMetadata = {
      ...workshopData,
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("workshops").add(workshopDataWithMetadata);
    return docRef.id;
  }

  /**
   * Update an existing workshop
   * @param {string} workshopId - Workshop document ID
   * @param {Object} workshopData - Updated workshop data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateWorkshop(workshopId, workshopData, studioOwnerId) {
    const db = getFirestore();
    const workshopRef = db.collection("workshops").doc(workshopId);
    const doc = await workshopRef.get();

    if (!doc.exists) {
      throw new Error("Workshop not found");
    }

    const existingData = doc.data();
    if (existingData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Workshop does not belong to this studio owner");
    }

    const updateData = {
      ...workshopData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await workshopRef.update(updateData);
  }

  /**
   * Delete a workshop
   * @param {string} workshopId - Workshop document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteWorkshop(workshopId, studioOwnerId) {
    const db = getFirestore();
    const workshopRef = db.collection("workshops").doc(workshopId);
    const doc = await workshopRef.get();

    if (!doc.exists) {
      throw new Error("Workshop not found");
    }

    const workshopData = doc.data();
    if (workshopData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Workshop does not belong to this studio owner");
    }

    await workshopRef.delete();
  }
}

module.exports = new WorkshopsService();





