import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";

export type AuditAction =
  | "student_deleted"
  | "instructor_created"
  | "instructor_updated"
  | "instructor_deleted"
  | "subscription_cancelled"
  | "payment_method_deleted"
  | "payment_method_set_default";

async function writeAuditLog(
  actorUid: string,
  studioOwnerId: string,
  action: AuditAction,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const db = getFirestore();
  await db.collection("auditLogs").add({
    timestamp: admin.firestore.Timestamp.now(),
    actorUid,
    studioOwnerId,
    action,
    resourceType,
    resourceId,
    metadata,
  });
}

export function logAuditEvent(
  actorUid: string,
  studioOwnerId: string,
  action: AuditAction,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
): void {
  writeAuditLog(actorUid, studioOwnerId, action, resourceType, resourceId, metadata).catch((err) => {
    console.error("[audit] Failed to write audit log:", (err as Error).message);
  });
}
