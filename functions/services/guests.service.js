const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");

class GuestsService {
  /**
   * Create a guest record
   * @param {Object} guestInfo - Guest information
   * @param {string} guestInfo.firstName - First name
   * @param {string} guestInfo.lastName - Last name
   * @param {string} guestInfo.email - Email address
   * @param {string} guestInfo.city - City
   * @param {string} guestInfo.state - State (2-letter code)
   * @param {string} guestInfo.zip - ZIP code
   * @returns {Promise<string>} Guest document ID
   */
  async createGuest(guestInfo) {
    const db = getFirestore();
    
    // Validate required fields
    if (!guestInfo.firstName || !guestInfo.lastName || !guestInfo.email) {
      throw new Error("First name, last name, and email are required");
    }

    if (!guestInfo.city || !guestInfo.state || !guestInfo.zip) {
      throw new Error("City, state, and ZIP code are required");
    }

    // Normalize email
    const normalizedEmail = guestInfo.email.trim().toLowerCase();

    // Always create a new guest record (allow duplicates even with same email)
    const guestDoc = {
      firstName: guestInfo.firstName.trim(),
      lastName: guestInfo.lastName.trim(),
      email: normalizedEmail,
      city: guestInfo.city.trim(),
      state: guestInfo.state.trim().toUpperCase(),
      zip: guestInfo.zip.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const guestRef = db.collection("guests").doc();
    await guestRef.set(guestDoc);

    return guestRef.id;
  }

  /**
   * Get guest by ID
   * @param {string} guestId - Guest document ID
   * @returns {Promise<Object | null>} Guest data or null if not found
   */
  async getGuestById(guestId) {
    const db = getFirestore();
    const guestRef = db.collection("guests").doc(guestId);
    const doc = await guestRef.get();

    if (!doc.exists) {
      return null;
    }

    return {
      id: doc.id,
      ...doc.data(),
    };
  }

  /**
   * Get guests by email
   * @param {string} email - Email address
   * @returns {Promise<Array>} Array of guest records
   */
  async getGuestsByEmail(email) {
    const db = getFirestore();
    const normalizedEmail = email.trim().toLowerCase();
    
    const query = await db.collection("guests")
        .where("email", "==", normalizedEmail)
        .get();

    const guests = [];
    query.forEach((doc) => {
      guests.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return guests;
  }
}

module.exports = new GuestsService();
