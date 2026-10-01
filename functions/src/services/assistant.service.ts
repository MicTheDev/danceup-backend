import * as admin from "firebase-admin";
import {
  GoogleGenerativeAI,
  SchemaType,
  FunctionCallingMode,
  type FunctionDeclaration,
  type FunctionDeclarationSchemaProperty,
  type Content,
  type Part,
} from "@google/generative-ai";
import { getFirestore } from "../utils/firestore";
import { getSecret } from "../utils/secret-manager";
import classesService from "./classes.service";
import packagesService from "./packages.service";
import instructorsService from "./instructors.service";
import eventsService from "./events.service";
import workshopsService from "./workshops.service";
import notificationsService from "./notifications.service";
import campaignRulesService, { TriggerType, ActionType } from "./campaign-rules.service";
import * as marketingService from "./marketing.service";
import * as aiService from "./ai.service";
import * as insightsService from "./insights.service";
import * as insightsDataService from "./insights-data.service";
import { sendCopilotSuggestionEmail } from "./sendgrid.service";
import { sendStudioOwnerPush } from "../utils/push-notifications";
import {
  validateCreateClassPayload,
  validateUpdateClassPayload,
  validateUpdatePackagePayload,
  validateCreateEventPayload,
  validateUpdateEventPayload,
  validateCreateWorkshopPayload,
  validateUpdateWorkshopPayload,
} from "../utils/validation";
import { logAuditEvent } from "./audit.service";

const MESSAGES_COLLECTION = "assistantMessages";
const PROPOSALS_COLLECTION = "assistantProposals";
const MAX_TOOL_ITERATIONS = 5;
const MAX_HISTORY_MESSAGES = 40;
const MODEL_NAME = "gemini-3.6-flash";

export type AssistantRole = "user" | "model" | "system";
export type ProposalActionType =
  | "email_campaign" | "automation_rule" | "class_create" | "class_update" | "package_update"
  | "event_create" | "event_update" | "workshop_create" | "workshop_update" | "class_bulk_import";
export type ProposalStatus = "pending" | "approved" | "rejected";

export interface AssistantMessage {
  id: string;
  studioOwnerId: string;
  role: AssistantRole;
  text: string;
  proposedActionIds?: string[];
  createdAt: string | null;
}

export interface AssistantProposal {
  id: string;
  studioOwnerId: string;
  actionType: ProposalActionType;
  payload: Record<string, unknown>;
  status: ProposalStatus;
  summary: string;
  reasoning?: string;
  createdAt: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string;
  resultResourceId?: string;
}

// ─── Gemini client ──────────────────────────────────────────────────────────

let cachedClient: GoogleGenerativeAI | null = null;

async function getClient(): Promise<GoogleGenerativeAI> {
  if (cachedClient) return cachedClient;
  const apiKey = await getSecret("gemini-api-key");
  if (!apiKey || !apiKey.trim()) {
    throw new Error("Gemini API key not found in Secret Manager. Add a secret named 'gemini-api-key'.");
  }
  cachedClient = new GoogleGenerativeAI(apiKey.trim());
  return cachedClient;
}

// ─── Tool declarations ──────────────────────────────────────────────────────

const EMPTY_PARAMS = { type: SchemaType.OBJECT, properties: {}, required: [] };

const READ_TOOLS: FunctionDeclaration[] = [
  {
    name: "get_schedule",
    description: "Get the studio's current class schedule: name, level, day/time, cost, dance genre, active status, and instructor IDs for every class.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_packages",
    description: "Get the studio's current pricing packages: name, price, credits, expiration, active/recurring status.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_instructors",
    description: "Get the studio's instructors with their IDs and names. Call this before drafting a new class so you know valid instructorIds.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_automation_rules",
    description: "Get the studio's existing automation rules (trigger/action pairs), so you don't propose a duplicate.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_engagement_summary",
    description: "Get aggregate student engagement stats (at-risk count, active-this-month count, average check-ins). Does not include individual student names.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_studio_insights",
    description: "Get dashboard stats and the top classes by attendance for the studio.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_events",
    description: "Get the studio's events (socials, festivals, congresses, competitions, recitals, showcases): name, type, start/end time, location, and price tiers.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_workshops",
    description: "Get the studio's workshops: name, levels, start/end time, location, and price tiers.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_pending_proposals",
    description: "Get the studio owner's currently pending (not yet approved or discarded) draft proposals, with their id, actionType, summary, and current payload. Call this before revising a proposal the user is referring to (e.g. 'change that to Friday instead'), so you can pass its id back to the matching draft_* tool.",
    parameters: EMPTY_PARAMS,
  },
];

// Only declared to the model for Pro+ studios (see runTurn) — these wrap the same AI Insights
// engine (ai.service.ts) that powers the separate, Pro+-gated /analytics/ai-insights page, via
// the shared data-assembly functions in insights-data.service.ts.
const PRO_PLUS_READ_TOOLS: FunctionDeclaration[] = [
  {
    name: "get_income_goal_progress",
    description: "Get the studio owner's annual revenue goal (if they've set one in Settings) and their actual revenue so far this calendar year, so you can tell them what percent of the way there they are and how much time is left in the year. If no goal is set, tell them and suggest setting one in Settings — don't draft anything for this.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_revenue_forecast",
    description: "Get an AI-generated forecast of next month's revenue based on the last 6 months of purchase history (Stripe + cash), with a low/mid/high range, key drivers, and risks.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_class_demand_analysis",
    description: "Get a per-class demand analysis (thriving / healthy / needs_attention / at_risk) based on fill rates over the last 30 days, with a recommended action for each class.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_promo_trigger_suggestions",
    description: "Get specific promo suggestions (with urgency) for classes that have had a fill rate under 40% in at least 2 of the last 4 weeks.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_schedule_health",
    description: "Get an assessment of the studio's overall schedule health — day/time coverage gaps, genre/level diversity, strengths, and recommendations.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_automation_rule_suggestions",
    description: "Get 2-4 AI-suggested automation rules tailored to this studio's actual engagement data (at-risk students, unused credits, never-attended signups), excluding rules that already exist. Follow up with draft_automation_rule to formalize one.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_student_ltv_insights",
    description: "Get student lifetime-value analysis: average LTV, top students by total spend, and AI commentary on LTV health.",
    parameters: EMPTY_PARAMS,
  },
  {
    name: "get_instructor_performance",
    description: "Get per-instructor performance summaries: classes taught, check-ins, average fill rate, and average review rating.",
    parameters: EMPTY_PARAMS,
  },
];

const EMAIL_TONES = ["promotional", "informational", "community"] as const;
const TRIGGER_TYPES: TriggerType[] = ["inactive_days", "credits_expiring_days", "signup_no_attend", "milestone_checkins", "first_class_attended", "credits_depleted", "review_request_days"];
const ACTION_TYPES: ActionType[] = ["re_engagement_email", "credit_reminder_email", "milestone_email", "signup_nudge_email", "first_class_email", "credits_depleted_email", "review_request_email"];
const CLASS_LEVELS = ["Beginner", "Intermediate", "Advanced", "All Levels"];
const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const EVENT_TYPES = ["social", "festival", "congress", "competition", "recital", "showcase"];
const WORKSHOP_LEVELS = ["beginner", "intermediate", "advanced"];

const PRICE_TIERS_PROPERTY: FunctionDeclarationSchemaProperty = {
  type: SchemaType.ARRAY,
  description: "At least one price tier. Keep it to a single tier (e.g. General Admission) unless the studio owner specifically asks for more.",
  items: {
    type: SchemaType.OBJECT,
    properties: {
      name: { type: SchemaType.STRING, description: "e.g. 'General Admission'." },
      price: { type: SchemaType.NUMBER, description: "Face price the studio keeps, in dollars." },
    },
    required: ["name", "price"],
  },
};

const PROPOSAL_ID_PROPERTY = {
  type: SchemaType.STRING,
  description: "If revising an existing pending proposal (its id comes from get_pending_proposals), pass that id here instead of creating a new one. Omit to create a brand-new proposal.",
} as const;

const REASONING_PROPERTY = {
  type: SchemaType.STRING,
  description: "One sentence citing the SPECIFIC data behind this draft (real numbers, names, or dates from a tool you called — e.g. '6 students haven't attended in 21+ days' or 'this class has averaged 18% fill rate over the last 4 weeks'). Never a generic reason like 'to help engagement.' Shown to the studio owner alongside the draft.",
} as const;

