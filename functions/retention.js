const {onSchedule} = require("firebase-functions/v2/scheduler");
const retentionService = require("./services/retention.service");

/**
 * Scheduled function that runs daily at 8 AM UTC.
 * Sends re-engagement emails to at-risk students and
 * credit expiry warnings to students with expiring credits.
 */
exports.retentionTriggers = onSchedule(
    {
      schedule: "0 8 * * *",
      timeZone: "UTC",
      memory: "512MiB",
    },
    async (event) => {
      console.log("[RetentionTriggers] Starting daily retention email processing...");
      try {
        const result = await retentionService.processAllStudios();
        console.log(
            `[RetentionTriggers] Done. Re-engagement emails sent: ${result.totalReEngagement}, ` +
            `Credit expiry emails sent: ${result.totalCreditExpiry}`,
        );
      } catch (err) {
        console.error("[RetentionTriggers] Fatal error:", err);
        throw err;
      }
    },
);
