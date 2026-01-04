const functions = require("firebase-functions");
const {updateClassImages} = require("./scripts/update-class-images");

/**
 * Callable function to update all existing classes with their studio's image
 * This is a one-time migration function
 */
exports.updateClassImages = functions.https.onCall(async (data, context) => {
  // Verify the user is authenticated (optional - you may want to restrict to admins)
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "The function must be called while authenticated.",
    );
  }

  try {
    console.log("Starting class images update...");
    await updateClassImages();
    return {
      success: true,
      message: "Class images updated successfully",
    };
  } catch (error) {
    console.error("Error updating class images:", error);
    throw new functions.https.HttpsError(
        "internal",
        "Failed to update class images",
        error.message,
    );
  }
});