const DRAFT_TOOLS: FunctionDeclaration[] = [
  {
    name: "draft_email_campaign",
    description: "Draft a marketing email campaign for the studio owner to review and approve before it is sent to subscribed students. Never claim the email has been sent.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        tone: { type: SchemaType.STRING, enum: [...EMAIL_TONES], description: "Overall tone of the email." },
        instructions: { type: SchemaType.STRING, description: "Specific instructions from the studio owner about what the email should include." },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["tone", "reasoning"],
    },
  },
  {
    name: "draft_automation_rule",
    description: "Draft a new automation rule (a trigger paired with an email action) for the studio owner to review and approve. Never claim the rule has been created.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING, description: "A short human-readable name for the rule." },
        triggerType: { type: SchemaType.STRING, enum: TRIGGER_TYPES, description: "What condition fires this rule." },
        triggerValue: { type: SchemaType.NUMBER, description: "The numeric threshold for the trigger (e.g. days inactive, check-in count)." },
        actionType: { type: SchemaType.STRING, enum: ACTION_TYPES, description: "Which email gets sent when the rule fires." },
        cooldownDays: { type: SchemaType.NUMBER, description: "Minimum days between repeated sends to the same student. Defaults to 30 if omitted." },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["name", "triggerType", "triggerValue", "actionType", "reasoning"],
    },
  },
  {
    name: "draft_create_class",
    description: "Draft a brand-new class for the studio owner to review and approve. Never claim the class has been created. Call get_instructors first to get valid instructorIds.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING },
        level: { type: SchemaType.STRING, enum: CLASS_LEVELS },
        dayOfWeek: { type: SchemaType.STRING, enum: DAYS_OF_WEEK },
        startTime: { type: SchemaType.STRING, description: "24-hour HH:mm, e.g. '19:00'." },
        endTime: { type: SchemaType.STRING, description: "24-hour HH:mm, e.g. '20:00'." },
        instructorIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "Instructor doc IDs from get_instructors." },
        isActive: { type: SchemaType.BOOLEAN },
        cost: { type: SchemaType.NUMBER },
        room: { type: SchemaType.STRING },
        description: { type: SchemaType.STRING },
        danceGenre: { type: SchemaType.STRING },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["name", "level", "dayOfWeek", "startTime", "endTime", "instructorIds", "isActive", "reasoning"],
    },
  },
  {
    name: "draft_update_class",
    description: "Draft an update to an existing class for the studio owner to review and approve. Never claim the class has been updated. Call get_schedule first to get the classId.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        classId: { type: SchemaType.STRING, description: "The class doc ID from get_schedule." },
        name: { type: SchemaType.STRING },
        level: { type: SchemaType.STRING, enum: CLASS_LEVELS },
        dayOfWeek: { type: SchemaType.STRING, enum: DAYS_OF_WEEK },
        startTime: { type: SchemaType.STRING },
        endTime: { type: SchemaType.STRING },
        instructorIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        isActive: { type: SchemaType.BOOLEAN },
        cost: { type: SchemaType.NUMBER },
        room: { type: SchemaType.STRING },
        description: { type: SchemaType.STRING },
        danceGenre: { type: SchemaType.STRING },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["classId", "reasoning"],
    },
  },
  {
    name: "draft_update_package",
    description: "Draft a price/credits/expiration update to an existing package for the studio owner to review and approve. Never claim the package has been updated. Call get_packages first to get the packageId.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        packageId: { type: SchemaType.STRING, description: "The package doc ID from get_packages." },
        price: { type: SchemaType.NUMBER },
        credits: { type: SchemaType.NUMBER },
        expirationDays: { type: SchemaType.NUMBER },
        isActive: { type: SchemaType.BOOLEAN },
        description: { type: SchemaType.STRING },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["packageId", "reasoning"],
    },
  },
  {
    name: "draft_create_event",
    description: "Draft a brand-new event (social, festival, congress, competition, recital, or showcase) for the studio owner to review and approve. Never claim the event has been created.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING },
        type: { type: SchemaType.STRING, enum: EVENT_TYPES },
        startTime: { type: SchemaType.STRING, description: "ISO 8601 datetime, e.g. '2026-10-04T19:00:00.000Z'." },
        endTime: { type: SchemaType.STRING, description: "ISO 8601 datetime, optional." },
        priceTiers: PRICE_TIERS_PROPERTY,
        addressLine1: { type: SchemaType.STRING },
        city: { type: SchemaType.STRING },
        state: { type: SchemaType.STRING, description: "2-letter state code." },
        zip: { type: SchemaType.STRING },
        description: { type: SchemaType.STRING },
        danceGenre: { type: SchemaType.STRING },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["name", "type", "startTime", "priceTiers", "addressLine1", "city", "state", "zip", "reasoning"],
    },
  },
  {
    name: "draft_update_event",
    description: "Draft an update to an existing event for the studio owner to review and approve. Never claim the event has been updated. Call get_events first to get the eventId.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        eventId: { type: SchemaType.STRING, description: "The event doc ID from get_events." },
        name: { type: SchemaType.STRING },
        type: { type: SchemaType.STRING, enum: EVENT_TYPES },
        startTime: { type: SchemaType.STRING },
        endTime: { type: SchemaType.STRING },
        priceTiers: PRICE_TIERS_PROPERTY,
        addressLine1: { type: SchemaType.STRING },
        city: { type: SchemaType.STRING },
        state: { type: SchemaType.STRING },
        zip: { type: SchemaType.STRING },
        description: { type: SchemaType.STRING },
        danceGenre: { type: SchemaType.STRING },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["eventId", "reasoning"],
    },
  },
  {
    name: "draft_create_workshop",
    description: "Draft a brand-new workshop for the studio owner to review and approve. Never claim the workshop has been created.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING },
        levels: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING, enum: WORKSHOP_LEVELS } },
        startTime: { type: SchemaType.STRING, description: "ISO 8601 datetime." },
        endTime: { type: SchemaType.STRING, description: "ISO 8601 datetime." },
        priceTiers: PRICE_TIERS_PROPERTY,
        addressLine1: { type: SchemaType.STRING },
        city: { type: SchemaType.STRING },
        state: { type: SchemaType.STRING, description: "2-letter state code." },
        zip: { type: SchemaType.STRING },
        description: { type: SchemaType.STRING },
        danceGenre: { type: SchemaType.STRING },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["name", "levels", "startTime", "endTime", "priceTiers", "addressLine1", "city", "state", "zip", "reasoning"],
    },
  },
  {
    name: "draft_update_workshop",
    description: "Draft an update to an existing workshop for the studio owner to review and approve. Never claim the workshop has been updated. Call get_workshops first to get the workshopId.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        workshopId: { type: SchemaType.STRING, description: "The workshop doc ID from get_workshops." },
        name: { type: SchemaType.STRING },
        levels: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING, enum: WORKSHOP_LEVELS } },
        startTime: { type: SchemaType.STRING },
        endTime: { type: SchemaType.STRING },
        priceTiers: PRICE_TIERS_PROPERTY,
        addressLine1: { type: SchemaType.STRING },
        city: { type: SchemaType.STRING },
        state: { type: SchemaType.STRING },
        zip: { type: SchemaType.STRING },
        description: { type: SchemaType.STRING },
        danceGenre: { type: SchemaType.STRING },
        proposalId: PROPOSAL_ID_PROPERTY,
        reasoning: REASONING_PROPERTY,
      },
      required: ["workshopId", "reasoning"],
    },
  },
  {
    name: "draft_bulk_import_classes",
    description: "Draft a bulk import of multiple classes at once from a studio owner's uploaded spreadsheet, for review and approval as a single proposal. Never claim any class has been created. Pass instructor as the free-text name you see in the spreadsheet, not an ID — the backend resolves it against the studio's real instructors (call get_instructors first if you want to sanity-check names yourself, but resolution also happens server-side).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        classes: {
          type: SchemaType.ARRAY,
          description: "One entry per spreadsheet row.",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              name: { type: SchemaType.STRING },
              level: { type: SchemaType.STRING, description: "e.g. Beginner, Intermediate, Advanced, All Levels — will be normalized case-insensitively." },
              dayOfWeek: { type: SchemaType.STRING, description: "e.g. Monday — will be normalized case-insensitively." },
              startTime: { type: SchemaType.STRING, description: "24-hour HH:mm." },
              endTime: { type: SchemaType.STRING, description: "24-hour HH:mm." },
              instructorName: { type: SchemaType.STRING, description: "Instructor's name as it appears in the spreadsheet, e.g. 'Sarah M.' — resolved server-side against real instructors." },
              cost: { type: SchemaType.NUMBER },
              room: { type: SchemaType.STRING },
              danceGenre: { type: SchemaType.STRING },
              description: { type: SchemaType.STRING },
            },
            required: ["name", "level", "dayOfWeek", "startTime", "endTime"],
          },
        },
        reasoning: REASONING_PROPERTY,
      },
      required: ["classes", "reasoning"],
    },
  },
];

const DRAFT_TOOL_NAMES = new Set(DRAFT_TOOLS.map((t) => t.name));

// ─── Firestore helpers ──────────────────────────────────────────────────────

