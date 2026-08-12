import * as admin from "firebase-admin";
import { getFirestore } from "./firestore";

export interface AdminStudioInfo {
  id: string;
  studioName: string;
  city: string;
  state: string;
  isPlaceholder: boolean;
}

/** Converts a Firestore Timestamp to an ISO string, safe to call before res.json() serializes it. */
export function toIso(ts: unknown): string | null {
  if (!ts) return null;
  if (typeof ts === "object" && ts !== null && "toDate" in ts) {
    return (ts as admin.firestore.Timestamp).toDate().toISOString();
  }
  return null;
}

/**
 * Batch-fetches studio (real or placeholder) info for admin list/detail views —
 * used by classes/workshops/events admin services to attach `studio` to each
 * item regardless of which studio owns it.
 */
export async function batchGetStudios(studioOwnerIds: Iterable<string>): Promise<Map<string, AdminStudioInfo>> {
  const db = getFirestore();
  const studiosMap = new Map<string, AdminStudioInfo>();
  const idsArray = Array.from(new Set(studioOwnerIds)).filter(Boolean);
  for (let i = 0; i < idsArray.length; i += 10) {
    const batch = idsArray.slice(i, i + 10);
    const snap = await db.collection("users")
      .where(admin.firestore.FieldPath.documentId(), "in", batch)
      .get();
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      studiosMap.set(doc.id, {
        id: doc.id,
        studioName: (d["studioName"] as string) || "Unnamed Studio",
        city: (d["city"] as string) || "",
        state: (d["state"] as string) || "",
        isPlaceholder: (d["isPlaceholderStudio"] as boolean) || false,
      });
    });
  }
  return studiosMap;
}
