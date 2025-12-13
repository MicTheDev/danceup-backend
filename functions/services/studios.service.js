const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");
const instructorsService = require("./instructors.service");

/**
 * Service for handling studio management operations
 */
class StudiosService {
  /**
   * Get all public studios with optional filters
   * @param {Object} filters - Filter options
   * @param {string|null} filters.city - City filter
   * @param {string|null} filters.state - State filter
   * @param {string|null} filters.studioName - Studio name filter (partial match)
   * @returns {Promise<Array>} Array of studios
   */
  async getAllPublicStudios(filters = {}) {
    const db = getFirestore();
    const usersRef = db.collection("users");
    
    // Query for users with studio_owner role
    let query = usersRef.where("roles", "array-contains", "studio_owner");
    
    // Apply state filter if provided (can be done at query level)
    if (filters.state) {
      query = query.where("state", "==", filters.state.toUpperCase());
    }
    
    // Get all studio owners
    const snapshot = await query.get();
    
    const studios = [];
    snapshot.forEach((doc) => {
      const userData = doc.data();
      
      // Apply filters that require checking data
      if (filters.city && userData.city) {
        const studioCity = userData.city.toLowerCase().trim();
        const filterCity = filters.city.toLowerCase().trim();
        if (!studioCity.includes(filterCity) && !filterCity.includes(studioCity)) {
          return; // Skip this studio
        }
      }
      
      if (filters.studioName && userData.studioName) {
        const studioName = userData.studioName.toLowerCase().trim();
        const filterName = filters.studioName.toLowerCase().trim();
        if (!studioName.includes(filterName)) {
          return; // Skip this studio
        }
      }
      
      // Build studio object with only necessary fields for listing
      studios.push({
        id: doc.id,
        studioName: userData.studioName || "",
        studioImageUrl: userData.studioImageUrl || null,
        city: userData.city || "",
        state: userData.state || "",
        zip: userData.zip || "",
        studioAddressLine1: userData.studioAddressLine1 || "",
        studioAddressLine2: userData.studioAddressLine2 || null,
      });
    });
    
    return studios;
  }

  /**
   * Get a single public studio by ID with instructor details
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object | null>} Studio data with instructors or null if not found
   */
  async getPublicStudioById(studioOwnerId) {
    const db = getFirestore();
    const studioRef = db.collection("users").doc(studioOwnerId);
    const doc = await studioRef.get();

    if (!doc.exists) {
      return null;
    }

    const studioData = doc.data();
    
    // Verify this is a studio owner
    if (!studioData.roles || !studioData.roles.includes("studio_owner")) {
      return null;
    }

    // Get all instructors for this studio
    const instructors = await instructorsService.getInstructors(studioOwnerId);

    // Build enriched studio object
    return {
      id: doc.id,
      studioName: studioData.studioName || "",
      studioImageUrl: studioData.studioImageUrl || null,
      city: studioData.city || "",
      state: studioData.state || "",
      zip: studioData.zip || "",
      studioAddressLine1: studioData.studioAddressLine1 || "",
      studioAddressLine2: studioData.studioAddressLine2 || null,
      firstName: studioData.firstName || "",
      lastName: studioData.lastName || "",
      email: studioData.email || "",
      phone: studioData.phone || null,
      facebook: studioData.facebook || null,
      instagram: studioData.instagram || null,
      tiktok: studioData.tiktok || null,
      youtube: studioData.youtube || null,
      membership: studioData.membership || null,
      instructors: instructors.map((instructor) => ({
        id: instructor.id,
        firstName: instructor.firstName || "",
        lastName: instructor.lastName || "",
        photoURL: instructor.photoURL || instructor.photoUrl || null,
        bio: instructor.bio || null,
        email: instructor.email || null,
        phone: instructor.phone || null,
      })),
    };
  }
}

module.exports = new StudiosService();