function tsToIso(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === "object" && val !== null && "toDate" in val) {
    return (val as { toDate(): Date }).toDate().toISOString();
  }
  return null;
}

interface StudioOwnerContact {
  studioName: string;
  email: string;
  firstName: string;
  isProPlus: boolean;
  annualRevenueGoal: number | null;
}

const PRO_PLUS_MEMBERSHIP = "studio_owner_pro_plus";

async function getStudioOwnerContact(studioOwnerId: string): Promise<StudioOwnerContact> {
  const db = getFirestore();
  const doc = await db.collection("users").doc(studioOwnerId).get();
  const data = (doc.exists ? doc.data() : {}) as Record<string, unknown>;
  return {
    studioName: (data["studioName"] as string) || "Your Studio",
    email: (data["email"] as string) || "",
    firstName: (data["firstName"] as string) || "",
    isProPlus: data["membership"] === PRO_PLUS_MEMBERSHIP,
    annualRevenueGoal: typeof data["annualRevenueGoal"] === "number" ? (data["annualRevenueGoal"] as number) : null,
  };
}

function studioOwnerAssistantUrl(): string {
  const baseUrl = process.env["STUDIO_OWNER_APP_URL"] || "https://studios.danceup.app";
  return `${baseUrl}/dashboard/assistant`;
}

type IncomeGoalProgress =
  | { goalSet: false }
  | {
      goalSet: true;
      annualRevenueGoal: number;
      revenueToDate: number;
      percentComplete: number;
      daysElapsedInYear: number;
      daysRemainingInYear: number;
    };

// Shared by the get_income_goal_progress read tool and the proactive digest's goal-aware
// urgency (Feature C) — kept as one function so both always agree on the same numbers.
async function buildIncomeGoalProgress(studioOwnerId: string, annualRevenueGoal: number | null): Promise<IncomeGoalProgress> {
  if (annualRevenueGoal == null) return { goalSet: false };

  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const nextJan1 = new Date(now.getFullYear() + 1, 0, 1);

  const monthlyRevenue = await insightsDataService.getMonthlyRevenueSince(studioOwnerId, jan1);
  const revenueToDate = Math.round(monthlyRevenue.reduce((sum, m) => sum + m.revenue, 0) * 100) / 100;

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysElapsedInYear = Math.max(1, Math.round((now.getTime() - jan1.getTime()) / msPerDay));
  const daysRemainingInYear = Math.max(0, Math.round((nextJan1.getTime() - now.getTime()) / msPerDay));
  const percentComplete = annualRevenueGoal > 0 ? Math.round((revenueToDate / annualRevenueGoal) * 1000) / 10 : 0;

  return { goalSet: true, annualRevenueGoal, revenueToDate, percentComplete, daysElapsedInYear, daysRemainingInYear };
}

async function persistMessage(
  studioOwnerId: string,
  role: AssistantRole,
  text: string,
  proposedActionIds?: string[],
): Promise<void> {
  const db = getFirestore();
  const doc: Record<string, unknown> = {
    studioOwnerId,
    role,
    text,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (proposedActionIds && proposedActionIds.length > 0) doc["proposedActionIds"] = proposedActionIds;
  await db.collection(MESSAGES_COLLECTION).add(doc);
}

interface LoadMessagesOptions {
  order?: "asc" | "desc";
  limit?: number;
}

async function loadMessages(
  studioOwnerId: string, options: LoadMessagesOptions = {},
): Promise<AssistantMessage[]> {
  const { order = "asc", limit } = options;
  const db = getFirestore();
  let query = db.collection(MESSAGES_COLLECTION)
    .where("studioOwnerId", "==", studioOwnerId)
    .orderBy("createdAt", order) as FirebaseFirestore.Query;
  if (limit) {
    query = query.limit(limit);
  }
  const snap = await query.get();
  const messages = snap.docs.map((doc) => {
    const d = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      studioOwnerId,
      role: d["role"] as AssistantRole,
      text: d["text"] as string,
      proposedActionIds: d["proposedActionIds"] as string[] | undefined,
      createdAt: tsToIso(d["createdAt"]),
    };
  });
  // A "desc" fetch is used to cheaply grab the most recent N messages —
  // reverse back to chronological order so callers always get oldest-first.
  return order === "desc" ? messages.reverse() : messages;
}

function hydrateProposal(doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot): AssistantProposal {
  const d = doc.data() as Record<string, unknown>;
  return {
    id: doc.id,
    studioOwnerId: d["studioOwnerId"] as string,
    actionType: d["actionType"] as ProposalActionType,
    payload: d["payload"] as Record<string, unknown>,
    status: d["status"] as ProposalStatus,
    summary: d["summary"] as string,
    reasoning: d["reasoning"] as string | undefined,
    createdAt: tsToIso(d["createdAt"]),
    resolvedAt: tsToIso(d["resolvedAt"]),
    resolvedBy: d["resolvedBy"] as string | undefined,
    resultResourceId: d["resultResourceId"] as string | undefined,
  };
}

async function loadPendingProposals(studioOwnerId: string): Promise<AssistantProposal[]> {
  const db = getFirestore();
  const snap = await db.collection(PROPOSALS_COLLECTION)
    .where("studioOwnerId", "==", studioOwnerId)
    .where("status", "==", "pending")
    .get();
  return snap.docs.map(hydrateProposal);
}

export async function getHistory(studioOwnerId: string): Promise<{ messages: AssistantMessage[]; pendingProposals: AssistantProposal[] }> {
  const [messages, pendingProposals] = await Promise.all([
    loadMessages(studioOwnerId),
    loadPendingProposals(studioOwnerId),
  ]);
  return { messages, pendingProposals };
}

// ─── Read tool execution (safe, no writes) ──────────────────────────────────

