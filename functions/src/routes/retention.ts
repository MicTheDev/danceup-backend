import { onSchedule } from "firebase-functions/v2/scheduler";
import retentionService from "../services/retention.service";
import campaignRulesService from "../services/campaign-rules.service";
import attendanceService from "../services/attendance.service";

export const retentionTriggers = onSchedule(
  { schedule: "0 8 * * *", timeZone: "UTC", memory: "512MiB" },
  async (_event) => {
    console.log("[RetentionTriggers] Starting daily retention email processing...");
    try {
      const [retentionResult, campaignSent, lowEnrollmentNotified] = await Promise.all([
        retentionService.processAllStudios(),
        campaignRulesService.evaluateAllStudios(),
        attendanceService.notifyUnderEnrolledClassesForAllStudios(),
      ]);
      console.log(
        `[RetentionTriggers] Done. Re-engagement: ${retentionResult.totalReEngagement}, Credit expiry: ${retentionResult.totalCreditExpiry}, Campaign rules: ${campaignSent}, Low enrollment: ${lowEnrollmentNotified}`,
      );
    } catch (err) {
      console.error("[RetentionTriggers] Fatal error:", err);
      throw err;
    }
  },
);
