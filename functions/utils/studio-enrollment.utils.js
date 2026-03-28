/**
 * Utility functions for studio enrollment
 * Extracted to break circular dependencies
 */

/**
 * Convert studioIds array to studios object structure
 * @param {Array<string>} studioIds - Array of studio owner IDs
 * @returns {Object} Studios object with credits initialized to 0
 */
function convertStudioIdsToStudios(studioIds) {
  if (!Array.isArray(studioIds)) {
    return {};
  }
  const studios = {};
  studioIds.forEach((studioId) => {
    studios[studioId] = {};
  });
  return studios;
}

/**
 * Ensure studios object structure exists in user profile data
 * @param {Object} userProfileData - User profile data
 * @returns {Object} Studios object
 */
function ensureStudiosStructure(userProfileData) {
  if (!userProfileData) {
    return {};
  }

  // If studios object already exists, return it
  if (userProfileData.studios && typeof userProfileData.studios === "object") {
    return userProfileData.studios;
  }

  // If studioIds array exists, convert it to studios object
  if (Array.isArray(userProfileData.studioIds)) {
    return convertStudioIdsToStudios(userProfileData.studioIds);
  }

  // Otherwise return empty object
  return {};
}

module.exports = {
  convertStudioIdsToStudios,
  ensureStudiosStructure,
};

