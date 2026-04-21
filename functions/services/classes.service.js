const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");
const {geocodeAddress} = require("../utils/geocoding");
const {haversineDistance} = require("../utils/distance");

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
      const data = doc.data();
      classes.push({
        id: doc.id,
        ...data,
        maxCapacity: data.maxCapacity ?? 20,
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
      maxCapacity: classData.maxCapacity ?? 20,
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
    
    // If a custom imageUrl was already set (e.g. uploaded by the endpoint), keep it.
    // Otherwise fall back to the studio's own image, then to the placeholder.
    let imageUrl = classData.imageUrl;
    if (!imageUrl) {
      imageUrl = this.getStudioPlaceholderImage();
      if (studioOwnerDoc.exists) {
        const studioOwnerData = studioOwnerDoc.data();
        imageUrl = studioOwnerData.studioImageUrl || this.getStudioPlaceholderImage();
      }
    }
    
    // Geocode using the studio owner's address
    let coords = null;
    if (studioOwnerDoc.exists) {
      const studioOwnerData = studioOwnerDoc.data();
      if (studioOwnerData.studioAddressLine1 && studioOwnerData.city && studioOwnerData.state) {
        coords = await geocodeAddress(
            studioOwnerData.studioAddressLine1,
            studioOwnerData.city,
            studioOwnerData.state,
            studioOwnerData.zip || "",
        );
      }
    }

    const classDataWithMetadata = {
      ...classData,
      studioOwnerId,
      imageUrl,
      ...(coords ? {lat: coords.lat, lng: coords.lng} : {}),
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

    // Re-geocode using studio owner's address if address may have changed
    let coords = null;
    const studioOwnerRef = db.collection("users").doc(existingData.studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();
    if (studioOwnerDoc.exists) {
      const studioOwnerData = studioOwnerDoc.data();
      if (studioOwnerData.studioAddressLine1 && studioOwnerData.city && studioOwnerData.state) {
        coords = await geocodeAddress(
            studioOwnerData.studioAddressLine1,
            studioOwnerData.city,
            studioOwnerData.state,
            studioOwnerData.zip || "",
        );
      }
    }

    const updateData = {
      ...classData,
      ...(coords ? {lat: coords.lat, lng: coords.lng} : {}),
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

    // Apply radius filter if lat/lng provided
    if (filters.lat != null && filters.lng != null) {
      const radius = filters.radius != null ? filters.radius : 25;
      const withDistance = filteredClasses
          .filter((c) => c.lat != null && c.lng != null)
          .map((c) => ({
            ...c,
            distanceMiles: haversineDistance(filters.lat, filters.lng, c.lat, c.lng),
          }))
          .filter((c) => c.distanceMiles <= radius)
          .sort((a, b) => a.distanceMiles - b.distanceMiles);

      if (filters.limit != null) {
        return withDistance.slice(0, filters.limit);
      }
      return withDistance;
    }

    if (filters.limit != null) {
      return filteredClasses.slice(0, filters.limit);
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
      studioOwnerId: classData.studioOwnerId, // Ensure studioOwnerId is preserved
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
   * Get the number of enrolled (checked-in) students for a specific class instance
   * @param {string} classId - Class document ID
   * @param {string} classInstanceDate - ISO date string of the class instance
   * @returns {Promise<number>} Count of enrolled students
   */
  async getEnrolledCount(classId, classInstanceDate) {
    const db = getFirestore();
    const snapshot = await db.collection("attendance")
        .where("classId", "==", classId)
        .where("classInstanceDate", "==", classInstanceDate)
        .where("isRemoved", "==", false)
        .get();
    return snapshot.size;
  }

  /**
   * Check if a class instance is at or over capacity
   * @param {string} classId - Class document ID
   * @param {string} classInstanceDate - ISO date string of the class instance
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<boolean>} True if class is full
   */
  async isClassFull(classId, classInstanceDate, studioOwnerId) {
    const classData = await this.getClassById(classId, studioOwnerId);
    if (!classData) throw new Error("Class not found");
    const maxCapacity = classData.maxCapacity ?? 20;
    const enrolled = await this.getEnrolledCount(classId, classInstanceDate);
    return enrolled >= maxCapacity;
  }

  /**
   * Add a student to the waitlist for a class instance
   * @param {string} classId - Class document ID
   * @param {string} studentId - Student document ID
   * @param {string} classInstanceDate - ISO date string of the class instance
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created waitlist entry document ID
   */
  async addToWaitlist(classId, studentId, classInstanceDate, studioOwnerId) {
    const db = getFirestore();
    const existing = await db.collection("waitlists")
        .where("classId", "==", classId)
        .where("studentId", "==", studentId)
        .where("classInstanceDate", "==", classInstanceDate)
        .where("isActive", "==", true)
        .get();
    if (!existing.empty) {
      throw new Error("Student is already on the waitlist for this class instance");
    }
    const docRef = await db.collection("waitlists").add({
      classId,
      studentId,
      classInstanceDate,
      studioOwnerId,
      isActive: true,
      notificationSent: false,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  /**
   * Get the active waitlist for a class instance, ordered by time added (FIFO)
   * @param {string} classId - Class document ID
   * @param {string} classInstanceDate - ISO date string of the class instance
   * @returns {Promise<Array>} Ordered array of waitlist entries
   */
  async getWaitlist(classId, classInstanceDate) {
    const db = getFirestore();
    const snapshot = await db.collection("waitlists")
        .where("classId", "==", classId)
        .where("classInstanceDate", "==", classInstanceDate)
        .where("isActive", "==", true)
        .orderBy("addedAt", "asc")
        .get();
    return snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()}));
  }

  /**
   * Remove a student from the waitlist
   * @param {string} entryId - Waitlist entry document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async removeFromWaitlist(entryId, studioOwnerId) {
    const db = getFirestore();
    const doc = await db.collection("waitlists").doc(entryId).get();
    if (!doc.exists) throw new Error("Waitlist entry not found");
    if (doc.data().studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Waitlist entry does not belong to this studio owner");
    }
    await db.collection("waitlists").doc(entryId).update({isActive: false});
  }

  /**
   * Notify the first student on the waitlist that a spot has opened up.
   * Sends an email if the student has one, then marks the entry as notified.
   * @param {string} classId - Class document ID
   * @param {string} classInstanceDate - ISO date string of the class instance
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string|null>} Notified student ID, or null if waitlist is empty
   */
  async notifyFirstWaiting(classId, classInstanceDate, studioOwnerId) {
    const waitlist = await this.getWaitlist(classId, classInstanceDate);
    if (waitlist.length === 0) return null;

    const first = waitlist[0];
    const db = getFirestore();

    const [studentDoc, classDoc, studioDoc] = await Promise.all([
      db.collection("students").doc(first.studentId).get(),
      db.collection("classes").doc(classId).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    if (!studentDoc.exists) return null;
    const studentData = studentDoc.data();
    const className = classDoc.exists ? (classDoc.data().name || "your class") : "your class";
    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "the studio") : "the studio";

    if (studentData.email) {
      const sendgridService = require("./sendgrid.service");
      try {
        await sendgridService.sendWaitlistNotificationEmail(
            studentData.email,
            studentData.firstName || studentData.name || "there",
            className,
            studioName,
            classInstanceDate,
        );
      } catch (err) {
        console.error("[Waitlist] Failed to send notification email:", err.message);
      }
    }

    await db.collection("waitlists").doc(first.id).update({
      notificationSent: true,
      notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return first.studentId;
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
