import { onSchedule } from "firebase-functions/v2/scheduler";
import { runProactiveSuggestionsForAllStudios } from "../services/assistant.service";

export const copilotSuggestions = onSchedule(
  { schedule: "0 9 * * *", timeZone: "UTC", memory: "512MiB" },
  async (_event) => {
    console.log("[CopilotSuggestions] Starting daily proactive suggestion pass...");
    try {
      const { raisedCount } = await runProactiveSuggestionsForAllStudios();
      console.log(`[CopilotSuggestions] Done. Suggestions raised: ${raisedCount}`);
    } catch (err) {
      console.error("[CopilotSuggestions] Fatal error:", err);
      throw err;
    }
  },
);
