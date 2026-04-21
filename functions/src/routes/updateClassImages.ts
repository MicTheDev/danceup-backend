import * as functions from "firebase-functions";

// scripts/ is excluded from tsconfig — require with type annotation
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateClassImages: updateClassImagesScript } = require("../../scripts/update-class-images") as {
  updateClassImages: () => Promise<void>;
};

export const updateClassImages = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  try {
    console.log("Starting class images update...");
    await updateClassImagesScript();
    return { success: true, message: "Class images updated successfully" };
  } catch (error) {
    console.error("Error updating class images:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Failed to update class images",
      (error as Error).message,
    );
  }
});
