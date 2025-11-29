const admin = require("firebase-admin");
const {getFirestore} = require("firebase-admin/firestore");
const authService = require("./auth.service");

// Get database name based on project
function getDatabaseName() {
  const project = process.env.GCLOUD_PROJECT || 
                 (process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId : null);
  
  if (project === 'dev-danceup') {
    return 'development';
  } else if (project === 'staging-danceup') {
    return 'staging';
  } else if (project === 'production-danceup') {
    return 'production';
  }
  
  // Default fallback
  return '(default)';
}

// Lazy-load Firestore instance to ensure Firebase Admin is initialized first
function getDb() {
  // Ensure admin is initialized (should already be done in index.js)
  if (!admin.apps.length) {
    throw new Error("Firebase Admin not initialized. This should be initialized in index.js first.");
  }
  return getFirestore(admin.app(), getDatabaseName());
}

/**
 * Service for instructors operations using Firebase Admin SDK
 */
class InstructorsService {
  /**
   * Get studio owner ID from auth UID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string|null>} Studio owner document ID
   */
  async getStudioOwnerId(authUid) {
    try {
      const userDoc = await authService.getUserDocumentByAuthUid(authUid);
      if (!userDoc || !userDoc.exists) {
        return null;
      }
      
      // Verify user has studio_owner role
      if (!authService.hasStudioOwnerRole(userDoc)) {
        return null;
      }
      
      return userDoc.id;
    } catch (error) {
      console.error("Error getting studio owner ID:", error);
      throw new Error("Failed to retrieve studio owner information");
    }
  }

  /**
   * Get all instructors for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of instructor documents
   */
  async getInstructors(studioOwnerId) {
    try {
      const db = getDb();
      const instructorsRef = db.collection("instructors");
      const snapshot = await instructorsRef
          .where("studioOwnerId", "==", studioOwnerId)
          .get();

      if (snapshot.empty) {
        return [];
      }

      return snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
    } catch (error) {
      console.error("Error getting instructors:", error);
      throw new Error("Failed to retrieve instructors");
    }
  }

  /**
   * Get a single instructor by ID with ownership validation
   * @param {string} instructorId - Instructor document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object|null>} Instructor document or null if not found
   */
  async getInstructorById(instructorId, studioOwnerId) {
    try {
      const db = getDb();
      const instructorRef = db.collection("instructors").doc(instructorId);
      const instructorDoc = await instructorRef.get();

      if (!instructorDoc.exists) {
        return null;
      }

      const instructorData = instructorDoc.data();
      
      // Verify ownership
      if (instructorData.studioOwnerId !== studioOwnerId) {
        throw new Error("Access denied: You do not have permission to access this instructor");
      }

      return {
        id: instructorDoc.id,
        ...instructorData,
      };
    } catch (error) {
      if (error.message.includes("Access denied")) {
        throw error;
      }
      console.error("Error getting instructor:", error);
      throw new Error("Failed to retrieve instructor");
    }
  }

  /**
   * Create a new instructor
   * @param {Object} payload - Instructor data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created instructor document ID
   */
  async createInstructor(payload, studioOwnerId) {
    try {
      const db = getDb();
      const instructorsRef = db.collection("instructors");
      
      // Prepare instructor data
      const instructorData = {
        firstName: payload.firstName.trim(),
        lastName: payload.lastName.trim(),
        studioOwnerId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Add optional fields if provided
      if (payload.email !== undefined && payload.email !== null && payload.email.trim() !== "") {
        instructorData.email = payload.email.trim();
      }
      if (payload.phone !== undefined && payload.phone !== null && payload.phone.trim() !== "") {
        instructorData.phone = payload.phone.trim();
      }
      if (payload.bio !== undefined && payload.bio !== null && payload.bio.trim() !== "") {
        instructorData.bio = payload.bio.trim();
      }
      if (payload.photoUrl !== undefined && payload.photoUrl !== null) {
        instructorData.photoUrl = payload.photoUrl;
      }

      const docRef = await instructorsRef.add(instructorData);
      return docRef.id;
    } catch (error) {
      console.error("Error creating instructor:", error);
      throw new Error("Failed to create instructor");
    }
  }

  /**
   * Update an existing instructor with ownership validation
   * @param {string} instructorId - Instructor document ID
   * @param {Object} payload - Instructor update data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateInstructor(instructorId, payload, studioOwnerId) {
    try {
      const db = getDb();
      const instructorRef = db.collection("instructors").doc(instructorId);
      const instructorDoc = await instructorRef.get();

      if (!instructorDoc.exists) {
        throw new Error("Instructor not found");
      }

      const instructorData = instructorDoc.data();
      
      // Verify ownership
      if (instructorData.studioOwnerId !== studioOwnerId) {
        throw new Error("Access denied: You do not have permission to update this instructor");
      }

      // Build update data
      const updateData = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Only include fields that are explicitly provided
      if (payload.firstName !== undefined) {
        updateData.firstName = payload.firstName.trim();
      }
      if (payload.lastName !== undefined) {
        updateData.lastName = payload.lastName.trim();
      }
      if (payload.email !== undefined) {
        updateData.email = payload.email ? payload.email.trim() : null;
      }
      if (payload.phone !== undefined) {
        updateData.phone = payload.phone ? payload.phone.trim() : null;
      }
      if (payload.bio !== undefined) {
        updateData.bio = payload.bio ? payload.bio.trim() : null;
      }
      if (payload.photoUrl !== undefined) {
        updateData.photoUrl = payload.photoUrl || null;
      }

      await instructorRef.update(updateData);
    } catch (error) {
      if (error.message.includes("Access denied") || error.message.includes("not found")) {
        throw error;
      }
      console.error("Error updating instructor:", error);
      throw new Error("Failed to update instructor");
    }
  }

  /**
   * Delete an instructor with ownership validation
   * @param {string} instructorId - Instructor document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteInstructor(instructorId, studioOwnerId) {
    try {
      const db = getDb();
      const instructorRef = db.collection("instructors").doc(instructorId);
      const instructorDoc = await instructorRef.get();

      if (!instructorDoc.exists) {
        throw new Error("Instructor not found");
      }

      const instructorData = instructorDoc.data();
      
      // Verify ownership
      if (instructorData.studioOwnerId !== studioOwnerId) {
        throw new Error("Access denied: You do not have permission to delete this instructor");
      }

      await instructorRef.delete();
    } catch (error) {
      if (error.message.includes("Access denied") || error.message.includes("not found")) {
        throw error;
      }
      console.error("Error deleting instructor:", error);
      throw new Error("Failed to delete instructor");
    }
  }
}

module.exports = new InstructorsService();

