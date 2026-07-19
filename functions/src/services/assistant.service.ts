import * as admin from "firebase-admin";
import {
  GoogleGenerativeAI,
  SchemaType,
  FunctionCallingMode,
  type FunctionDeclaration,
  type Content,
  type Part,
} from "@google/generative-ai";
import { getFirestore } from "../utils/firestore";
import { getSecret } from "../utils/secret-manager";
import classesService from "./classes.service";
import packagesService from "./packages.service";
import instructorsService from "./instructors.service";
import campaignRulesService, { TriggerType, ActionType } from "./campaign-rules.service";
import * as marketingService from "./marketing.service";
import * as aiService from "./ai.service";
import * as insightsService from "./insights.service";
import {
  validateCreateClassPayload,
  validateUpdateClassPayload,
  validateUpdatePackagePayload,
} from "../utils/validation";
import { logAuditEvent } from "./audit.service";

const MESSAGES_COLLECTION = "assistantMessages";
const PROPOSALS_COLLECTION = "assistantProposals";
const MAX_TOOL_ITERATIONS = 5;
const MAX_HISTORY_MESSAGES = 40;
const MODEL_NAME = "gemini-2.5-flash";

export type AssistantRole = "user" | "model" | "system";
export type ProposalActionType = "email_campaign" | "automation_rule" | "class_create" | "class_update" | "package_update";
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
];

const EMAIL_TONES = ["promotional", "informational", "community"] as const;
const TRIGGER_TYPES: TriggerType[] = ["inactive_days", "credits_expiring_days", "signup_no_attend", "milestone_checkins", "first_class_attended", "credits_depleted"];
const ACTION_TYPES: ActionType[] = ["re_engagement_email", "credit_reminder_email", "milestone_email", "signup_nudge_email", "first_class_email", "credits_depleted_email"];
const CLASS_LEVELS = ["Beginner", "Intermediate", "Advanced", "All Levels"];
const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const DRAFT_TOOLS: FunctionDeclaration[] = [
  {
    name: "draft_email_campaign",
    description: "Draft a marketing email campaign for the studio owner to review and approve before it is sent to subscribed students. Never claim the email has been sent.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        tone: { type: SchemaType.STRING, enum: [...EMAIL_TONES], description: "Overall tone of the email." },
        instructions: { type: SchemaType.STRING, description: "Specific instructions from the studio owner about what the email should include." },
      },
      required: ["tone"],
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
      },
      required: ["name", "triggerType", "triggerValue", "actionType"],
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
      },
      required: ["name", "level", "dayOfWeek", "startTime", "endTime", "instructorIds", "isActive"],
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
      },
      required: ["classId"],
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
      },
      required: ["packageId"],
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

