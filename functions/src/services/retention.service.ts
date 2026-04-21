import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";
import { sendReEngagementEmail, sendCreditExpiryEmail } from "./sendgrid.service";

const RE_ENGAGEMENT_DAYS = 14;
const RE_ENGAGEMENT_COOLDOWN_DAYS = 30;
const CREDIT_EXPIRY_WARNING_DAYS = 7;
const CREDIT_EXPIRY_COOLDOWN_DAYS = 7;

function tsToDate(val: unknown): Date | null {
  if (!val) return null;
  if (typeof val === "object" && val !== null && "toDate" in val) {
    return (val as { toDate(): Date }).toDate();
  }
  const d = new Date(val as string | number);
  return isNaN(d.getTime()) ? null : d;
}

export class RetentionService {
  async processAllStudios(): Promise<{ totalReEngagement: number; totalCreditExpiry: number }> {
    const db = getFirestore();
    const studentsSnapshot = await db.collection("students").get();
    const studioOwnerIds = new Set<string>();
    studentsSnapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      if (data["studioOwnerId"]) studioOwnerIds.add(data["studioOwnerId"] as string);
    });

    let totalReEngagement = 0;
    let totalCreditExpiry = 0;

    for (const studioOwnerId of studioOwnerIds) {
      try {
        const [re, ce] = await Promise.all([
          this.processReEngagementEmails(studioOwnerId),
          this.processCreditExpiryEmails(studioOwnerId),
        ]);
        totalReEngagement += re;
        totalCreditExpiry += ce;
      } catch (err) {
        console.error(`[Retention] Error processing studio ${studioOwnerId}:`, (err as Error).message);
      }
    }

    return { totalReEngagement, totalCreditExpiry };
  }

  async processReEngagementEmails(studioOwnerId: string): Promise<number> {
    const db = getFirestore();
    const now = new Date();
    const cutoff = new Date(now.getTime() - RE_ENGAGEMENT_DAYS * 24 * 60 * 60 * 1000);
    const cooldown = new Date(now.getTime() - RE_ENGAGEMENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    // No date range in the query (avoids composite index requirement) — filter in JS
    const recentSnapshot = await db.collection("attendance")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isRemoved", "==", false)
      .get();

    const activeStudentIds = new Set<string>();
    recentSnapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const sid = data["studentId"] as string | undefined;
      const date = tsToDate(data["classInstanceDate"]);
      if (sid && date && date >= cutoff) activeStudentIds.add(sid);
    });

    const studentsSnapshot = await db.collection("students")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();

    const studioDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioName = studioDoc.exists
      ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string) || "your studio"
      : "your studio";

    let sent = 0;

    for (const studentDoc of studentsSnapshot.docs) {
      if (activeStudentIds.has(studentDoc.id)) continue;
      const studentData = studentDoc.data() as Record<string, unknown>;
      if (!studentData["email"]) continue;

      const recentEmail = await db.collection("retention_emails")
        .where("studentId", "==", studentDoc.id)
        .where("type", "==", "re_engagement")
        .where("sentAt", ">=", admin.firestore.Timestamp.fromDate(cooldown))
        .limit(1)
        .get();
      if (!recentEmail.empty) continue;

      try {
        await sendReEngagementEmail(
          studentData["email"] as string,
          (studentData["firstName"] as string) || (studentData["name"] as string) || "there",
          studioName,
        );
        await db.collection("retention_emails").add({
          studentId: studentDoc.id,
          studioOwnerId,
          type: "re_engagement",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        sent++;
      } catch (err) {
        console.error(`[Retention] Failed re-engagement email to ${studentData["email"]}:`, (err as Error).message);
      }
    }

    return sent;
  }

  async processCreditExpiryEmails(studioOwnerId: string): Promise<number> {
    const db = getFirestore();
    const now = new Date();
    const warningDate = new Date(now.getTime() + CREDIT_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000);
    const cooldown = new Date(now.getTime() - CREDIT_EXPIRY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    // Equality-only query (no date range = no composite index needed) — filter window in JS
    const creditsSnapshot = await db.collectionGroup("credits")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("used", "==", false)
      .get();

    const studentCreditMap = new Map<string, { count: number; expiresAt: Date | null }>();
    creditsSnapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const studentId = data["studentId"] as string | undefined;
      if (!studentId) return;
      const expDate = tsToDate(data["expiresAt"]);
      if (!expDate || expDate < now || expDate > warningDate) return; // filter expiry window in JS
      if (!studentCreditMap.has(studentId)) studentCreditMap.set(studentId, { count: 0, expiresAt: null });
      const entry = studentCreditMap.get(studentId)!;
      entry.count++;
      if (!entry.expiresAt || expDate < entry.expiresAt) entry.expiresAt = expDate;
    });

    const studioDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioName = studioDoc.exists
      ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string) || "your studio"
      : "your studio";

    let sent = 0;

    for (const [studentId, creditInfo] of studentCreditMap.entries()) {
      const recentEmail = await db.collection("retention_emails")
        .where("studentId", "==", studentId)
        .where("type", "==", "credit_expiry")
        .where("sentAt", ">=", admin.firestore.Timestamp.fromDate(cooldown))
        .limit(1)
        .get();
      if (!recentEmail.empty) continue;

      const studentDoc = await db.collection("students").doc(studentId).get();
      if (!studentDoc.exists) continue;
      const studentData = studentDoc.data() as Record<string, unknown>;
      if (!studentData["email"]) continue;

      const expiryDateStr = creditInfo.expiresAt
        ? creditInfo.expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
        : "soon";

      try {
        await sendCreditExpiryEmail(
          studentData["email"] as string,
          (studentData["firstName"] as string) || (studentData["name"] as string) || "there",
          studioName,
          creditInfo.count,
          expiryDateStr,
        );
        await db.collection("retention_emails").add({
          studentId,
          studioOwnerId,
          type: "credit_expiry",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        sent++;
      } catch (err) {
        console.error(`[Retention] Failed credit expiry email to ${studentData["email"]}:`, (err as Error).message);
      }
    }

    return sent;
  }
}

export default new RetentionService();
