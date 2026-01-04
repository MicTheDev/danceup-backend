const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling event management operations
 */
class EventsService {
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
   * Get all events for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of events
   */
  async getEvents(studioOwnerId) {
    const db = getFirestore();
    const eventsRef = db.collection("events");
    const snapshot = await eventsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const events = [];
    snapshot.forEach((doc) => {
      events.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return events;
  }

  /**
   * Get a single event by ID
   * @param {string} eventId - Event document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object | null>} Event data or null if not found
   */
  async getEventById(eventId, studioOwnerId) {
    const db = getFirestore();
    const eventRef = db.collection("events").doc(eventId);
    const doc = await eventRef.get();

    if (!doc.exists) {
      return null;
    }

    const eventData = doc.data();
    if (eventData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Event does not belong to this studio owner");
    }

    return {
      id: doc.id,
      ...eventData,
    };
  }

  /**
   * Create a new event
   * @param {Object} eventData - Event data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created event document ID
   */
  async createEvent(eventData, studioOwnerId) {
    const db = getFirestore();
    const eventDataWithMetadata = {
      ...eventData,
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("events").add(eventDataWithMetadata);
    return docRef.id;
  }

  /**
   * Update an existing event
   * @param {string} eventId - Event document ID
   * @param {Object} eventData - Updated event data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateEvent(eventId, eventData, studioOwnerId) {
    const db = getFirestore();
    const eventRef = db.collection("events").doc(eventId);
    const doc = await eventRef.get();

    if (!doc.exists) {
      throw new Error("Event not found");
    }

    const existingData = doc.data();
    if (existingData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Event does not belong to this studio owner");
    }

    const updateData = {
      ...eventData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await eventRef.update(updateData);
  }

  /**
   * Delete an event
   * @param {string} eventId - Event document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteEvent(eventId, studioOwnerId) {
    const db = getFirestore();
    const eventRef = db.collection("events").doc(eventId);
    const doc = await eventRef.get();

    if (!doc.exists) {
      throw new Error("Event not found");
    }

    const eventData = doc.data();
    if (eventData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Event does not belong to this studio owner");
    }

    await eventRef.delete();
  }

  /**
   * Get all public events with optional filters
   * @param {Object} filters - Filter options
   * @param {string|null} filters.type - Event type filter (social, festival, congress)
   * @param {string|null} filters.city - City filter
   * @param {string|null} filters.state - State filter
   * @param {string|null} filters.studioName - Studio name filter (partial match)
   * @param {number|null} filters.minPrice - Minimum price filter
   * @param {number|null} filters.maxPrice - Maximum price filter
   * @param {string|null} filters.startDate - Start date filter (ISO string)
   * @param {string|null} filters.endDate - End date filter (ISO string)
   * @returns {Promise<Array>} Array of events with studio information
   */
  async getAllPublicEvents(filters = {}) {
    const db = getFirestore();
    const eventsRef = db.collection("events");
    
    let query = eventsRef;
    
    // Apply filters that can be done at query level
    if (filters.type && filters.type !== "All") {
      query = query.where("type", "==", filters.type);
    }
    
    // Get all events matching the query
    const snapshot = await query.get();
    
    // Get all studio owner IDs from events
    const studioOwnerIds = new Set();
    const eventsMap = new Map();
    
    snapshot.forEach((doc) => {
      const eventData = doc.data();
      // Only add valid studioOwnerIds (filter out undefined/null)
      if (eventData.studioOwnerId) {
        studioOwnerIds.add(eventData.studioOwnerId);
        eventsMap.set(doc.id, {
          id: doc.id,
          ...eventData,
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

    // Enrich events with studio information and apply remaining filters
    const enrichedEvents = [];
    const now = new Date();
    
    for (const [eventId, eventData] of eventsMap.entries()) {
      const studioOwner = studioOwnersMap.get(eventData.studioOwnerId);
      
      if (!studioOwner) {
        continue; // Skip events without studio owner data
      }

      // Parse event dates
      const startTime = eventData.startTime?.toDate ? eventData.startTime.toDate() : new Date(eventData.startTime);
      const endTime = eventData.endTime?.toDate ? eventData.endTime.toDate() : (eventData.endTime ? new Date(eventData.endTime) : null);
      const compareTime = endTime || startTime;

      // Apply date filters
      if (filters.startDate) {
        const filterStartDate = new Date(filters.startDate);
        if (compareTime < filterStartDate) {
          continue;
        }
      }

      if (filters.endDate) {
        const filterEndDate = new Date(filters.endDate);
        if (startTime > filterEndDate) {
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
      if (eventData.priceTiers && Array.isArray(eventData.priceTiers) && eventData.priceTiers.length > 0) {
        const minPrice = Math.min(...eventData.priceTiers.map(tier => tier.price || 0));
        const maxPrice = Math.max(...eventData.priceTiers.map(tier => tier.price || 0));

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
      
      // Build enriched event object
      const enrichedEvent = {
        ...eventData,
        startTime: startTime.toISOString(),
        endTime: endTime ? endTime.toISOString() : null,
        studio: {
          id: eventData.studioOwnerId,
          name: studioOwner.studioName || "",
          city: studioOwner.city || "",
          state: studioOwner.state || "",
          addressLine1: studioOwner.studioAddressLine1 || "",
          addressLine2: studioOwner.studioAddressLine2 || null,
          zip: studioOwner.zip || "",
        },
      };

      enrichedEvents.push(enrichedEvent);
    }

    return enrichedEvents;
  }

  /**
   * Get a single public event by ID with studio details
   * @param {string} eventId - Event document ID
   * @returns {Promise<Object | null>} Event data with studio info or null if not found
   */
  async getPublicEventById(eventId) {
    const db = getFirestore();
    const eventRef = db.collection("events").doc(eventId);
    const doc = await eventRef.get();

    if (!doc.exists) {
      return null;
    }

    const eventData = doc.data();
    
    // Get studio owner document
    const studioOwnerRef = db.collection("users").doc(eventData.studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();
    
    if (!studioOwnerDoc.exists) {
      return null;
    }

    const studioOwnerData = studioOwnerDoc.data();

    // Parse dates
    const startTime = eventData.startTime?.toDate ? eventData.startTime.toDate() : new Date(eventData.startTime);
    const endTime = eventData.endTime?.toDate ? eventData.endTime.toDate() : (eventData.endTime ? new Date(eventData.endTime) : null);

    return {
      id: doc.id,
      ...eventData,
      startTime: startTime.toISOString(),
      endTime: endTime ? endTime.toISOString() : null,
      studio: {
        id: eventData.studioOwnerId,
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

module.exports = new EventsService();





