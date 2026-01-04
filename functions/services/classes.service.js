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
   * Get studio placeholder image URL
   * @returns {string} Placeholder image data URI
   */
  getStudioPlaceholderImage() {
    return "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiM2MzY2ZjEiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNlYzQ4OTkiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2EpIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIyNCIgZmlsbD0id2hpdGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5TdHVkaW88L3RleHQ+PC9zdmc+";
  }

  /**
   * Create a new class
   * @param {Object} classData - Class data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created class document ID
   */
  async createClass(classData, studioOwnerId) {
    const db = getFirestore();
    
    // Get studio owner document to retrieve studioImageUrl
    const studioOwnerRef = db.collection("users").doc(studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();
    
    let imageUrl = this.getStudioPlaceholderImage(); // Default to placeholder
    
    if (studioOwnerDoc.exists) {
      const studioOwnerData = studioOwnerDoc.data();
      // Use studio's image if available, otherwise use placeholder
      imageUrl = studioOwnerData.studioImageUrl || this.getStudioPlaceholderImage();
    }
    
    const classDataWithMetadata = {
      ...classData,
      studioOwnerId,
      imageUrl, // Add the studio's image or placeholder
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

  /**
   * Get all public classes with optional filters
   * @param {Object} filters - Filter options
   * @param {string|null} filters.danceGenre - Dance genre filter
   * @param {string|null} filters.city - City filter
   * @param {string|null} filters.state - State filter
   * @param {string|null} filters.studioName - Studio name filter (partial match)
   * @param {number|null} filters.minPrice - Minimum price filter
   * @param {number|null} filters.maxPrice - Maximum price filter
   * @param {string|null} filters.level - Skill level filter
   * @returns {Promise<Array>} Array of classes with studio information
   */
  async getAllPublicClasses(filters = {}) {
    const db = getFirestore();
    const classesRef = db.collection("classes");
    
    // Start with query for active classes only
    let query = classesRef.where("isActive", "==", true);
    
    // Apply filters that can be done at query level
    if (filters.level && filters.level !== "All") {
      query = query.where("level", "==", filters.level);
    }
    
    if (filters.minPrice !== null && filters.minPrice !== undefined) {
      query = query.where("cost", ">=", filters.minPrice);
    }
    
    if (filters.maxPrice !== null && filters.maxPrice !== undefined) {
      query = query.where("cost", "<=", filters.maxPrice);
    }

    // Get all classes matching the query
    const snapshot = await query.get();
    
    // Get all studio owner IDs from classes
    const studioOwnerIds = new Set();
    const classesMap = new Map();
    
    snapshot.forEach((doc) => {
      const classData = doc.data();
      studioOwnerIds.add(classData.studioOwnerId);
      classesMap.set(doc.id, {
        id: doc.id,
        ...classData,
      });
    });

    // Fetch all studio owner documents
    // Note: Firestore 'in' query has a limit of 10 items, so we batch if needed
    const studioOwnersMap = new Map();
    if (studioOwnerIds.size > 0) {
      const studioOwnersRef = db.collection("users");
      const studioOwnerIdsArray = Array.from(studioOwnerIds);
      
      // Batch queries if more than 10 studio owners (Firestore 'in' limit)
      const batchSize = 10;
      for (let i = 0; i < studioOwnerIdsArray.length; i += batchSize) {
        const batch = studioOwnerIdsArray.slice(i, i + batchSize);
        const studioOwnersSnapshot = await studioOwnersRef
            .where(admin.firestore.FieldPath.documentId(), "in", batch)
            .get();

        studioOwnersSnapshot.forEach((doc) => {
          studioOwnersMap.set(doc.id, doc.data());
        });
      }
    }

    // Enrich classes with studio information and apply remaining filters
    const enrichedClasses = [];
    
    for (const [classId, classData] of classesMap.entries()) {
      const studioOwner = studioOwnersMap.get(classData.studioOwnerId);
      
      if (!studioOwner) {
        continue; // Skip classes without studio owner data
      }

      // Apply filters that require studio owner data
      if (filters.city && studioOwner.city) {
        const studioCity = studioOwner.city.toLowerCase().trim();
        const filterCity = filters.city.toLowerCase().trim();
        if (!studioCity.includes(filterCity) && !filterCity.includes(studioCity)) {
          continue;
        }
      }

      if (filters.state && studioOwner.state) {
        if (studioOwner.state.toUpperCase() !== filters.state.toUpperCase()) {
          continue;
        }
      }

      if (filters.studioName && studioOwner.studioName) {
        const studioName = studioOwner.studioName.toLowerCase().trim();
        const filterName = filters.studioName.toLowerCase().trim();
        if (!studioName.includes(filterName)) {
          continue;
        }
      }

      // Note: danceGenre filter - classes may not have this field yet
      // For now, we'll skip this filter or add it to classes if needed
      // If danceGenre is on studio owner, we could filter by that
      
      // Build enriched class object
      const enrichedClass = {
        ...classData,
        studio: {
          id: classData.studioOwnerId,
          name: studioOwner.studioName || "",
          city: studioOwner.city || "",
          state: studioOwner.state || "",
          addressLine1: studioOwner.studioAddressLine1 || "",
          addressLine2: studioOwner.studioAddressLine2 || null,
          zip: studioOwner.zip || "",
        },
      };

      enrichedClasses.push(enrichedClass);
    }

    // Apply danceGenre filter if specified (assuming it might be on studio or class)
    let filteredClasses = enrichedClasses;
    if (filters.danceGenre && filters.danceGenre !== "All") {
      // For now, we'll check if classes have danceGenre field
      // If not, we might need to add it or filter by studio's primary genre
      filteredClasses = enrichedClasses.filter((cls) => {
        // Check if class has danceGenre field
        if (cls.danceGenre) {
          return cls.danceGenre.toLowerCase() === filters.danceGenre.toLowerCase();
        }
        // If not on class, we could check studio's genre if available
        return false;
      });
    }

    return filteredClasses;
  }

  /**
   * Get a single public class by ID with studio and instructor details
   * @param {string} classId - Class document ID
   * @returns {Promise<Object | null>} Class data with studio and instructor info or null if not found
   */
  async getPublicClassById(classId) {
    const db = getFirestore();
    const classRef = db.collection("classes").doc(classId);
    const doc = await classRef.get();

    if (!doc.exists) {
      return null;
    }

    const classData = doc.data();
    
    // Only return active classes
    if (!classData.isActive) {
      return null;
    }

    // Get studio owner document
    const studioOwnerRef = db.collection("users").doc(classData.studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();
    
    if (!studioOwnerDoc.exists) {
      return null;
    }

    const studioOwnerData = studioOwnerDoc.data();

    // Get instructor documents if instructorIds exist
    const instructors = [];
    if (classData.instructorIds && Array.isArray(classData.instructorIds) && classData.instructorIds.length > 0) {
      // Batch instructor queries (Firestore 'in' limit is 10)
      const batchSize = 10;
      for (let i = 0; i < classData.instructorIds.length; i += batchSize) {
        const batch = classData.instructorIds.slice(i, i + batchSize);
        const instructorsSnapshot = await db.collection("instructors")
            .where(admin.firestore.FieldPath.documentId(), "in", batch)
            .get();

        instructorsSnapshot.forEach((instructorDoc) => {
          instructors.push({
            id: instructorDoc.id,
            ...instructorDoc.data(),
          });
        });
      }
    }

    return {
      id: doc.id,
      ...classData,
      studio: {
        id: classData.studioOwnerId,
        name: studioOwnerData.studioName || "",
        city: studioOwnerData.city || "",
        state: studioOwnerData.state || "",
        addressLine1: studioOwnerData.studioAddressLine1 || "",
        addressLine2: studioOwnerData.studioAddressLine2 || null,
        zip: studioOwnerData.zip || "",
      },
      instructors,
    };
  }

  /**
   * Get related classes from the same studio (excluding current class)
   * @param {string} classId - Current class document ID to exclude
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {number} limit - Maximum number of classes to return (default 4)
   * @returns {Promise<Array>} Array of related classes with studio info
   */
  async getRelatedClasses(classId, studioOwnerId, limit = 4) {
    const db = getFirestore();
    const classesRef = db.collection("classes");
    
    // Get other active classes from the same studio (excluding current class)
    const snapshot = await classesRef
        .where("studioOwnerId", "==", studioOwnerId)
        .where("isActive", "==", true)
        .limit(limit + 1) // Get one extra to account for excluding current class
        .get();

    const classes = [];
    snapshot.forEach((doc) => {
      // Exclude the current class
      if (doc.id !== classId) {
        classes.push({
          id: doc.id,
          ...doc.data(),
        });
      }
    });

    // Limit to requested number
    const limitedClasses = classes.slice(0, limit);

    // Get studio owner document for enrichment
    const studioOwnerRef = db.collection("users").doc(studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();
    
    if (!studioOwnerDoc.exists) {
      return limitedClasses.map((cls) => ({
        ...cls,
        studio: {
          id: studioOwnerId,
          name: "",
          city: "",
          state: "",
          addressLine1: "",
          addressLine2: null,
          zip: "",
        },
      }));
    }

    const studioOwnerData = studioOwnerDoc.data();

    // Enrich classes with studio information
    return limitedClasses.map((cls) => ({
      ...cls,
      studio: {
        id: studioOwnerId,
        name: studioOwnerData.studioName || "",
        city: studioOwnerData.city || "",
        state: studioOwnerData.state || "",
        addressLine1: studioOwnerData.studioAddressLine1 || "",
        addressLine2: studioOwnerData.studioAddressLine2 || null,
        zip: studioOwnerData.zip || "",
      },
    }));
  }
}

module.exports = new ClassesService();
