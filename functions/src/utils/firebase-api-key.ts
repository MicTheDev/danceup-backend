import { getSecret } from "./secret-manager";

let cachedApiKey: string | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cacheTimestamp = 0;

/**
 * Get Firebase Web API Key from Secret Manager or environment variable.
 * Supports dev, staging, and production environments.
 */
export async function getFirebaseApiKey(): Promise<string> {
  if (cachedApiKey && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedApiKey;
  }

  const envKey = process.env["FIREBASE_WEB_API_KEY"];
  if (envKey) {
    cachedApiKey = envKey.trim();
    cacheTimestamp = Date.now();
    return cachedApiKey;
  }

  try {
    const projectId = process.env["GCLOUD_PROJECT"] ?? process.env["GCP_PROJECT"] ?? "";

    let secretName: string;
    if (projectId.includes("production")) {
      secretName = "firebase-web-api-key-prod";
    } else if (projectId.includes("staging")) {
      secretName = "firebase-web-api-key-staging";
    } else {
      secretName = "firebase-web-api-key-dev";
    }

    const apiKey = await getSecret(secretName);

    if (apiKey) {
      cachedApiKey = apiKey.trim();
      cacheTimestamp = Date.now();
      return cachedApiKey;
    }
  } catch (error) {
    console.warn("Could not retrieve Firebase API key from Secret Manager:", (error as Error).message);
  }

  throw new Error("FIREBASE_WEB_API_KEY not configured in environment or Secret Manager");
}
