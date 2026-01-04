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

  /**
   * Get all public workshops with optional filters
   * @param {Object} filters - Filter options
   * @param {string|null} filters.level - Workshop level filter (beginner, intermediate, advanced)
   * @param {string|null} filters.city - City filter
   * @param {string|null} filters.state - State filter
   * @param {string|null} filters.studioName - Studio name filter (partial match)
   * @param {number|null} filters.minPrice - Minimum price filter
   * @param {number|null} filters.maxPrice - Maximum price filter
   * @param {string|null} filters.startDate - Start date filter (ISO string)
   * @param {string|null} filters.endDate - End date filter (ISO string)
   * @returns {Promise<Array>} Array of workshops with studio information
   */
  async getAllPublicWorkshops(filters = {}) {
    const db = getFirestore();
    const workshopsRef = db.collection("workshops");
    
    let query = workshopsRef;
    
    // Note: Firestore doesn't support array-contains with OR, so we'll filter levels in code
    // Get all workshops matching the query
    const snapshot = await query.get();
    
    // Get all studio owner IDs from workshops
    const studioOwnerIds = new Set();
    const workshopsMap = new Map();
    
    snapshot.forEach((doc) => {
      const workshopData = doc.data();
      // Only add valid studioOwnerIds (filter out undefined/null)
      if (workshopData.studioOwnerId) {
        studioOwnerIds.add(workshopData.studioOwnerId);
        workshopsMap.set(doc.id, {
          id: doc.id,
          ...workshopData,
        });
      }
    });

    // Fetch all studio owner documents
    const studioOwnersMap = new Map();
    if (studioOwnerIds.size > 0) {
      const studioOwnersRef = db.collection("users");
      const studioOwnerIdsArray = Array.from(studioOwnerIds).filter(id => id != null);
      
      // Batch queries if more than 10 studio owners (Firestore 'in' limit)
      const batchSize = 10;
      for (let i = 0; i < studioOwnerIdsArray.length; i += batchSize) {
        const batch = studioOwnerIdsArray.slice(i, i + batchSize).filter(id => id != null);
        if (batch.length === 0) continue;
        const studioOwnersSnapshot = await studioOwnersRef
            .where(admin.firestore.FieldPath.documentId(), "in", batch)
            .get();

        studioOwnersSnapshot.forEach((doc) => {
          studioOwnersMap.set(doc.id, doc.data());
        });
      }
    }

    // Enrich workshops with studio information and apply remaining filters
    const enrichedWorkshops = [];
    
    for (const [workshopId, workshopData] of workshopsMap.entries()) {
      const studioOwner = studioOwnersMap.get(workshopData.studioOwnerId);
      
      if (!studioOwner) {
        continue; // Skip workshops without studio owner data
      }

      // Parse workshop dates
      const startTime = workshopData.startTime?.toDate ? workshopData.startTime.toDate() : new Date(workshopData.startTime);
      const endTime = workshopData.endTime?.toDate ? workshopData.endTime.toDate() : new Date(workshopData.endTime);

      // Apply date filters
      if (filters.startDate) {
        const filterStartDate = new Date(filters.startDate);
        if (endTime < filterStartDate) {
          continue;
        }
      }

      if (filters.endDate) {
        const filterEndDate = new Date(filters.endDate);
        if (startTime > filterEndDate) {
          continue;
        }
      }

      // Apply level filter (workshop levels is an array)
      if (filters.level && filters.level !== "All") {
        if (!workshopData.levels || !Array.isArray(workshopData.levels) || 
            !workshopData.levels.includes(filters.level.toLowerCase())) {
          continue;
        }
      }

      // Apply location filters
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

      // Apply price filters
      if (workshopData.priceTiers && Array.isArray(workshopData.priceTiers) && workshopData.priceTiers.length > 0) {
        const minPrice = Math.min(...workshopData.priceTiers.map(tier => tier.price || 0));
        const maxPrice = Math.max(...workshopData.priceTiers.map(tier => tier.price || 0));

        if (filters.minPrice !== null && filters.minPrice !== undefined) {
          if (maxPrice < filters.minPrice) {
            continue;
          }
        }

        if (filters.maxPrice !== null && filters.maxPrice !== undefined) {
          if (minPrice > filters.maxPrice) {
            continue;
          }
        }
      } else {
        // If no price tiers, skip if price filters are applied
        if (filters.minPrice !== null && filters.minPrice !== undefined || 
            filters.maxPrice !== null && filters.maxPrice !== undefined) {
          continue;
        }
      }
      
      // Build enriched workshop object
      const enrichedWorkshop = {
        ...workshopData,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        studio: {
          id: workshopData.studioOwnerId,
          name: studioOwner.studioName || "",
          city: studioOwner.city || "",
          state: studioOwner.state || "",
          addressLine1: studioOwner.studioAddressLine1 || "",
          addressLine2: studioOwner.studioAddressLine2 || null,
          zip: studioOwner.zip || "",
        },
      };

      enrichedWorkshops.push(enrichedWorkshop);
    }

    return enrichedWorkshops;
  }

  /**
   * Get a single public workshop by ID with studio details
   * @param {string} workshopId - Workshop document ID
   * @returns {Promise<Object | null>} Workshop data with studio info or null if not found
   */
  async getPublicWorkshopById(workshopId) {
    const db = getFirestore();
    const workshopRef = db.collection("workshops").doc(workshopId);
    const doc = await workshopRef.get();

    if (!doc.exists) {
      return null;
    }

    const workshopData = doc.data();
    
    // Get studio owner document
    const studioOwnerRef = db.collection("users").doc(workshopData.studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();
    
    if (!studioOwnerDoc.exists) {
      return null;
    }

    const studioOwnerData = studioOwnerDoc.data();

    // Parse dates
    const startTime = workshopData.startTime?.toDate ? workshopData.startTime.toDate() : new Date(workshopData.startTime);
    const endTime = workshopData.endTime?.toDate ? workshopData.endTime.toDate() : new Date(workshopData.endTime);

    return {
      id: doc.id,
      ...workshopData,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      studio: {
        id: workshopData.studioOwnerId,
        name: studioOwnerData.studioName || "",
        city: studioOwnerData.city || "",
        state: studioOwnerData.state || "",
        addressLine1: studioOwnerData.studioAddressLine1 || "",
        addressLine2: studioOwnerData.studioAddressLine2 || null,
        zip: studioOwnerData.zip || "",
      },
    };
  }
}

module.exports = new WorkshopsService();





