const functions = require("firebase-functions");
const creditTrackingService = require("./services/credit-tracking.service");

/**
 * HTTP Cloud Function to expire credits
 * This can be called by Cloud Scheduler or manually
 * To set up Cloud Scheduler:
 * 1. Go to Cloud Scheduler in GCP Console
 * 2. Create a new job with:
 *    - Target: HTTP
 *    - URL: https://[region]-[project-id].cloudfunctions.net/expireCredits
 *    - Schedule: 0 2 * * * (daily at 2 AM UTC)
 *    - Timezone: UTC
 */
exports.expireCredits = functions.https.onRequest(async (req, res) => {
  console.log("[Credit Expiration] Starting scheduled credit expiration job");

  try {
    const result = await creditTrackingService.expireCredits();

    console.log("[Credit Expiration] Job completed successfully:", {
      totalExpired: result.totalExpired,
      affectedStudents: result.affectedStudents,
    });

    res.status(200).json({
      success: true,
      totalExpired: result.totalExpired,
      affectedStudents: result.affectedStudents,
    });
  } catch (error) {
    console.error("[Credit Expiration] Error during credit expiration:", error);
    console.error("[Credit Expiration] Error stack:", error.stack);
    
    // Return error but don't throw - we want the function to complete
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

