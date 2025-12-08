const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling package management operations
 */
class PackagesService {
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
   * Get all packages for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of packages
   */
  async getPackages(studioOwnerId) {
    const db = getFirestore();
    const packagesRef = db.collection("packages");
    const snapshot = await packagesRef
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const packages = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      packages.push({
        id: doc.id,
        ...data,
        // Ensure classIds is always an array
        classIds: Array.isArray(data.classIds) ? data.classIds : [],
      });
    });

    return packages;
  }

  /**
   * Get a single package by ID
   * @param {string} packageId - Package document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object | null>} Package data or null if not found
   */
  async getPackageById(packageId, studioOwnerId) {
    const db = getFirestore();
    const packageRef = db.collection("packages").doc(packageId);
    const doc = await packageRef.get();

    if (!doc.exists) {
      return null;
    }

    const packageData = doc.data();
    if (packageData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Package does not belong to this studio owner");
    }

    return {
      id: doc.id,
      ...packageData,
      // Ensure classIds is always an array
      classIds: Array.isArray(packageData.classIds) ? packageData.classIds : [],
    };
  }

  /**
   * Create a new package
   * @param {Object} packageData - Package data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created package document ID
   */
  async createPackage(packageData, studioOwnerId) {
    const db = getFirestore();
    const packageDataWithMetadata = {
      ...packageData,
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("packages").add(packageDataWithMetadata);
    return docRef.id;
  }

  /**
   * Update an existing package
   * @param {string} packageId - Package document ID
   * @param {Object} packageData - Updated package data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updatePackage(packageId, packageData, studioOwnerId) {
    const db = getFirestore();
    const packageRef = db.collection("packages").doc(packageId);
    const doc = await packageRef.get();

    if (!doc.exists) {
      throw new Error("Package not found");
    }

    const existingData = doc.data();
    if (existingData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Package does not belong to this studio owner");
    }

    const updateData = {
      ...packageData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await packageRef.update(updateData);
  }

  /**
   * Delete a package
   * @param {string} packageId - Package document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deletePackage(packageId, studioOwnerId) {
    const db = getFirestore();
    const packageRef = db.collection("packages").doc(packageId);
    const doc = await packageRef.get();

    if (!doc.exists) {
      throw new Error("Package not found");
    }

    const packageData = doc.data();
    if (packageData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Package does not belong to this studio owner");
    }

    await packageRef.delete();
  }
}

module.exports = new PackagesService();

