const admin = require("firebase-admin");
const {getFirestore} = require("firebase-admin/firestore");
const authService = require("./auth.service");

// Get database name based on project
function getDatabaseName() {
  // Ensure admin is initialized
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  
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

// Initialize Firestore with the correct database name
const db = getFirestore(admin.app(), getDatabaseName());

/**
 * Service for classes operations using Firebase Admin SDK
 */
class ClassesService {
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
   * Get all classes for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of class documents
   */
  async getClasses(studioOwnerId) {
    try {
      const classesRef = db.collection("classes");
      const snapshot = await classesRef
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
      console.error("Error getting classes:", error);
      throw new Error("Failed to retrieve classes");
    }
  }

  /**
   * Get a single class by ID with ownership validation
   * @param {string} classId - Class document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object|null>} Class document or null if not found
   */
  async getClassById(classId, studioOwnerId) {
    try {
      const classRef = db.collection("classes").doc(classId);
      const classDoc = await classRef.get();

      if (!classDoc.exists) {
        return null;
      }

      const classData = classDoc.data();
      
      // Verify ownership
      if (classData.studioOwnerId !== studioOwnerId) {
        throw new Error("Access denied: You do not have permission to access this class");
      }

      return {
        id: classDoc.id,
        ...classData,
      };
    } catch (error) {
      if (error.message.includes("Access denied")) {
        throw error;
      }
      console.error("Error getting class:", error);
      throw new Error("Failed to retrieve class");
    }
  }

  /**
   * Create a new class
   * @param {Object} payload - Class data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created class document ID
   */
  async createClass(payload, studioOwnerId) {
    try {
      const classesRef = db.collection("classes");
      
      // Prepare class data
      const classData = {
        name: payload.name.trim(),
        level: payload.level,
        cost: payload.cost,
        dayOfWeek: payload.dayOfWeek,
        startTime: payload.startTime,
        endTime: payload.endTime,
        instructorIds: payload.instructorIds || [],
        isActive: payload.isActive !== undefined ? payload.isActive : true,
        studioOwnerId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Add optional fields if provided
      if (payload.description !== undefined && payload.description !== null) {
        classData.description = payload.description.trim();
      }
      if (payload.room !== undefined && payload.room !== null) {
        classData.room = payload.room.trim();
      }

      const docRef = await classesRef.add(classData);
      return docRef.id;
    } catch (error) {
      console.error("Error creating class:", error);
      throw new Error("Failed to create class");
    }
  }

  /**
   * Update an existing class with ownership validation
   * @param {string} classId - Class document ID
   * @param {Object} payload - Class update data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateClass(classId, payload, studioOwnerId) {
    try {
      const classRef = db.collection("classes").doc(classId);
      const classDoc = await classRef.get();

      if (!classDoc.exists) {
        throw new Error("Class not found");
      }

      const classData = classDoc.data();
      
      // Verify ownership
      if (classData.studioOwnerId !== studioOwnerId) {
        throw new Error("Access denied: You do not have permission to update this class");
      }

      // Build update data
      const updateData = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Only include fields that are explicitly provided
      if (payload.name !== undefined) {
        updateData.name = payload.name.trim();
      }
      if (payload.level !== undefined) {
        updateData.level = payload.level;
      }
      if (payload.cost !== undefined) {
        updateData.cost = payload.cost;
      }
      if (payload.dayOfWeek !== undefined) {
        updateData.dayOfWeek = payload.dayOfWeek;
      }
      if (payload.startTime !== undefined) {
        updateData.startTime = payload.startTime;
      }
      if (payload.endTime !== undefined) {
        updateData.endTime = payload.endTime;
      }
      if (payload.instructorIds !== undefined) {
        updateData.instructorIds = payload.instructorIds;
      }
      if (payload.isActive !== undefined) {
        updateData.isActive = payload.isActive;
      }
      if (payload.description !== undefined) {
        updateData.description = payload.description ? payload.description.trim() : null;
      }
      if (payload.room !== undefined) {
        updateData.room = payload.room ? payload.room.trim() : null;
      }

      await classRef.update(updateData);
    } catch (error) {
      if (error.message.includes("Access denied") || error.message.includes("not found")) {
        throw error;
      }
      console.error("Error updating class:", error);
      throw new Error("Failed to update class");
    }
  }

  /**
   * Delete a class with ownership validation
   * @param {string} classId - Class document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteClass(classId, studioOwnerId) {
    try {
      const classRef = db.collection("classes").doc(classId);
      const classDoc = await classRef.get();

      if (!classDoc.exists) {
        throw new Error("Class not found");
      }

      const classData = classDoc.data();
      
      // Verify ownership
      if (classData.studioOwnerId !== studioOwnerId) {
        throw new Error("Access denied: You do not have permission to delete this class");
      }

      await classRef.delete();
    } catch (error) {
      if (error.message.includes("Access denied") || error.message.includes("not found")) {
        throw error;
      }
      console.error("Error deleting class:", error);
      throw new Error("Failed to delete class");
    }
  }
}

module.exports = new ClassesService();

