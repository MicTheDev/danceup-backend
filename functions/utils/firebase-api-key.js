const {getSecret} = require("./secret-manager");

let cachedApiKey = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cacheTimestamp = 0;

/**
 * Get Firebase Web API Key from Secret Manager or environment variable
 * Supports dev, staging, and production environments
 * @returns {Promise<string>} Firebase Web API Key
 */
async function getFirebaseApiKey() {
  // Check cache first
  if (cachedApiKey && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedApiKey;
  }

  // Try environment variable first (for local development/emulator)
  if (process.env.FIREBASE_WEB_API_KEY) {
    cachedApiKey = process.env.FIREBASE_WEB_API_KEY.trim();
    cacheTimestamp = Date.now();
    return cachedApiKey;
  }

  // Try Secret Manager (for production/deployed functions)
  try {
    const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
    
    // Determine secret name based on project
    let secretName;
    if (projectId.includes("production")) {
      secretName = "firebase-web-api-key-prod";
    } else if (projectId.includes("staging")) {
      secretName = "firebase-web-api-key-staging";
    } else {
      // Default to dev
      secretName = "firebase-web-api-key-dev";
    }

    const apiKey = await getSecret(secretName);
    
    if (apiKey) {
      cachedApiKey = apiKey.trim();
      cacheTimestamp = Date.now();
      return cachedApiKey;
    }
  } catch (error) {
    console.warn("Could not retrieve Firebase API key from Secret Manager:", error.message);
  }

  throw new Error("FIREBASE_WEB_API_KEY not configured in environment or Secret Manager");
}

module.exports = {
  getFirebaseApiKey,
};


