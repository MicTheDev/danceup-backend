import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import campaignRulesService, { TriggerType, ActionType } from "../services/campaign-rules.service";
import studentsService from "../services/students.service";
import { verifyToken } from "../utils/auth";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);

const VALID_TRIGGER_TYPES: TriggerType[] = ["inactive_days", "credits_expiring_days", "signup_no_attend", "milestone_checkins"];
const VALID_ACTION_TYPES: ActionType[] = ["re_engagement_email", "credit_reminder_email", "milestone_email", "signup_nudge_email"];

app.get("/rules", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const rules = await campaignRulesService.getRules(studioOwnerId);
    sendJsonResponse(req, res, 200, { rules });
  } catch (error) {
    handleError(req, res, error);
  }
});

app.post("/rules", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const { name, triggerType, triggerValue, actionType, cooldownDays } = req.body as Record<string, unknown>;

    if (!name || typeof name !== "string" || !name.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "name is required");
    }
    if (!VALID_TRIGGER_TYPES.includes(triggerType as TriggerType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", `triggerType must be one of: ${VALID_TRIGGER_TYPES.join(", ")}`);
    }
    if (typeof triggerValue !== "number" || triggerValue < 1) {
      return sendErrorResponse(req, res, 400, "Validation Error", "triggerValue must be a positive number");
    }
    if (!VALID_ACTION_TYPES.includes(actionType as ActionType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", `actionType must be one of: ${VALID_ACTION_TYPES.join(", ")}`);
    }

    const ruleId = await campaignRulesService.createRule(studioOwnerId, {
      name: String(name).trim(),
      triggerType: triggerType as TriggerType,
      triggerValue: triggerValue as number,
      actionType: actionType as ActionType,
      cooldownDays: typeof cooldownDays === "number" && cooldownDays >= 1 ? cooldownDays : 30,
    });

    sendJsonResponse(req, res, 201, { id: ruleId, message: "Campaign rule created" });
  } catch (error) {
    handleError(req, res, error);
  }
});

app.put("/rules/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const { name, isActive, triggerType, triggerValue, actionType, cooldownDays } = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) return sendErrorResponse(req, res, 400, "Validation Error", "name must be a non-empty string");
      updates["name"] = String(name).trim();
    }
    if (isActive !== undefined) updates["isActive"] = Boolean(isActive);
    if (triggerType !== undefined) {
      if (!VALID_TRIGGER_TYPES.includes(triggerType as TriggerType)) return sendErrorResponse(req, res, 400, "Validation Error", "Invalid triggerType");
      updates["triggerType"] = triggerType;
    }
    if (triggerValue !== undefined) {
      if (typeof triggerValue !== "number" || triggerValue < 1) return sendErrorResponse(req, res, 400, "Validation Error", "triggerValue must be a positive number");
      updates["triggerValue"] = triggerValue;
    }
    if (actionType !== undefined) {
      if (!VALID_ACTION_TYPES.includes(actionType as ActionType)) return sendErrorResponse(req, res, 400, "Validation Error", "Invalid actionType");
      updates["actionType"] = actionType;
    }
    if (cooldownDays !== undefined) {
      if (typeof cooldownDays !== "number" || cooldownDays < 1) return sendErrorResponse(req, res, 400, "Validation Error", "cooldownDays must be a positive number");
      updates["cooldownDays"] = cooldownDays;
    }

    await campaignRulesService.updateRule(req.params["id"] as string, studioOwnerId, updates as Parameters<typeof campaignRulesService.updateRule>[2]);
    sendJsonResponse(req, res, 200, { message: "Rule updated" });
  } catch (error) {
    const msg = (error as Error).message;
    if (msg?.includes("not found") || msg?.includes("access denied")) {
      return sendErrorResponse(req, res, 404, "Not Found", msg);
    }
    handleError(req, res, error);
  }
});

app.delete("/rules/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    await campaignRulesService.deleteRule(req.params["id"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Rule deleted" });
  } catch (error) {
    const msg = (error as Error).message;
    if (msg?.includes("not found") || msg?.includes("access denied")) {
      return sendErrorResponse(req, res, 404, "Not Found", msg);
    }
    handleError(req, res, error);
  }
});

// Manual trigger for testing
app.post("/rules/evaluate", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const sent = await campaignRulesService.evaluateRulesForStudio(studioOwnerId);
    sendJsonResponse(req, res, 200, { sent, message: `Evaluation complete. ${sent} emails sent.` });
  } catch (error) {
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const campaigns = functions.https.onRequest(app);
