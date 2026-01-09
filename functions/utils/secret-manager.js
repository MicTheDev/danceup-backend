const {SecretManagerServiceClient} = require("@google-cloud/secret-manager");

// Cache for secrets to avoid repeated API calls
const secretCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get secret from Google Secret Manager
 * @param {string} secretName - Name of the secret (e.g., 'stripe-secret-key-test')
 * @param {string} projectId - Google Cloud project ID (optional, will try to detect)
 * @returns {Promise<string>} Secret value
 */
async function getSecret(secretName, projectId = null) {
  // Check cache first
  const cacheKey = `${projectId || "default"}:${secretName}`;
  const cached = secretCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }

  try {
    const client = new SecretManagerServiceClient();

    // Try to get project ID from environment or use provided one
    let project = projectId;
    if (!project) {
      // Try to get from environment
      project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
      if (!project) {
        // Try to get from metadata service (if running on GCP)
        try {
          const http = require("http");
          project = await new Promise((resolve, reject) => {
            const req = http.get(
                "http://metadata.google.internal/computeMetadata/v1/project/project-id",
                {
                  headers: {"Metadata-Flavor": "Google"},
                },
                (res) => {
                  let data = "";
                  res.on("data", (chunk) => {
                    data += chunk;
                  });
                  res.on("end", () => {
                    resolve(data);
                  });
                },
            );
            req.on("error", reject);
            req.setTimeout(1000, () => {
              req.destroy();
              reject(new Error("Timeout"));
            });
          });
        } catch (error) {
          console.warn("Could not determine project ID from metadata service:", error.message);
        }
      }
    }

    if (!project) {
      throw new Error("Project ID is required. Set GCLOUD_PROJECT environment variable or provide projectId parameter.");
    }

    // Access the secret version
    const name = `projects/${project}/secrets/${secretName}/versions/latest`;
    const [version] = await client.accessSecretVersion({name});

    // Extract the secret value
    const secretValue = version.payload.data.toString();

    // Cache the secret
    secretCache.set(cacheKey, {
      value: secretValue,
      timestamp: Date.now(),
    });

    return secretValue;
  } catch (error) {
    console.error(`Error retrieving secret ${secretName}:`, error);
    throw new Error(`Failed to retrieve secret: ${secretName}. ${error.message}`);
  }
}

/**
 * Clear the secret cache (useful for testing or forced refresh)
 */
function clearCache() {
  secretCache.clear();
}

module.exports = {
  getSecret,
  clearCache,
};

