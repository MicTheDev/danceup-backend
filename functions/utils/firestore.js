/**
 * Utility to get Firestore instance with the correct database ID
 * Based on the project ID, determines which database to use
 */

const admin = require("firebase-admin");
const {Firestore} = require("@google-cloud/firestore");

/**
 * Get Firestore instance with the correct database ID
 * @returns {admin.firestore.Firestore} Firestore instance
 */
function getFirestore() {
  const projectId = process.env.GCLOUD_PROJECT || admin.app().options.projectId;
  
  // Determine database ID based on project
  let databaseId = "(default)";
  
  if (projectId === "dev-danceup") {
    databaseId = "development";
  } else if (projectId === "staging-danceup") {
    databaseId = "staging";
  } else if (projectId === "production-danceup") {
    databaseId = "production";
  }
  
  // If database ID is specified in environment variable, use that
  if (process.env.FIRESTORE_DATABASE_ID) {
    databaseId = process.env.FIRESTORE_DATABASE_ID;
  }
  
  // Get Firestore with the specified database ID
  // For non-default databases, we need to use the Firestore constructor directly
  if (databaseId === "(default)") {
    return admin.firestore();
  } else {
    // For non-default databases, create a new Firestore instance with the database ID
    // The Firestore constructor accepts a databaseId option
    try {
      const app = admin.app();
      // Create Firestore instance with database ID
      // The Firestore constructor will use the default credentials from the environment
      const firestore = new Firestore({
        projectId: projectId,
        databaseId: databaseId,
      });
      console.log(`Using Firestore database: ${databaseId} for project: ${projectId}`);
      return firestore;
    } catch (error) {
      console.error(`Error creating Firestore instance for database ${databaseId}:`, error.message);
      console.error("Stack:", error.stack);
      // Fallback to default database
      console.warn(`Falling back to default database due to error`);
      return admin.firestore();
    }
  }
}

module.exports = {
  getFirestore,
};

