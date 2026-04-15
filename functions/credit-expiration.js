const functions = require("firebase-functions");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const creditTrackingService = require("./services/credit-tracking.service");
const {verifyToken} = require("./utils/auth");
const admin = require("firebase-admin");

/**
 * Scheduled Cloud Function to expire credits.
 * Runs daily at 2:00 AM UTC via Firebase's built-in scheduler.
 * No Cloud Scheduler setup script required — Firebase handles the trigger with auth.
 *
 * To deploy: firebase deploy --only functions:expireCredits
 */
exports.expireCredits = onSchedule(
    {schedule: "0 2 * * *", timeZone: "UTC"},
    async (event) => {
      console.log("[Credit Expiration] Starting scheduled credit expiration job");

      try {
        const result = await creditTrackingService.expireCredits();

        console.log("[Credit Expiration] Job completed successfully:", {
          totalExpired: result.totalExpired,
          affectedStudents: result.affectedStudents,
        });
      } catch (error) {
        console.error("[Credit Expiration] Error during credit expiration:", error);
        console.error("[Credit Expiration] Error stack:", error.stack);
        // Re-throw so Firebase marks the invocation as failed and retries
        throw error;
      }
    }
);

/**
 * HTTP endpoint to manually trigger credit expiration (admin-only).
 * Requires a valid Firebase ID token with admin: true custom claim.
 */
exports.expireCreditsManual = functions.https.onRequest(async (req, res) => {
  // Verify the caller is authenticated
  let callerUid;
  try {
    const decoded = await verifyToken(req);
    callerUid = decoded.uid;
  } catch (authError) {
    res.status(authError.status || 401).json({
      success: false,
      error: authError.message || "Unauthorized",
    });
    return;
  }

  // Verify the caller has the admin custom claim
  try {
    const userRecord = await admin.auth().getUser(callerUid);
    const claims = userRecord.customClaims || {};
    if (!claims.admin) {
      res.status(403).json({
        success: false,
        error: "Forbidden — admin role required",
      });
      return;
    }
  } catch (claimError) {
    res.status(500).json({
      success: false,
      error: "Failed to verify user permissions",
    });
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
    console.error("[Credit Expiration] Error during manual expiration:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