async function executeReadTool(name: string, studioOwnerId: string): Promise<unknown> {
  switch (name) {
    case "get_schedule": {
      const classes = await classesService.getClasses(studioOwnerId);
      return classes.map((c) => ({
        id: c["id"], name: c["name"], level: c["level"], dayOfWeek: c["dayOfWeek"],
        startTime: c["startTime"], endTime: c["endTime"], cost: c["cost"],
        danceGenre: c["danceGenre"], isActive: c["isActive"], instructorIds: c["instructorIds"],
      }));
    }
    case "get_packages": {
      const packages = await packagesService.getPackages(studioOwnerId);
      return packages.map((p) => ({
        id: p["id"], name: p["name"], price: p["price"], credits: p["credits"],
        expirationDays: p["expirationDays"], isActive: p["isActive"], isRecurring: p["isRecurring"],
      }));
    }
    case "get_instructors": {
      const instructors = await instructorsService.getInstructors(studioOwnerId);
      return instructors.map((i) => ({
        id: i["id"],
        name: `${(i["firstName"] as string) || ""} ${(i["lastName"] as string) || ""}`.trim(),
      }));
    }
    case "get_automation_rules": {
      const rules = await campaignRulesService.getRules(studioOwnerId);
      return rules.map((r) => ({
        id: r.id, name: r.name, triggerType: r.triggerType, triggerValue: r.triggerValue,
        actionType: r.actionType, cooldownDays: r.cooldownDays, isActive: r.isActive, sentCount: r.sentCount,
      }));
    }
    case "get_engagement_summary": {
      const { stats } = await insightsService.getEngagementData(studioOwnerId);
      return { stats };
    }
    case "get_studio_insights": {
      const { studioName, dashboardStats, topClasses } = await insightsService.getInsightsData(studioOwnerId);
      return { studioName, dashboardStats, topClasses };
    }
    case "get_events": {
      const events = await eventsService.getEvents(studioOwnerId);
      return events.map((e) => ({
        id: e["id"], name: e["name"], type: e["type"], startTime: e["startTime"], endTime: e["endTime"],
        city: e["city"], state: e["state"], priceTiers: e["priceTiers"],
      }));
    }
    case "get_workshops": {
      const workshops = await workshopsService.getWorkshops(studioOwnerId);
      return workshops.map((w) => ({
        id: w["id"], name: w["name"], levels: w["levels"], startTime: w["startTime"], endTime: w["endTime"],
        city: w["city"], state: w["state"], priceTiers: w["priceTiers"],
      }));
    }
    case "get_pending_proposals": {
      const proposals = await loadPendingProposals(studioOwnerId);
      return proposals.map((p) => ({
        id: p.id, actionType: p.actionType, summary: p.summary, reasoning: p.reasoning, payload: p.payload,
      }));
    }
    case "get_income_goal_progress": {
      const contact = await getStudioOwnerContact(studioOwnerId);
      return buildIncomeGoalProgress(studioOwnerId, contact.annualRevenueGoal);
    }
    case "get_revenue_forecast": {
      const input = await insightsDataService.buildRevenueForecastInput(studioOwnerId);
      if (!input) return { available: false, message: "No purchase history is available yet." };
      const forecast = await aiService.generateRevenueForecast(input);
      return { available: true, ...forecast };
    }
    case "get_class_demand_analysis": {
      const input = await insightsDataService.buildClassDemandInput(studioOwnerId);
      if (!input) return { available: false, message: "No active classes found." };
      const result = await aiService.generateClassDemandAnalysis(input as unknown as Parameters<typeof aiService.generateClassDemandAnalysis>[0]);
      return { available: true, ...result };
    }
    case "get_promo_trigger_suggestions": {
      const input = await insightsDataService.buildPromoTriggerInput(studioOwnerId);
      if (!input) return { available: false, message: "No underperforming classes detected — all classes have healthy fill rates." };
      const { triggers } = await aiService.generatePromoTriggerSuggestions(input) as {
        triggers: Array<{ classId: string; suggestion: string; urgency: "high" | "medium" | "low" }>;
      };
      const enriched = triggers.map((t) => ({ ...t, ...(input.underperformingClasses.find((c) => c.classId === t.classId) || {}) }));
      return { available: true, triggers: enriched };
    }
    case "get_schedule_health": {
      const input = await insightsDataService.buildScheduleHealthInput(studioOwnerId);
      const result = await aiService.generateScheduleHealth(input);
      return { available: true, ...result };
    }
    case "get_automation_rule_suggestions": {
      const [rules, engagementData] = await Promise.all([
        campaignRulesService.getRules(studioOwnerId),
        insightsService.getEngagementData(studioOwnerId) as unknown as Promise<{
          atRisk: Array<{ daysSinceAttendance: number | null; neverAttended?: boolean }>;
          stats: { totalStudents: number; atRiskCount: number; studentsWithCredits: number };
        }>,
      ]);
      const existingRules = rules.map((r) => ({ name: r.name, triggerType: r.triggerType, actionType: r.actionType }));
      const { atRisk, stats } = engagementData;
      const studentsNeverAttended = atRisk?.filter((s) => s.daysSinceAttendance == null || s.neverAttended).length ?? 0;
      const daysList = atRisk?.map((s) => s.daysSinceAttendance).filter((d): d is number => d != null) ?? [];
      const avgDaysSinceAttendance = daysList.length > 0 ? daysList.reduce((a, b) => a + b, 0) / daysList.length : null;
      const contact = await getStudioOwnerContact(studioOwnerId);
      const result = await aiService.generateAutomationSuggestions({
        studioName: contact.studioName, existingRules,
        atRiskStudentCount: stats?.atRiskCount ?? 0, totalStudents: stats?.totalStudents ?? 0,
        studentsWithCredits: stats?.studentsWithCredits ?? 0, studentsNeverAttended, avgDaysSinceAttendance,
      });
      return { available: true, ...result };
    }
    case "get_student_ltv_insights": {
      const input = await insightsDataService.buildStudentLTVInput(studioOwnerId);
      if (!input) return { available: false, message: "No student data available yet." };
      const result = await aiService.generateStudentLTVInsights({
        studioName: input.studioName, topStudents: input.topStudents, avgLTV: input.avgLTV, totalStudents: input.totalStudents,
      });
      return { available: true, avgLTV: input.avgLTV, totalStudents: input.totalStudents, ...result };
    }
    case "get_instructor_performance": {
      const input = await insightsDataService.buildInstructorPerformanceInput(studioOwnerId);
      if (!input) return { available: false, message: "No instructor data available yet." };
      const result = await aiService.generateInstructorPerformance(input as unknown as Parameters<typeof aiService.generateInstructorPerformance>[0]);
      return { available: true, ...result };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Draft tool -> proposal preparation (never writes) ─────────────────────

type DraftResult =
  | { valid: true; payload: Record<string, unknown>; summary: string; reasoning?: string; revisedProposalId?: string }
  | { valid: false; errors: Array<{ field: string; message: string }> };

// When a draft_* tool call carries a proposalId, this loads the pending proposal it's
// revising (verifying ownership/status/actionType via the existing getProposalOrThrow
// guard, reused as-is) so its payload can be merged under the caller's new args — this
// way the model can send just the changed field(s) rather than the whole payload again.
async function resolvePendingProposalPayload(
  studioOwnerId: string,
  proposalId: string,
  expectedActionType: ProposalActionType,
): Promise<{ payload: Record<string, unknown> } | { error: string }> {
  try {
    const { data } = await getProposalOrThrow(studioOwnerId, proposalId);
    if (data.actionType !== expectedActionType) {
      return { error: `That proposal is a ${data.actionType}, not a ${expectedActionType} — call get_pending_proposals to find the right id.` };
    }
    return { payload: data.payload };
  } catch (err) {
    return { error: (err as Error).message || "Proposal not found." };
  }
}

async function prepareDraftProposal(
  toolName: string,
  args: Record<string, unknown>,
  studioOwnerId: string,
): Promise<DraftResult> {
  const proposalIdRaw = args["proposalId"];
  const revisedProposalId = typeof proposalIdRaw === "string" && proposalIdRaw.trim() ? proposalIdRaw.trim() : undefined;
  const { proposalId: _omitProposalId, ...argsWithoutProposalId } = args;

  let mergedArgs: Record<string, unknown> = argsWithoutProposalId;
  if (revisedProposalId) {
    const expectedActionType = TOOL_NAME_TO_ACTION_TYPE[toolName];
    const resolved = await resolvePendingProposalPayload(studioOwnerId, revisedProposalId, expectedActionType as ProposalActionType);
    if ("error" in resolved) return { valid: false, errors: [{ field: "proposalId", message: resolved.error }] };
    mergedArgs = { ...resolved.payload, ...argsWithoutProposalId };
  }
  // Pulled out here (not left in args_) so it never accidentally gets spread into a
  // create/update payload that's later written straight into a class/event/workshop doc —
  // reasoning is metadata about the PROPOSAL, not a field of the thing being created.
  const reasoningRaw = mergedArgs["reasoning"];
  const reasoning = typeof reasoningRaw === "string" && reasoningRaw.trim() ? reasoningRaw.trim() : undefined;
  const { reasoning: _omitReasoning, ...argsWithoutReasoning } = mergedArgs;
  const args_ = argsWithoutReasoning;

  switch (toolName) {
    case "draft_email_campaign": {
      const tone = typeof args_["tone"] === "string" && (EMAIL_TONES as readonly string[]).includes(args_["tone"] as string)
        ? (args_["tone"] as string)
        : "community";
      const instructions = typeof args_["instructions"] === "string" ? args_["instructions"].slice(0, 500) : undefined;

      const { studioName, classes, events, workshops } = await marketingService.getStudioContentForAI(studioOwnerId, {});
      const { subject, htmlBody } = await aiService.generateEmailCampaign({
        studioName, studioOwnerId, classes, events, workshops, tone, instructions,
      });

      return {
        valid: true,
        payload: { subject, bodyHtml: htmlBody, sendToAll: true } as Record<string, unknown>,
        summary: `Email: "${subject}"`,
        reasoning,
        revisedProposalId,
      };
    }

    case "draft_automation_rule": {
      const errors: Array<{ field: string; message: string }> = [];
      const name = typeof args_["name"] === "string" ? args_["name"].trim() : "";
      if (!name) errors.push({ field: "name", message: "name is required" });
      if (!TRIGGER_TYPES.includes(args_["triggerType"] as TriggerType)) {
        errors.push({ field: "triggerType", message: `triggerType must be one of: ${TRIGGER_TYPES.join(", ")}` });
      }
      const triggerValue = args_["triggerValue"];
      if (typeof triggerValue !== "number" || triggerValue < 1) {
        errors.push({ field: "triggerValue", message: "triggerValue must be a positive number" });
      }
      if (!ACTION_TYPES.includes(args_["actionType"] as ActionType)) {
        errors.push({ field: "actionType", message: `actionType must be one of: ${ACTION_TYPES.join(", ")}` });
      }
      const cooldownDaysRaw = args_["cooldownDays"];
      const cooldownDays = typeof cooldownDaysRaw === "number" && cooldownDaysRaw >= 1 ? cooldownDaysRaw : 30;

      if (errors.length > 0) return { valid: false, errors };

      return {
        valid: true,
        payload: {
          name, triggerType: args_["triggerType"], triggerValue, actionType: args_["actionType"], cooldownDays,
        },
        summary: `Automation rule: "${name}"`,
        reasoning,
        revisedProposalId,
      };
    }

    case "draft_create_class": {
      const payload: Record<string, unknown> = { ...args_ };
      const result = validateCreateClassPayload(payload);
      if (!result.valid) return { valid: false, errors: result.errors };
      return { valid: true, payload, summary: `New class: "${payload["name"]}" (${payload["dayOfWeek"]} ${payload["startTime"]})`, reasoning, revisedProposalId };
    }

    case "draft_update_class": {
      const classId = typeof args_["classId"] === "string" ? args_["classId"] : "";
      if (!classId) return { valid: false, errors: [{ field: "classId", message: "classId is required" }] };
      const { classId: _omit, ...rest } = args_;
      const result = validateUpdateClassPayload(rest);
      if (!result.valid) return { valid: false, errors: result.errors };

      let label = classId;
      try {
        const existing = await classesService.getClassById(classId, studioOwnerId);
        if (existing) label = (existing["name"] as string) || classId;
      } catch {
        // best-effort label only — approval-time write still re-validates ownership
      }

      return { valid: true, payload: { classId, ...rest }, summary: `Update class: "${label}"`, reasoning, revisedProposalId };
    }

    case "draft_update_package": {
      const packageId = typeof args_["packageId"] === "string" ? args_["packageId"] : "";
      if (!packageId) return { valid: false, errors: [{ field: "packageId", message: "packageId is required" }] };
      const { packageId: _omit, ...rest } = args_;
      const result = validateUpdatePackagePayload(rest);
      if (!result.valid) return { valid: false, errors: result.errors };

      let label = packageId;
      try {
        const existing = await packagesService.getPackageById(packageId, studioOwnerId);
        if (existing) label = (existing["name"] as string) || packageId;
      } catch {
        // best-effort label only — approval-time write still re-validates ownership
      }

      return { valid: true, payload: { packageId, ...rest }, summary: `Update package: "${label}"`, reasoning, revisedProposalId };
    }

    case "draft_create_event": {
      const payload: Record<string, unknown> = { ...args_ };
      const result = validateCreateEventPayload(payload);
      if (!result.valid) return { valid: false, errors: result.errors };
      return { valid: true, payload, summary: `New event: "${payload["name"]}" (${payload["type"]})`, reasoning, revisedProposalId };
    }

    case "draft_update_event": {
      const eventId = typeof args_["eventId"] === "string" ? args_["eventId"] : "";
      if (!eventId) return { valid: false, errors: [{ field: "eventId", message: "eventId is required" }] };
      const { eventId: _omit, ...rest } = args_;
      const result = validateUpdateEventPayload(rest);
      if (!result.valid) return { valid: false, errors: result.errors };

      let label = eventId;
      try {
        const existing = await eventsService.getEventById(eventId, studioOwnerId);
        if (existing) label = (existing["name"] as string) || eventId;
      } catch {
        // best-effort label only — approval-time write still re-validates ownership
      }

      return { valid: true, payload: { eventId, ...rest }, summary: `Update event: "${label}"`, reasoning, revisedProposalId };
    }

    case "draft_create_workshop": {
      const payload: Record<string, unknown> = { ...args_ };
      const result = validateCreateWorkshopPayload(payload);
      if (!result.valid) return { valid: false, errors: result.errors };
      return { valid: true, payload, summary: `New workshop: "${payload["name"]}"`, reasoning, revisedProposalId };
    }

    case "draft_update_workshop": {
      const workshopId = typeof args_["workshopId"] === "string" ? args_["workshopId"] : "";
      if (!workshopId) return { valid: false, errors: [{ field: "workshopId", message: "workshopId is required" }] };
      const { workshopId: _omit, ...rest } = args_;
      const result = validateUpdateWorkshopPayload(rest);
      if (!result.valid) return { valid: false, errors: result.errors };

      let label = workshopId;
      try {
        const existing = await workshopsService.getWorkshopById(workshopId, studioOwnerId);
        if (existing) label = (existing["name"] as string) || workshopId;
      } catch {
        // best-effort label only — approval-time write still re-validates ownership
      }

      return { valid: true, payload: { workshopId, ...rest }, summary: `Update workshop: "${label}"`, reasoning, revisedProposalId };
    }

    case "draft_bulk_import_classes": {
      const rawClasses = Array.isArray(args_["classes"]) ? (args_["classes"] as Array<Record<string, unknown>>) : [];
      if (rawClasses.length === 0) {
        return { valid: false, errors: [{ field: "classes", message: "classes must be a non-empty array" }] };
      }
      if (rawClasses.length > 200) {
        return { valid: false, errors: [{ field: "classes", message: "Too many rows in one import — please split into batches of 200 or fewer." }] };
      }

      const instructors = await instructorsService.getInstructors(studioOwnerId);
      const instructorFullName = (i: Record<string, unknown>): string =>
        `${(i["firstName"] as string) || ""} ${(i["lastName"] as string) || ""}`.trim();

      // Exact match only — never auto-assign on a guess, since a wrong instructor on a class
      // is a silent, easy-to-miss mistake. A near-miss (e.g. "Bill S." for "Bill Smith") is
      // surfaced as a suggestion in the skip reason instead, so the owner can fix and resubmit.
      const findInstructorMatch = (rawName: unknown): { id?: string; suggestion?: string } => {
        if (typeof rawName !== "string" || !rawName.trim()) return {};
        const target = rawName.trim().toLowerCase();
        const exact = instructors.find((i) => instructorFullName(i).toLowerCase() === target);
        if (exact) return { id: exact.id };

        const targetFirstWord = target.split(/\s+/)[0]?.replace(/\.$/, "") ?? "";
        const suggestion = instructors.find((i) => {
          const fullLower = instructorFullName(i).toLowerCase();
          return fullLower.startsWith(target.replace(/\.$/, "")) || fullLower.split(/\s+/)[0] === targetFirstWord;
        });
        return { suggestion: suggestion ? instructorFullName(suggestion) : undefined };
      };

      // Same case-insensitive-match-against-valid-values approach as
      // classes.service.ts's bulkImportClassesForAdmin (normalizeDayOfWeek/normalizeLevel).
      const normalizeAgainst = (raw: unknown, validValues: string[]): string => {
        const trimmed = typeof raw === "string" ? raw.trim() : "";
        const match = validValues.find((v) => v.toLowerCase() === trimmed.toLowerCase());
        return match ?? trimmed;
      };

      const validClasses: Record<string, unknown>[] = [];
      const skippedRows: Array<{ row: Record<string, unknown>; reason: string }> = [];

      for (const raw of rawClasses) {
        const rawInstructorName = raw["instructorName"];
        const { id: instructorId, suggestion } = findInstructorMatch(rawInstructorName);
        if (typeof rawInstructorName === "string" && rawInstructorName.trim() && !instructorId) {
          const hint = suggestion
            ? ` Did you mean "${suggestion}"? Fix the name in your spreadsheet and re-import this row.`
            : " Check the spelling or add them as an instructor first.";
          skippedRows.push({ row: raw, reason: `Couldn't match instructor "${rawInstructorName}" to anyone on your instructor list.${hint}` });
          continue;
        }

        const candidate: Record<string, unknown> = {
          name: typeof raw["name"] === "string" ? (raw["name"] as string).trim() : "",
          level: normalizeAgainst(raw["level"], CLASS_LEVELS),
          dayOfWeek: normalizeAgainst(raw["dayOfWeek"], DAYS_OF_WEEK),
          startTime: raw["startTime"],
          endTime: raw["endTime"],
          instructorIds: instructorId ? [instructorId] : [],
          isActive: true,
          ...(raw["cost"] !== undefined && raw["cost"] !== null && raw["cost"] !== "" ? { cost: Number(raw["cost"]) } : {}),
          ...(typeof raw["room"] === "string" && raw["room"].trim() ? { room: (raw["room"] as string).trim() } : {}),
          ...(typeof raw["danceGenre"] === "string" && raw["danceGenre"].trim() ? { danceGenre: (raw["danceGenre"] as string).trim() } : {}),
          ...(typeof raw["description"] === "string" && raw["description"].trim() ? { description: (raw["description"] as string).trim() } : {}),
        };

        const result = validateCreateClassPayload(candidate);
        if (!result.valid) {
          skippedRows.push({ row: raw, reason: result.errors.map((e) => e.message).join("; ") });
          continue;
        }
        validClasses.push(candidate);
      }

      if (validClasses.length === 0) {
        return { valid: false, errors: [{ field: "classes", message: "None of the rows could be validated — nothing to import. Check the skipped reasons and try again." }] };
      }

      return {
        valid: true,
        payload: { classes: validClasses, skippedRows },
        summary: `Import ${validClasses.length} class${validClasses.length === 1 ? "" : "es"}${skippedRows.length > 0 ? ` (${skippedRows.length} skipped)` : ""}`,
        reasoning,
        revisedProposalId,
      };
    }

    default:
      return { valid: false, errors: [{ field: "tool", message: `Unknown draft tool: ${toolName}` }] };
  }
}

async function persistProposal(studioOwnerId: string, actionType: ProposalActionType, payload: Record<string, unknown>, summary: string, reasoning?: string): Promise<string> {
  const db = getFirestore();
  const ref = await db.collection(PROPOSALS_COLLECTION).add({
    studioOwnerId,
    actionType,
    payload,
    status: "pending",
    summary,
    ...(reasoning ? { reasoning } : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// Overwrites payload/summary on an existing pending proposal in place (revision), rather
// than raising a second, duplicate proposal for the same underlying draft.
async function updateProposal(proposalId: string, payload: Record<string, unknown>, summary: string, reasoning?: string): Promise<void> {
  const db = getFirestore();
  await db.collection(PROPOSALS_COLLECTION).doc(proposalId).update({ payload, summary, reasoning: reasoning ?? null });
}

const TOOL_NAME_TO_ACTION_TYPE: Record<string, ProposalActionType> = {
  draft_email_campaign: "email_campaign",
  draft_automation_rule: "automation_rule",
  draft_create_class: "class_create",
  draft_update_class: "class_update",
  draft_update_package: "package_update",
  draft_create_event: "event_create",
  draft_update_event: "event_update",
  draft_create_workshop: "workshop_create",
  draft_update_workshop: "workshop_update",
  draft_bulk_import_classes: "class_bulk_import",
};

// ─── The chat/tool loop ─────────────────────────────────────────────────────

function systemInstructionFor(studioName: string): string {
  return `You are DanceUp's studio co-pilot for "${studioName}". You help the studio owner by answering questions using the read tools (schedule, packages, instructors, events, workshops, automation rules, engagement stats, insights) and by preparing drafts using the draft_* tools.

Rules you must always follow:
- You can NEVER send an email, create/update an automation rule, create/update a class, event, or workshop, or update a package directly. The only way to propose any of those is to call the matching draft_* tool, which prepares a draft for the studio owner to review and explicitly approve.
- Never tell the user an action has been completed, sent, or saved — only that you've prepared a draft for their approval.
- Before drafting a new class, call get_instructors so you use real instructor IDs. Before drafting an update to a class, package, event, or workshop, call get_schedule, get_packages, get_events, or get_workshops (as appropriate) so you use a real ID.
- If the user asks you to change something about a draft you already proposed (e.g. "actually make it Friday instead"), call get_pending_proposals first to find that proposal's id and current values, then call the SAME draft_* tool again with that id in the proposalId field plus only the field(s) that should change — this updates the existing draft in place instead of creating a duplicate one.
- Every draft_* tool call requires a 'reasoning' argument — always cite the specific number, name, or date from a tool you actually called (e.g. "6 students haven't attended in 21+ days" or "this class averaged 18% fill rate over 4 weeks"). Never a generic reason like "to boost engagement." Also mention that same reasoning, briefly, in your reply text — the studio owner should never see a draft with no visible logic behind it.
- Don't default to an automation rule just because it's the easiest thing to justify from engagement stats. An email campaign, a class/package tweak, or a promo can all be better fits depending on what the data actually shows — pick based on the data, not on which read tool is quickest to call.
- If you have access to deeper analysis tools (revenue forecast, class demand, student LTV, instructor performance, schedule health, automation suggestions, income-goal progress), use them whenever they'd sharpen your answer or a draft — e.g. pull automation-rule suggestions before drafting one, or check income-goal progress before proposing a revenue-focused action.
- When a coordinated plan serves the owner better than one isolated action (e.g. closing a revenue gap with both a promo email and a matching automation rule), you may call more than one draft_* tool in the same turn — each becomes its own proposal, and the owner can approve them together. Briefly explain in your reply how the pieces work together.
- Keep replies concise and conversational.`;
}

export interface AssistantTurnResult {
  reply: { text: string; proposedActionIds?: string[] };
  proposals: AssistantProposal[];
}

// Runs the tool-call loop to completion for a given set of contents (history plus the new
// turn already appended). Shared by handleAssistantMessage (a real chat turn) and the
// proactive suggestion job (a synthetic, system-authored turn) — neither persists messages
// itself here, so callers control exactly what shows up in the visible chat thread.
async function runTurn(
  studioOwnerId: string,
  studioName: string,
  contents: Content[],
  isProPlus: boolean,
): Promise<{ finalText: string; raisedProposals: AssistantProposal[] }> {
  const genAI = await getClient();
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: systemInstructionFor(studioName),
    // Pro+-only tools are only declared to the model at all when the studio qualifies — a
    // non-Pro+ studio owner's model literally cannot see or call them, rather than relying on
    // the model to politely decline after the fact.
    tools: [{ functionDeclarations: [...READ_TOOLS, ...(isProPlus ? PRO_PLUS_READ_TOOLS : []), ...DRAFT_TOOLS] }],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
  });

  const raisedProposals: AssistantProposal[] = [];
  let finalText = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const result = await model.generateContent({ contents });
    const candidateContent = result.response.candidates?.[0]?.content;
    if (candidateContent) contents.push(candidateContent);

    const calls = result.response.functionCalls();
    if (!calls || calls.length === 0) {
      finalText = result.response.text();
      break;
    }

    const draftCalls = calls.filter((c) => DRAFT_TOOL_NAMES.has(c.name));
    const readCalls = calls.filter((c) => !DRAFT_TOOL_NAMES.has(c.name));

    if (draftCalls.length > 0) {
      const validResults: Array<{ actionType: ProposalActionType; payload: Record<string, unknown>; summary: string; reasoning?: string; revisedProposalId?: string }> = [];
      const invalidResponseParts: Part[] = [];

      for (const call of draftCalls) {
        const draft = await prepareDraftProposal(call.name, call.args as Record<string, unknown>, studioOwnerId);
        if (draft.valid) {
          validResults.push({ actionType: TOOL_NAME_TO_ACTION_TYPE[call.name] as ProposalActionType, payload: draft.payload, summary: draft.summary, reasoning: draft.reasoning, revisedProposalId: draft.revisedProposalId });
        } else {
          invalidResponseParts.push({ functionResponse: { name: call.name, response: { status: "invalid", errors: draft.errors } } });
        }
      }

      if (validResults.length > 0) {
        // At least one valid draft was raised — persist it/them and end the turn here.
        // No further model reasoning happens after a draft is raised (core safety property).
        for (const r of validResults) {
          if (r.revisedProposalId) {
            await updateProposal(r.revisedProposalId, r.payload, r.summary, r.reasoning);
            raisedProposals.push({
              id: r.revisedProposalId, studioOwnerId, actionType: r.actionType, payload: r.payload, status: "pending", summary: r.summary, reasoning: r.reasoning, createdAt: new Date().toISOString(),
            });
          } else {
            const id = await persistProposal(studioOwnerId, r.actionType, r.payload, r.summary, r.reasoning);
            raisedProposals.push({
              id, studioOwnerId, actionType: r.actionType, payload: r.payload, status: "pending", summary: r.summary, reasoning: r.reasoning, createdAt: new Date().toISOString(),
            });
          }
        }
        finalText = result.response.text() || "I've drafted this for your review — see the card above.";
        break;
      }

      // No valid drafts this round — feed errors back (plus any read-tool results from the
      // same batch, so every function call this turn gets an answering response) and let the
      // model self-correct.
      const readResponseParts: Part[] = await Promise.all(
        readCalls.map(async (call) => ({
          functionResponse: { name: call.name, response: { data: await executeReadTool(call.name, studioOwnerId) } },
        })),
      );
      contents.push({ role: "user", parts: [...invalidResponseParts, ...readResponseParts] });
      continue;
    }

    // Read tools only — execute for real (no side effects) and continue reasoning.
    const responseParts: Part[] = await Promise.all(
      readCalls.map(async (call) => ({
        functionResponse: { name: call.name, response: { data: await executeReadTool(call.name, studioOwnerId) } },
      })),
    );
    contents.push({ role: "user", parts: responseParts });
  }

  if (!finalText) {
    finalText = "I wasn't able to finish reasoning about that in time — could you try rephrasing or asking something more specific?";
  }

  return { finalText, raisedProposals };
}

// dropLastN drops the N most recent already-persisted messages from the returned history —
// used by handleAssistantMessage to exclude the user message it just persisted (which is
// re-sent as the new turn instead). The proactive job persists nothing beforehand, so it
// passes 0.
async function buildHistoryContents(studioOwnerId: string, dropLastN: number): Promise<Content[]> {
  const allMessages = await loadMessages(studioOwnerId, { order: "desc", limit: MAX_HISTORY_MESSAGES + dropLastN });
  const filtered = allMessages.filter((m) => m.role === "user" || m.role === "model");
  const historyMessages = (dropLastN > 0 ? filtered.slice(0, -dropLastN) : filtered).slice(-MAX_HISTORY_MESSAGES);
  return historyMessages.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
}

export async function handleAssistantMessage(studioOwnerId: string, userText: string): Promise<AssistantTurnResult> {
  await persistMessage(studioOwnerId, "user", userText);

  const [history, contact] = await Promise.all([
    buildHistoryContents(studioOwnerId, 1), // exclude the message we just persisted — sent as the new turn below
    getStudioOwnerContact(studioOwnerId),
  ]);

  // Managed by hand (rather than model.startChat()) because the SDK's ChatSession
  // hardcodes role: "function" for function-response turns, which gemini-3.x's API
  // rejects — this model generation expects those turns as role: "user" instead, and
  // requires each function-call part's thoughtSignature to be echoed back verbatim on
  // later turns. Pushing the raw response.candidates[0].content (rather than
  // reconstructing parts from response.functionCalls()) preserves that signature as-is.
  const contents: Content[] = [...history, { role: "user", parts: [{ text: userText }] }];

  const { finalText, raisedProposals } = await runTurn(studioOwnerId, contact.studioName, contents, contact.isProPlus);

  const proposedActionIds = raisedProposals.map((p) => p.id);
  await persistMessage(studioOwnerId, "model", finalText, proposedActionIds.length > 0 ? proposedActionIds : undefined);

  return { reply: { text: finalText, proposedActionIds: proposedActionIds.length > 0 ? proposedActionIds : undefined }, proposals: raisedProposals };
}

const MAX_BULK_IMPORT_ROWS = 200;

// Called from POST /assistant/import-classes with rows already parsed/column-mapped
// client-side (see class-spreadsheet-import.component.ts) — never a raw file. Builds a
// fixed, backend-controlled instruction (not subject to /message's 4000-char cap, since this
// bypasses that route and calls handleAssistantMessage directly) so a real user's phrasing
// can't derail a mechanical pass-the-data-to-one-tool-call step.
export async function handleBulkImportClassesRequest(
  studioOwnerId: string,
  rows: Array<Record<string, unknown>>,
): Promise<AssistantTurnResult> {
  const trimmedRows = rows.slice(0, MAX_BULK_IMPORT_ROWS);
  const instruction = `The studio owner uploaded a spreadsheet and confirmed these ${trimmedRows.length} classes to import (already parsed from their file — don't ask them to re-enter anything). Call draft_bulk_import_classes ONCE with this exact list as the classes argument, not draft_create_class per row. The backend re-validates each row and resolves instructor names server-side, so include every row even if something looks off — invalid or unmatched rows are safely skipped and reported back, never silently dropped or silently created wrong.\n\nRows (JSON array):\n${JSON.stringify(trimmedRows)}`;
  return handleAssistantMessage(studioOwnerId, instruction);
}

const PROACTIVE_SUGGESTION_PROMPT = "Proactively look for the single most valuable thing to bring to this studio owner's attention right now. Check multiple angles before picking one — engagement (get_engagement_summary), the schedule and package lineup, and if you have access to them, revenue forecast, class demand, promo triggers, and income-goal pacing. An automation rule is only ONE of many possible actions (others: a one-off email campaign, a class or package tweak, a promo). Do not default to an automation rule just because engagement data is the easiest thing to check — pick whichever action type the data actually supports best. Draft exactly one proposal (or a short coordinated set, per your instructions) using the matching draft_* tool, with reasoning that cites the specific number(s) that drove your pick. If nothing stands out as worth surfacing right now, just reply with a short 'Nothing urgent today.' and don't draft anything.";
const PROACTIVE_SUGGESTION_NOTIFICATION_TYPE = "copilot_suggestion";
const PROACTIVE_SUGGESTION_COOLDOWN_DAYS = 3;

async function hasRecentProactiveSuggestion(studioOwnerId: string): Promise<boolean> {
  const db = getFirestore();
  const cooldownStart = Date.now() - PROACTIVE_SUGGESTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  // Single-field query, filtered in JS — avoids a new composite index, matching the
  // same dedup pattern already used by attendance.service.ts's low-enrollment job.
  const snap = await db.collection("notifications").where("studioId", "==", studioOwnerId).get();
  return snap.docs.some((doc) => {
    const d = doc.data() as Record<string, unknown>;
    if (d["type"] !== PROACTIVE_SUGGESTION_NOTIFICATION_TYPE) return false;
    const createdAt = d["createdAt"] as admin.firestore.Timestamp | undefined;
    return !!createdAt && createdAt.toMillis() >= cooldownStart;
  });
}

// Called once per studio by the daily copilotSuggestions scheduled job (routes/copilot-suggestions.ts),
// and on-demand by the studio owner via POST /assistant/check-suggestions (force: true).
// Skips quietly (no LLM call at all) if a proposal is already pending or a suggestion was
// raised recently, so the automated daily run never piles unactioned suggestions on a studio
// owner — force:true (an explicit, human-initiated check) bypasses both of those guards, since
// the whole point of that path is "show me this working right now."
export async function runProactiveSuggestionForStudio(studioOwnerId: string, force = false): Promise<{ raised: boolean; proposal?: AssistantProposal }> {
  if (!force) {
    const pending = await loadPendingProposals(studioOwnerId);
    if (pending.length > 0) return { raised: false };
    if (await hasRecentProactiveSuggestion(studioOwnerId)) return { raised: false };
  }

  const [history, contact] = await Promise.all([
    buildHistoryContents(studioOwnerId, 0),
    getStudioOwnerContact(studioOwnerId),
  ]);

  // Goal-aware urgency: fold in income-goal pacing (Pro+ + a goal is set) so the model can
  // weigh how far behind/ahead the studio is when deciding whether and what to suggest.
  let proactivePrompt = PROACTIVE_SUGGESTION_PROMPT;
  if (contact.isProPlus && contact.annualRevenueGoal != null) {
    const progress = await buildIncomeGoalProgress(studioOwnerId, contact.annualRevenueGoal);
    if (progress.goalSet) {
      proactivePrompt += ` Additionally, this studio is at ${progress.percentComplete}% of its $${progress.annualRevenueGoal.toLocaleString()} annual revenue goal ($${progress.revenueToDate.toLocaleString()} so far), with ${progress.daysRemainingInYear} days left in the year — factor this pacing into whether and what you suggest.`;
    }
  }
  const contents: Content[] = [...history, { role: "user", parts: [{ text: proactivePrompt }] }];

  const { finalText, raisedProposals } = await runTurn(studioOwnerId, contact.studioName, contents, contact.isProPlus);
  if (raisedProposals.length === 0) return { raised: false };

  const proposedActionIds = raisedProposals.map((p) => p.id);
  await persistMessage(studioOwnerId, "model", finalText, proposedActionIds);

  const proposal = raisedProposals[0] as AssistantProposal;
  await notificationsService.createNotification(
    studioOwnerId, null, PROACTIVE_SUGGESTION_NOTIFICATION_TYPE, "Your Co-Pilot has a suggestion",
    proposal.summary, null, null, proposal.id,
  );

  const assistantUrl = studioOwnerAssistantUrl();
  await Promise.all([
    sendCopilotSuggestionEmail(contact.email, contact.firstName, contact.studioName, proposal.summary, assistantUrl)
      .catch((err) => console.error(`[CopilotSuggestions] Failed to email studio ${studioOwnerId}:`, (err as Error).message)),
    sendStudioOwnerPush(studioOwnerId, "Your Co-Pilot has a suggestion", proposal.summary, { proposalId: proposal.id, type: PROACTIVE_SUGGESTION_NOTIFICATION_TYPE })
      .catch((err) => console.error(`[CopilotSuggestions] Failed to push studio ${studioOwnerId}:`, (err as Error).message)),
  ]);

  return { raised: true, proposal };
}

// Called once daily by the copilotSuggestions scheduled job (routes/copilot-suggestions.ts).
// Derives the studio-owner-id set the same ad-hoc way retention.service.ts does, and isolates
// each studio in its own try/catch so one studio's failure doesn't block the rest.
export async function runProactiveSuggestionsForAllStudios(): Promise<{ raisedCount: number }> {
  const db = getFirestore();
  const studentsSnapshot = await db.collection("students").get();
  const studioOwnerIds = new Set<string>();
  studentsSnapshot.forEach((doc) => {
    const data = doc.data() as Record<string, unknown>;
    if (data["studioOwnerId"]) studioOwnerIds.add(data["studioOwnerId"] as string);
  });

  let raisedCount = 0;
  for (const studioOwnerId of studioOwnerIds) {
    try {
      const { raised } = await runProactiveSuggestionForStudio(studioOwnerId);
      if (raised) raisedCount++;
    } catch (err) {
      console.error(`[CopilotSuggestions] Error processing studio ${studioOwnerId}:`, (err as Error).message);
    }
  }
  return { raisedCount };
}

// ─── Approve / reject ───────────────────────────────────────────────────────

export interface ApproveOptions {
  fromEmail: string;
  fromName: string;
  unsubscribeBaseUrl: string;
}

async function getProposalOrThrow(studioOwnerId: string, proposalId: string): Promise<{ ref: FirebaseFirestore.DocumentReference; data: AssistantProposal }> {
  const db = getFirestore();
  const ref = db.collection(PROPOSALS_COLLECTION).doc(proposalId);
  const doc = await ref.get();
  if (!doc.exists) {
    const err = new Error("Proposal not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const data = hydrateProposal(doc);
  if (data.studioOwnerId !== studioOwnerId) {
    const err = new Error("Access denied: proposal does not belong to this studio owner") as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  if (data.status !== "pending") {
    const err = new Error(`Proposal has already been ${data.status}`) as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  return { ref, data };
}

export async function approveProposal(
  studioOwnerId: string,
  actorUid: string,
  proposalId: string,
  payloadOverride: Record<string, unknown> | undefined,
  approveOptions: ApproveOptions,
): Promise<{ resultResourceId: string; message: string }> {
  const { ref, data } = await getProposalOrThrow(studioOwnerId, proposalId);
  const mergedPayload: Record<string, unknown> = { ...data.payload, ...(payloadOverride || {}) };

  let resultResourceId: string;
  let message: string;

  switch (data.actionType) {
    case "email_campaign": {
      let sendResult: Awaited<ReturnType<typeof marketingService.sendCampaignToRecipients>>;
      try {
        sendResult = await marketingService.sendCampaignToRecipients(
          studioOwnerId,
          mergedPayload as unknown as marketingService.SendCampaignParams,
          approveOptions,
        );
      } catch (sendError) {
        const msg = (sendError as Error).message || "";
        if (msg.startsWith("Validation Error")) {
          const err = new Error(msg.replace(/^Validation Error:\s*/, "")) as Error & { status?: number };
          err.status = 400;
          throw err;
        }
        throw sendError;
      }
      resultResourceId = sendResult.campaignId;
      message = `Email sent to ${sendResult.recipientCount} recipient(s).`;
      logAuditEvent(actorUid, studioOwnerId, "assistant_email_campaign_sent", "marketingCampaign", resultResourceId, { subject: mergedPayload["subject"] });
      break;
    }
    case "automation_rule": {
      const errors: Array<{ field: string; message: string }> = [];
      if (!TRIGGER_TYPES.includes(mergedPayload["triggerType"] as TriggerType)) errors.push({ field: "triggerType", message: "Invalid triggerType" });
      if (!ACTION_TYPES.includes(mergedPayload["actionType"] as ActionType)) errors.push({ field: "actionType", message: "Invalid actionType" });
      if (typeof mergedPayload["triggerValue"] !== "number" || (mergedPayload["triggerValue"] as number) < 1) errors.push({ field: "triggerValue", message: "triggerValue must be a positive number" });
      if (errors.length > 0) {
        const err = new Error("Validation Error") as Error & { status?: number; errors?: unknown[] };
        err.status = 400;
        err.errors = errors;
        throw err;
      }
      resultResourceId = await campaignRulesService.createRule(studioOwnerId, {
        name: String(mergedPayload["name"]).trim(),
        triggerType: mergedPayload["triggerType"] as TriggerType,
        triggerValue: mergedPayload["triggerValue"] as number,
        actionType: mergedPayload["actionType"] as ActionType,
        cooldownDays: typeof mergedPayload["cooldownDays"] === "number" ? (mergedPayload["cooldownDays"] as number) : 30,
      });
      message = "Automation rule created.";
      logAuditEvent(actorUid, studioOwnerId, "assistant_automation_rule_created", "campaignRule", resultResourceId, {});
      break;
    }
    case "class_create": {
      const result = validateCreateClassPayload(mergedPayload);
      if (!result.valid) {
        const err = new Error("Validation Error") as Error & { status?: number; errors?: unknown[] };
        err.status = 400;
        err.errors = result.errors;
        throw err;
      }
      resultResourceId = await classesService.createClass(mergedPayload, studioOwnerId);
      message = "Class created.";
      logAuditEvent(actorUid, studioOwnerId, "assistant_class_created", "class", resultResourceId, {});
      break;
    }
    case "class_update": {
      const { classId, ...updates } = mergedPayload as { classId: string } & Record<string, unknown>;
      const result = validateUpdateClassPayload(updates);
      if (!result.valid) {
        const err = new Error("Validation Error") as Error & { status?: number; errors?: unknown[] };
        err.status = 400;
        err.errors = result.errors;
        throw err;
      }
      await classesService.updateClass(classId, updates, studioOwnerId);
      resultResourceId = classId;
      message = "Class updated.";
      logAuditEvent(actorUid, studioOwnerId, "assistant_class_updated", "class", resultResourceId, {});
      break;
    }
    case "package_update": {
      const { packageId, ...updates } = mergedPayload as { packageId: string } & Record<string, unknown>;
      const result = validateUpdatePackagePayload(updates);
      if (!result.valid) {
        const err = new Error("Validation Error") as Error & { status?: number; errors?: unknown[] };
        err.status = 400;
        err.errors = result.errors;
        throw err;
      }
      await packagesService.updatePackage(packageId, updates, studioOwnerId);
      resultResourceId = packageId;
      message = "Package updated.";
      logAuditEvent(actorUid, studioOwnerId, "assistant_package_updated", "package", resultResourceId, {});
      break;
    }
    case "event_create": {
      const result = validateCreateEventPayload(mergedPayload);
      if (!result.valid) {
        const err = new Error("Validation Error") as Error & { status?: number; errors?: unknown[] };
        err.status = 400;
        err.errors = result.errors;
        throw err;
      }
      resultResourceId = await eventsService.createEvent(mergedPayload, studioOwnerId);
      message = "Event created.";
      logAuditEvent(actorUid, studioOwnerId, "assistant_event_created", "event", resultResourceId, {});
      break;
    }
    case "event_update": {
      const { eventId, ...updates } = mergedPayload as { eventId: string } & Record<string, unknown>;
      const result = validateUpdateEventPayload(updates);
      if (!result.valid) {
        const err = new Error("Validation Error") as Error & { status?: number; errors?: unknown[] };
        err.status = 400;
        err.errors = result.errors;
        throw err;
      }
      await eventsService.updateEvent(eventId, updates, studioOwnerId);
      resultResourceId = eventId;
      message = "Event updated.";
      logAuditEvent(actorUid, studioOwnerId, "assistant_event_updated", "event", resultResourceId, {});
      break;
    }
    case "workshop_create": {
      const result = validateCreateWorkshopPayload(mergedPayload);
      if (!result.valid) {
        const err = new Error("Validation Error") as Error & { status?: number; errors?: unknown[] };
        err.status = 400;
        err.errors = result.errors;
        throw err;
      }
      resultResourceId = await workshopsService.createWorkshop(mergedPayload, studioOwnerId);
      message = "Workshop created.";
      logAuditEvent(actorUid, studioOwnerId, "assistant_workshop_created", "workshop", resultResourceId, {});
      break;
    }
    case "workshop_update": {
      const { workshopId, ...updates } = mergedPayload as { workshopId: string } & Record<string, unknown>;
      const result = validateUpdateWorkshopPayload(updates);
      if (!result.valid) {
        const err = new Error("Validation Error") as Error & { status?: number; errors?: unknown[] };
        err.status = 400;
        err.errors = result.errors;
        throw err;
      }
      await workshopsService.updateWorkshop(workshopId, updates, studioOwnerId);
      resultResourceId = workshopId;
      message = "Workshop updated.";
      logAuditEvent(actorUid, studioOwnerId, "assistant_workshop_updated", "workshop", resultResourceId, {});
      break;
    }
    case "class_bulk_import": {
      const classes = Array.isArray(mergedPayload["classes"]) ? (mergedPayload["classes"] as Array<Record<string, unknown>>) : [];
      if (classes.length === 0) {
        const err = new Error("No classes to import") as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const createdIds: string[] = [];
      for (const classData of classes) {
        const id = await classesService.createClass(classData, studioOwnerId);
        createdIds.push(id);
      }
      resultResourceId = createdIds[0] as string;
      message = `${createdIds.length} class${createdIds.length === 1 ? "" : "es"} created.`;
      logAuditEvent(actorUid, studioOwnerId, "assistant_classes_bulk_imported", "class", resultResourceId, { count: createdIds.length, allIds: createdIds });
      break;
    }
    default:
      throw new Error(`Unknown actionType: ${data.actionType as string}`);
  }

  await ref.update({
    status: "approved",
    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedBy: actorUid,
    resultResourceId,
  });
  await persistMessage(studioOwnerId, "system", `Approved — ${message}`);

  return { resultResourceId, message };
}

export async function rejectProposal(studioOwnerId: string, actorUid: string, proposalId: string): Promise<void> {
  const { ref } = await getProposalOrThrow(studioOwnerId, proposalId);
  await ref.update({
    status: "rejected",
    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedBy: actorUid,
  });
  await persistMessage(studioOwnerId, "system", "Discarded.");
}
