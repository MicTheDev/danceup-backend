import * as admin from "firebase-admin";
import type { Firestore } from "@google-cloud/firestore";

/**
 * Get Firestore instance with the correct database ID.
 * Based on the project ID, determines which database to use.
 */
export function getFirestore(): Firestore {
  const isEmulator = process.env["FIRESTORE_EMULATOR_HOST"] ?? process.env["FUNCTIONS_EMULATOR_HOST"];

  const projectId = process.env["GCLOUD_PROJECT"] ?? admin.app().options.projectId ?? "";

  let databaseId = "(default)";

  if (projectId === "dev-danceup") {
    databaseId = "development";
  } else if (projectId === "staging-danceup") {
    databaseId = "staging";
  } else if (projectId === "production-danceup") {
    databaseId = "production";
  }

  if (process.env["FIRESTORE_DATABASE_ID"]) {
    databaseId = process.env["FIRESTORE_DATABASE_ID"];
  }

  if (isEmulator) {
    databaseId = "(default)";
  }

  if (databaseId === "(default)") {
    return admin.firestore() as unknown as Firestore;
  }

  try {
    const { Firestore: FirestoreClass } = require("@google-cloud/firestore") as { Firestore: typeof Firestore };
    const firestore = new FirestoreClass({ projectId, databaseId });
    console.log(`Using Firestore database: ${databaseId} for project: ${projectId}`);
    return firestore;
  } catch (error) {
    console.error(`Error creating Firestore instance for database ${databaseId}:`, (error as Error).message);
    console.warn("Falling back to default database due to error");
    return admin.firestore() as unknown as Firestore;
  }
}