async function getStudioName(studioOwnerId: string): Promise<string> {
  const db = getFirestore();
  const doc = await db.collection("users").doc(studioOwnerId).get();
  if (!doc.exists) return "Your Studio";
  return ((doc.data() as Record<string, unknown>)["studioName"] as string) || "Your Studio";
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

async function loadMessages(studioOwnerId: string): Promise<AssistantMessage[]> {
  const db = getFirestore();
  const snap = await db.collection(MESSAGES_COLLECTION)
    .where("studioOwnerId", "==", studioOwnerId)
    .orderBy("createdAt", "asc")
    .get();
  return snap.docs.map((doc) => {
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Draft tool -> proposal preparation (never writes) ─────────────────────

type DraftResult =
  | { valid: true; payload: Record<string, unknown>; summary: string }
  | { valid: false; errors: Array<{ field: string; message: string }> };

async function prepareDraftProposal(
  toolName: string,
  args: Record<string, unknown>,
  studioOwnerId: string,
): Promise<DraftResult> {
  switch (toolName) {
    case "draft_email_campaign": {
      const tone = typeof args["tone"] === "string" && (EMAIL_TONES as readonly string[]).includes(args["tone"] as string)
        ? (args["tone"] as string)
        : "community";
      const instructions = typeof args["instructions"] === "string" ? args["instructions"].slice(0, 500) : undefined;

      const { studioName, classes, events, workshops } = await marketingService.getStudioContentForAI(studioOwnerId, {});
      const { subject, htmlBody } = await aiService.generateEmailCampaign({
        studioName, classes, events, workshops, tone, instructions,
      });

      return {
        valid: true,
        payload: { subject, bodyHtml: htmlBody, sendToAll: true } as Record<string, unknown>,
        summary: `Email: "${subject}"`,
      };
    }

    case "draft_automation_rule": {
      const errors: Array<{ field: string; message: string }> = [];
      const name = typeof args["name"] === "string" ? args["name"].trim() : "";
      if (!name) errors.push({ field: "name", message: "name is required" });
      if (!TRIGGER_TYPES.includes(args["triggerType"] as TriggerType)) {
        errors.push({ field: "triggerType", message: `triggerType must be one of: ${TRIGGER_TYPES.join(", ")}` });
      }
      const triggerValue = args["triggerValue"];
      if (typeof triggerValue !== "number" || triggerValue < 1) {
        errors.push({ field: "triggerValue", message: "triggerValue must be a positive number" });
      }
      if (!ACTION_TYPES.includes(args["actionType"] as ActionType)) {
        errors.push({ field: "actionType", message: `actionType must be one of: ${ACTION_TYPES.join(", ")}` });
      }
      const cooldownDaysRaw = args["cooldownDays"];
      const cooldownDays = typeof cooldownDaysRaw === "number" && cooldownDaysRaw >= 1 ? cooldownDaysRaw : 30;

      if (errors.length > 0) return { valid: false, errors };

      return {
        valid: true,
        payload: {
          name, triggerType: args["triggerType"], triggerValue, actionType: args["actionType"], cooldownDays,
        },
        summary: `Automation rule: "${name}"`,
      };
    }

    case "draft_create_class": {
      const payload: Record<string, unknown> = { ...args };
      const result = validateCreateClassPayload(payload);
      if (!result.valid) return { valid: false, errors: result.errors };
      return { valid: true, payload, summary: `New class: "${payload["name"]}" (${payload["dayOfWeek"]} ${payload["startTime"]})` };
    }

    case "draft_update_class": {
      const classId = typeof args["classId"] === "string" ? args["classId"] : "";
      if (!classId) return { valid: false, errors: [{ field: "classId", message: "classId is required" }] };
      const { classId: _omit, ...rest } = args;
      const result = validateUpdateClassPayload(rest);
      if (!result.valid) return { valid: false, errors: result.errors };

      let label = classId;
      try {
        const existing = await classesService.getClassById(classId, studioOwnerId);
        if (existing) label = (existing["name"] as string) || classId;
      } catch {
        // best-effort label only — approval-time write still re-validates ownership
      }

      return { valid: true, payload: { classId, ...rest }, summary: `Update class: "${label}"` };
    }

    case "draft_update_package": {
      const packageId = typeof args["packageId"] === "string" ? args["packageId"] : "";
      if (!packageId) return { valid: false, errors: [{ field: "packageId", message: "packageId is required" }] };
      const { packageId: _omit, ...rest } = args;
      const result = validateUpdatePackagePayload(rest);
      if (!result.valid) return { valid: false, errors: result.errors };

      let label = packageId;
      try {
        const existing = await packagesService.getPackageById(packageId, studioOwnerId);
        if (existing) label = (existing["name"] as string) || packageId;
      } catch {
        // best-effort label only — approval-time write still re-validates ownership
      }

      return { valid: true, payload: { packageId, ...rest }, summary: `Update package: "${label}"` };
    }

    default:
      return { valid: false, errors: [{ field: "tool", message: `Unknown draft tool: ${toolName}` }] };
  }
}

async function persistProposal(studioOwnerId: string, actionType: ProposalActionType, payload: Record<string, unknown>, summary: string): Promise<string> {
  const db = getFirestore();
  const ref = await db.collection(PROPOSALS_COLLECTION).add({
    studioOwnerId,
    actionType,
    payload,
    status: "pending",
    summary,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

const TOOL_NAME_TO_ACTION_TYPE: Record<string, ProposalActionType> = {
  draft_email_campaign: "email_campaign",
  draft_automation_rule: "automation_rule",
  draft_create_class: "class_create",
  draft_update_class: "class_update",
  draft_update_package: "package_update",
};

// ─── The chat/tool loop ─────────────────────────────────────────────────────

function systemInstructionFor(studioName: string): string {
  return `You are DanceUp's studio co-pilot for "${studioName}". You help the studio owner by answering questions using the read tools (schedule, packages, instructors, automation rules, engagement stats, insights) and by preparing drafts using the draft_* tools.

Rules you must always follow:
- You can NEVER send an email, create/update an automation rule, create/update a class, or update a package directly. The only way to propose any of those is to call the matching draft_* tool, which prepares a draft for the studio owner to review and explicitly approve.
- Never tell the user an action has been completed, sent, or saved — only that you've prepared a draft for their approval.
- Before drafting a new class, call get_instructors so you use real instructor IDs. Before drafting an update to a class or package, call get_schedule or get_packages so you use a real ID.
- Keep replies concise and conversational.`;
}

export interface AssistantTurnResult {
  reply: { text: string; proposedActionIds?: string[] };
  proposals: AssistantProposal[];
}

export async function handleAssistantMessage(studioOwnerId: string, userText: string): Promise<AssistantTurnResult> {
  await persistMessage(studioOwnerId, "user", userText);

  const [allMessages, studioName] = await Promise.all([
    loadMessages(studioOwnerId),
    getStudioName(studioOwnerId),
  ]);

  const historyMessages = allMessages
    .filter((m) => m.role === "user" || m.role === "model")
    .slice(0, -1) // exclude the message we just persisted — it's sent as the new turn below
    .slice(-MAX_HISTORY_MESSAGES);

  const history: Content[] = historyMessages.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  const genAI = await getClient();
  // systemInstruction must be set here (not in startChat's params) — ChatSession.sendMessage()
  // forwards startChat's systemInstruction to the API as-is with no string->Content normalization,
  // while GenerativeModel's constructor does run it through formatSystemInstruction().
  const model = genAI.getGenerativeModel({ model: MODEL_NAME, systemInstruction: systemInstructionFor(studioName) });
  const chat = model.startChat({
    history,
    tools: [{ functionDeclarations: [...READ_TOOLS, ...DRAFT_TOOLS] }],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
  });

  let result = await chat.sendMessage(userText);
  const raisedProposals: AssistantProposal[] = [];
  let finalText = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const calls = result.response.functionCalls();
    if (!calls || calls.length === 0) {
      finalText = result.response.text();
      break;
    }

    const draftCalls = calls.filter((c) => DRAFT_TOOL_NAMES.has(c.name));
    const readCalls = calls.filter((c) => !DRAFT_TOOL_NAMES.has(c.name));

    if (draftCalls.length > 0) {
      const validResults: Array<{ actionType: ProposalActionType; payload: Record<string, unknown>; summary: string }> = [];
      const invalidResponseParts: Part[] = [];

      for (const call of draftCalls) {
        const draft = await prepareDraftProposal(call.name, call.args as Record<string, unknown>, studioOwnerId);
        if (draft.valid) {
          validResults.push({ actionType: TOOL_NAME_TO_ACTION_TYPE[call.name] as ProposalActionType, payload: draft.payload, summary: draft.summary });
        } else {
          invalidResponseParts.push({ functionResponse: { name: call.name, response: { status: "invalid", errors: draft.errors } } });
        }
      }

      if (validResults.length > 0) {
        // At least one valid draft was raised — persist it/them and end the turn here.
        // No further model reasoning happens after a draft is raised (core safety property).
        for (const r of validResults) {
          const id = await persistProposal(studioOwnerId, r.actionType, r.payload, r.summary);
          raisedProposals.push({
            id, studioOwnerId, actionType: r.actionType, payload: r.payload, status: "pending", summary: r.summary, createdAt: new Date().toISOString(),
          });
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
      result = await chat.sendMessage([...invalidResponseParts, ...readResponseParts]);
      continue;
    }

    // Read tools only — execute for real (no side effects) and continue reasoning.
    const responseParts: Part[] = await Promise.all(
      readCalls.map(async (call) => ({
        functionResponse: { name: call.name, response: { data: await executeReadTool(call.name, studioOwnerId) } },
      })),
    );
    result = await chat.sendMessage(responseParts);
  }

  if (!finalText) {
    finalText = "I wasn't able to finish reasoning about that in time — could you try rephrasing or asking something more specific?";
  }

  const proposedActionIds = raisedProposals.map((p) => p.id);
  await persistMessage(studioOwnerId, "model", finalText, proposedActionIds.length > 0 ? proposedActionIds : undefined);

  return { reply: { text: finalText, proposedActionIds: proposedActionIds.length > 0 ? proposedActionIds : undefined }, proposals: raisedProposals };
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
