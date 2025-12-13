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
}

module.exports = new EventsService();





