import { onSchedule } from "firebase-functions/v2/scheduler";
import retentionService from "../services/retention.service";
import campaignRulesService from "../services/campaign-rules.service";

export const retentionTriggers = onSchedule(
  { schedule: "0 8 * * *", timeZone: "UTC", memory: "512MiB" },
  async (_event) => {
    console.log("[RetentionTriggers] Starting daily retention email processing...");
    try {
      const [retentionResult, campaignSent] = await Promise.all([
        retentionService.processAllStudios(),
        campaignRulesService.evaluateAllStudios(),
      ]);
      console.log(
        `[RetentionTriggers] Done. Re-engagement: ${retentionResult.totalReEngagement}, Credit expiry: ${retentionResult.totalCreditExpiry}, Campaign rules: ${campaignSent}`,
      );
    } catch (err) {
      console.error("[RetentionTriggers] Fatal error:", err);
      throw err;
    }
  },
);
