import * as http from "http";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

interface CacheEntry {
  value: string;
  timestamp: number;
}

const secretCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get secret from Google Secret Manager.
 */
export async function getSecret(secretName: string, projectId: string | null = null): Promise<string> {
  const cacheKey = `${projectId ?? "default"}:${secretName}`;
  const cached = secretCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }

  try {
    const client = new SecretManagerServiceClient();

    let project = projectId;
    if (!project) {
      project = process.env["GCLOUD_PROJECT"] ?? process.env["GCP_PROJECT"] ?? null;
      if (!project) {
        try {
          project = await new Promise<string>((resolve, reject) => {
            const req = http.get(
              "http://metadata.google.internal/computeMetadata/v1/project/project-id",
              { headers: { "Metadata-Flavor": "Google" } },
              (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => { data += chunk; });
                res.on("end", () => { resolve(data); });
              },
            );
            req.on("error", reject);
            req.setTimeout(1000, () => {
              req.destroy();
              reject(new Error("Timeout"));
            });
          });
        } catch (error) {
          console.warn("Could not determine project ID from metadata service:", (error as Error).message);
        }
      }
    }

    if (!project) {
      throw new Error(
        "Project ID is required. Set GCLOUD_PROJECT environment variable or provide projectId parameter.",
      );
    }

    const name = `projects/${project}/secrets/${secretName}/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });

    const secretValue = version.payload?.data?.toString() ?? "";

    secretCache.set(cacheKey, { value: secretValue, timestamp: Date.now() });
    return secretValue;
  } catch (error) {
    console.error(`Error retrieving secret ${secretName}:`, error);
    throw new Error(`Failed to retrieve secret: ${secretName}. ${(error as Error).message}`);
  }
}

/**
 * Clear the secret cache (useful for testing or forced refresh).
 */
export function clearCache(): void {
  secretCache.clear();
}
