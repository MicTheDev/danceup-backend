import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import studentsService from "../services/students.service";
import * as assistantService from "../services/assistant.service";
import { verifyToken } from "../utils/auth";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
  getFunctionBaseUrl,
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

const DEFAULT_FROM_EMAIL = process.env["SENDGRID_FROM_EMAIL"] || "info@danceup.app";
const DEFAULT_FROM_NAME = process.env["SENDGRID_FROM_NAME"] || "DanceUp";

app.get("/history", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const { messages, pendingProposals } = await assistantService.getHistory(studioOwnerId);
    sendJsonResponse(req, res, 200, { messages, pendingProposals });
  } catch (error) {
    console.error("Error loading assistant history:", error);
    handleError(req, res, error);
  }
});

app.post("/message", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const { text } = (req.body || {}) as { text?: string };
    if (!text || typeof text !== "string" || !text.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "text is required");
    }

    const result = await assistantService.handleAssistantMessage(studioOwnerId, text.trim().slice(0, 4000));
    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    console.error("Error handling assistant message:", error);
    handleError(req, res, error);
  }
});

app.post("/proposals/:id/approve", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const proposalId = req.params["id"] as string;
    const { payload } = (req.body || {}) as { payload?: Record<string, unknown> };

    const result = await assistantService.approveProposal(studioOwnerId, user.uid, proposalId, payload, {
      fromEmail: DEFAULT_FROM_EMAIL,
      fromName: DEFAULT_FROM_NAME,
      unsubscribeBaseUrl: getFunctionBaseUrl("marketing", req),
    });

    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    const err = error as Error & { status?: number; errors?: unknown[] };
    if (err.status === 404) return sendErrorResponse(req, res, 404, "Not Found", err.message);
    if (err.status === 403) return sendErrorResponse(req, res, 403, "Access Denied", err.message);
    if (err.status === 409) return sendErrorResponse(req, res, 409, "Conflict", err.message);
    if (err.status === 400) return sendErrorResponse(req, res, 400, "Validation Error", err.message, { errors: err.errors ?? [] });
    console.error("Error approving assistant proposal:", error);
    handleError(req, res, error);
  }
});

app.post("/proposals/:id/reject", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const proposalId = req.params["id"] as string;
    await assistantService.rejectProposal(studioOwnerId, user.uid, proposalId);
    sendJsonResponse(req, res, 200, { message: "Proposal discarded" });
  } catch (error) {
    const err = error as Error & { status?: number };
    if (err.status === 404) return sendErrorResponse(req, res, 404, "Not Found", err.message);
    if (err.status === 403) return sendErrorResponse(req, res, 403, "Access Denied", err.message);
    if (err.status === 409) return sendErrorResponse(req, res, 409, "Conflict", err.message);
    console.error("Error rejecting assistant proposal:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const assistant = functions.https.onRequest({ timeoutSeconds: 120, memory: "256MiB" }, app);
