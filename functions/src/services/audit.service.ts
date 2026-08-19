import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";

export type AuditAction =
  | "student_deleted"
  | "students_bulk_imported"
  | "instructor_created"
  | "instructor_updated"
  | "instructor_deleted"
  | "subscription_cancelled"
  | "subscription_plan_changed"
  | "payment_method_deleted"
  | "payment_method_set_default"
  | "assistant_email_campaign_sent"
  | "assistant_automation_rule_created"
  | "assistant_class_created"
  | "assistant_class_updated"
  | "assistant_package_updated"
  | "placeholder_studio_created"
  | "class_admin_created"
  | "class_admin_updated"
  | "class_admin_deleted"
  | "class_reassigned"
  | "workshop_admin_created"
  | "workshop_admin_updated"
  | "workshop_admin_deleted"
  | "workshop_reassigned"
  | "event_admin_created"
  | "event_admin_updated"
  | "event_admin_deleted"
  | "event_reassigned"
  | "studio_admin_onboarded"
  | "studio_admin_subscription_created"
  | "student_admin_bulk_imported"
  | "instructor_admin_bulk_imported"
  | "class_admin_bulk_imported";

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
