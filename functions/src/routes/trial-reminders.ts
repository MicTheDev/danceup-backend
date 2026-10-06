import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "../utils/firestore";
import { sendTrialEndingEmail } from "../services/sendgrid.service";

const REMINDER_THRESHOLDS: Array<{ days: number; field: string }> = [
  { days: 7, field: "trialReminder7dSentAt" },
  { days: 3, field: "trialReminder3dSentAt" },
  { days: 1, field: "trialReminder1dSentAt" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

// Single-field range query (stripeTrialEnd only) — filtered further in JS for the
// reminder-threshold/already-sent/converted logic, so this needs no composite index.
// Only ever matches accounts that have stripeTrialEnd set at all, i.e. accounts that
// registered after the trial feature shipped — pre-existing accounts are untouched.
export async function runTrialReminders(): Promise<void> {
  const db = getFirestore();
  const now = Date.now();
  const lookaheadCutoff = admin.firestore.Timestamp.fromMillis(now + 7 * DAY_MS);

  const snap = await db.collection("users").where("stripeTrialEnd", "<=", lookaheadCutoff).get();

  let remindersSent = 0;
  let trialsExpired = 0;

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const trialEnd = data["stripeTrialEnd"] as admin.firestore.Timestamp | undefined;
    if (!trialEnd) continue;

    // Already converted to a real paying subscription — nothing to remind or enforce.
    if (data["stripeSubscriptionStatus"] === "active") continue;

    const msRemaining = trialEnd.toMillis() - now;

    if (msRemaining <= 0) {
      if (data["subscriptionActive"] !== false) {
        try {
          await doc.ref.update({
            subscriptionActive: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          trialsExpired++;
        } catch (err) {
          console.error(`[trial-reminders] Failed to expire trial for user ${doc.id}:`, err);
        }
      }
      continue;
    }

    const daysRemaining = Math.ceil(msRemaining / DAY_MS);
    const threshold = REMINDER_THRESHOLDS.find((t) => t.days === daysRemaining);
    if (!threshold || data[threshold.field]) continue;

    const email = data["email"] as string | undefined;
    if (!email) continue;

    try {
      await sendTrialEndingEmail(
        email,
        (data["firstName"] as string) || "",
        (data["studioName"] as string) || "",
        threshold.days,
      );
      await doc.ref.update({
        [threshold.field]: admin.firestore.FieldValue.serverTimestamp(),
      });
      remindersSent++;
    } catch (err) {
      console.error(`[trial-reminders] Failed to send ${threshold.days}-day reminder to user ${doc.id}:`, err);
    }
  }

  console.log(`[trial-reminders] Completed: ${remindersSent} reminder(s) sent, ${trialsExpired} trial(s) expired.`);
}

export const trialReminders = onSchedule(
  { schedule: "0 9 * * *", timeZone: "UTC" },
  async (_event) => {
    console.log("[trial-reminders] Starting scheduled trial reminder job");
    try {
      await runTrialReminders();
    } catch (error) {
      console.error("[trial-reminders] Error during trial reminder job:", error);
      console.error("[trial-reminders] Error stack:", (error as Error).stack);
      throw error;
    }
  },
);
