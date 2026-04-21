import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";
import {
  sendReEngagementEmail,
  sendCreditExpiryEmail,
  sendMilestoneEmail,
  sendSignupNudgeEmail,
} from "./sendgrid.service";

export type TriggerType = "inactive_days" | "credits_expiring_days" | "signup_no_attend" | "milestone_checkins";
export type ActionType = "re_engagement_email" | "credit_reminder_email" | "milestone_email" | "signup_nudge_email";

export interface CampaignRule {
  id: string;
  studioOwnerId: string;
  name: string;
  isActive: boolean;
  triggerType: TriggerType;
  triggerValue: number;
  actionType: ActionType;
  cooldownDays: number;
  sentCount: number;
  createdAt: admin.firestore.Timestamp | null;
  updatedAt: admin.firestore.Timestamp | null;
  lastEvaluatedAt: admin.firestore.Timestamp | null;
}

function tsToDate(val: unknown): Date | null {
  if (!val) return null;
  if (typeof val === "object" && val !== null && "toDate" in val) {
    return (val as { toDate(): Date }).toDate();
  }
  const d = new Date(val as string | number);
  return isNaN(d.getTime()) ? null : d;
}

class CampaignRulesService {
  async getRules(studioOwnerId: string): Promise<CampaignRule[]> {
    const db = getFirestore();
    const snap = await db.collection("campaign_rules")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    const rules = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<CampaignRule, "id">) }));
    // Sort newest first in JS to avoid requiring a composite Firestore index
    return rules.sort((a, b) => {
      const aTime = a.createdAt ? (a.createdAt as unknown as { toMillis(): number }).toMillis() : 0;
      const bTime = b.createdAt ? (b.createdAt as unknown as { toMillis(): number }).toMillis() : 0;
      return bTime - aTime;
    });
  }

  async createRule(studioOwnerId: string, payload: {
    name: string;
    triggerType: TriggerType;
    triggerValue: number;
    actionType: ActionType;
    cooldownDays?: number;
  }): Promise<string> {
    const db = getFirestore();
    const { name, triggerType, triggerValue, actionType, cooldownDays = 30 } = payload;
    const docRef = await db.collection("campaign_rules").add({
      studioOwnerId,
      name,
      isActive: true,
      triggerType,
      triggerValue,
      actionType,
      cooldownDays,
      sentCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastEvaluatedAt: null,
    });
    return docRef.id;
  }

  async updateRule(ruleId: string, studioOwnerId: string, updates: Partial<{
    name: string;
    isActive: boolean;
    triggerType: TriggerType;
    triggerValue: number;
    actionType: ActionType;
    cooldownDays: number;
  }>): Promise<void> {
    const db = getFirestore();
    const doc = await db.collection("campaign_rules").doc(ruleId).get();
    if (!doc.exists || (doc.data() as Record<string, unknown>)["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Campaign rule not found or access denied");
    }
    await db.collection("campaign_rules").doc(ruleId).update({
      ...updates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async deleteRule(ruleId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const doc = await db.collection("campaign_rules").doc(ruleId).get();
    if (!doc.exists || (doc.data() as Record<string, unknown>)["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Campaign rule not found or access denied");
    }
    await db.collection("campaign_rules").doc(ruleId).delete();
  }

  async evaluateRulesForStudio(studioOwnerId: string): Promise<number> {
    const db = getFirestore();
    const now = new Date();

    // All queries use single equality filter only — no composite indexes needed
    const [rulesSnap, studentsSnap, studioDoc, attendanceSnap, campaignEmailsSnap] = await Promise.all([
      db.collection("campaign_rules").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("users").doc(studioOwnerId).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("campaign_emails").where("studioOwnerId", "==", studioOwnerId).get(),
    ]);

    // Filter active rules in JS
    const activeRuleDocs = rulesSnap.docs.filter(
      (d) => (d.data() as Record<string, unknown>)["isActive"] === true
    );
    if (activeRuleDocs.length === 0 || studentsSnap.empty) return 0;

    const studioName = studioDoc.exists
      ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string) || "your studio"
      : "your studio";

    // Build last-attended and total check-in maps; filter isRemoved in JS
    const lastAttendedMap = new Map<string, Date>();
    const totalCheckInsMap = new Map<string, number>();
    attendanceSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d["isRemoved"] === true) return;
      const sid = d["studentId"] as string | undefined;
      const date = tsToDate(d["classInstanceDate"]);
      if (!sid || !date) return;
      const existing = lastAttendedMap.get(sid);
      if (!existing || date > existing) lastAttendedMap.set(sid, date);
      totalCheckInsMap.set(sid, (totalCheckInsMap.get(sid) || 0) + 1);
    });

    // Build cooldown map from pre-fetched campaign emails: `${studentId}_${ruleId}` -> latest sentAt
    const cooldownMap = new Map<string, Date>();
    campaignEmailsSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const sid = d["studentId"] as string | undefined;
      const rid = d["ruleId"] as string | undefined;
      const sentAt = tsToDate(d["sentAt"]);
      if (!sid || !rid || !sentAt) return;
      const key = `${sid}_${rid}`;
      const existing = cooldownMap.get(key);
      if (!existing || sentAt > existing) cooldownMap.set(key, sentAt);
    });

    // Fetch credits per student only if a credits_expiring_days rule is active
    const expiringCreditsMap = new Map<string, number>(); // studentId -> days until soonest expiry
    const needsCredits = activeRuleDocs.some(
      (d) => (d.data() as Record<string, unknown>)["triggerType"] === "credits_expiring_days"
    );
    if (needsCredits) {
      await Promise.all(studentsSnap.docs.map(async (studentDoc) => {
        const creditsRef = db.collection("students").doc(studentDoc.id).collection("credits");
        // Single-field query on subcollection — auto-indexed, no composite index needed
        const snap = await creditsRef.where("credits", ">", 0).get();
        snap.forEach((doc) => {
          const d = doc.data() as Record<string, unknown>;
          const expDate = tsToDate(d["expirationDate"]);
          if (!expDate) return;
          const daysUntil = Math.ceil((expDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
          if (daysUntil < 0) return; // already expired
          const existing = expiringCreditsMap.get(studentDoc.id);
          if (existing === undefined || daysUntil < existing) expiringCreditsMap.set(studentDoc.id, daysUntil);
        });
      }));
    }

    let totalSent = 0;

    for (const ruleDoc of activeRuleDocs) {
      const rule = ruleDoc.data() as Omit<CampaignRule, "id">;
      const ruleId = ruleDoc.id;
      const cooldownMs = rule.cooldownDays * 24 * 60 * 60 * 1000;
      let ruleSent = 0;

      for (const studentDoc of studentsSnap.docs) {
        const studentData = studentDoc.data() as Record<string, unknown>;
        const sid = studentDoc.id;
        const email = studentData["email"] as string | undefined;
        if (!email) continue;
        const firstName = (studentData["firstName"] as string) || (studentData["name"] as string) || "there";

        let shouldSend = false;

        switch (rule.triggerType) {
          case "inactive_days": {
            const lastDate = lastAttendedMap.get(sid);
            const daysSince = lastDate
              ? Math.floor((now.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000))
              : null;
            shouldSend = (daysSince === null || daysSince >= rule.triggerValue);
            break;
          }
          case "credits_expiring_days": {
            const daysUntil = expiringCreditsMap.get(sid);
            shouldSend = daysUntil !== undefined && daysUntil <= rule.triggerValue;
            break;
          }
          case "signup_no_attend": {
            const joinedDate = tsToDate(studentData["createdAt"]);
            const daysSinceJoin = joinedDate
              ? Math.floor((now.getTime() - joinedDate.getTime()) / (24 * 60 * 60 * 1000))
              : 0;
            const neverAttended = !lastAttendedMap.has(sid);
            shouldSend = neverAttended && daysSinceJoin >= rule.triggerValue;
            break;
          }
          case "milestone_checkins": {
            const total = totalCheckInsMap.get(sid) || 0;
            // Only send if student JUST crossed the milestone (within a 5-check-in window to avoid repeat sends)
            shouldSend = total >= rule.triggerValue && total < rule.triggerValue + 5;
            break;
          }
        }

        if (!shouldSend) continue;

        // Check cooldown in JS using the pre-fetched map
        const cooldownKey = `${sid}_${ruleId}`;
        const lastSent = cooldownMap.get(cooldownKey);
        if (lastSent && now.getTime() - lastSent.getTime() < cooldownMs) continue;

        try {
          switch (rule.actionType) {
            case "re_engagement_email":
              await sendReEngagementEmail(email, firstName, studioName);
              break;
            case "credit_reminder_email": {
              const daysUntil = expiringCreditsMap.get(sid) ?? 0;
              const expiryDateStr = new Date(now.getTime() + daysUntil * 24 * 60 * 60 * 1000)
                .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
              await sendCreditExpiryEmail(email, firstName, studioName, 1, expiryDateStr);
              break;
            }
            case "milestone_email": {
              const total = totalCheckInsMap.get(sid) || 0;
              await sendMilestoneEmail(email, firstName, studioName, total);
              break;
            }
            case "signup_nudge_email": {
              const joinedDate = tsToDate(studentData["createdAt"]);
              const daysSince = joinedDate
                ? Math.floor((now.getTime() - joinedDate.getTime()) / (24 * 60 * 60 * 1000))
                : rule.triggerValue;
              await sendSignupNudgeEmail(email, firstName, studioName, daysSince);
              break;
            }
          }

          await db.collection("campaign_emails").add({
            studentId: sid,
            studioOwnerId,
            ruleId,
            actionType: rule.actionType,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          // Update in-memory map so the cooldown is respected within this same evaluation run
          cooldownMap.set(cooldownKey, now);
          ruleSent++;
          totalSent++;
        } catch (err) {
          console.error(`[CampaignRules] Failed sending to ${email}:`, (err as Error).message);
        }
      }

      await db.collection("campaign_rules").doc(ruleId).update({
        ...(ruleSent > 0 ? { sentCount: admin.firestore.FieldValue.increment(ruleSent) } : {}),
        lastEvaluatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return totalSent;
  }

  async evaluateAllStudios(): Promise<number> {
    const db = getFirestore();
    const rulesSnap = await db.collection("campaign_rules").where("isActive", "==", true).get();
    const studioIds = new Set<string>();
    rulesSnap.forEach((doc) => {
      const sid = (doc.data() as Record<string, unknown>)["studioOwnerId"] as string;
      if (sid) studioIds.add(sid);
    });

    let total = 0;
    for (const studioOwnerId of studioIds) {
      try {
        total += await this.evaluateRulesForStudio(studioOwnerId);
      } catch (err) {
        console.error(`[CampaignRules] Error for studio ${studioOwnerId}:`, (err as Error).message);
      }
    }
    return total;
  }
}

export default new CampaignRulesService();
