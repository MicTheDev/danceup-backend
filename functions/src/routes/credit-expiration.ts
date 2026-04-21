import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import creditTrackingService from "../services/credit-tracking.service";
import { verifyToken } from "../utils/auth";

export async function runCreditExpiration(): Promise<void> {
  const result = await creditTrackingService.expireCredits();
  console.log("[Credit Expiration] Job completed successfully:", {
    totalExpired: result.totalExpired,
    affectedStudents: result.affectedStudents,
  });
}

export const expireCredits = onSchedule(
  { schedule: "0 2 * * *", timeZone: "UTC" },
  async (_event) => {
    console.log("[Credit Expiration] Starting scheduled credit expiration job");
    try {
      await runCreditExpiration();
    } catch (error) {
      console.error("[Credit Expiration] Error during credit expiration:", error);
      console.error("[Credit Expiration] Error stack:", (error as Error).stack);
      throw error;
    }
  },
);

export const expireCreditsManual = functions.https.onRequest(async (req, res) => {
  let callerUid: string;
  try {
    const decoded = await verifyToken(req);
    callerUid = decoded.uid;
  } catch (authError) {
    const err = authError as { status?: number; message?: string };
    res.status(err.status ?? 401).json({ success: false, error: err.message ?? "Unauthorized" });
    return;
  }

  try {
    const userRecord = await admin.auth().getUser(callerUid);
    const claims = (userRecord.customClaims ?? {}) as Record<string, unknown>;
    if (!claims["admin"]) {
      res.status(403).json({ success: false, error: "Forbidden — admin role required" });
      return;
    }
  } catch {
    res.status(500).json({ success: false, error: "Failed to verify user permissions" });
    return;
  }

  console.log("[Credit Expiration] Manual trigger started by admin:", callerUid);

  try {
    const result = await creditTrackingService.expireCredits();
    console.log("[Credit Expiration] Manual run completed:", {
      totalExpired: result.totalExpired,
      affectedStudents: result.affectedStudents,
    });
    res.status(200).json({
      success: true,
      totalExpired: result.totalExpired,
      affectedStudents: result.affectedStudents,
    });
  } catch (error) {
    console.error("[Credit Expiration] Error during manual expiration:", (error as Error).message);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});
