import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import studentsService from "../services/students.service";
import * as emailTemplatesService from "../services/email-templates.service";
import { verifyToken } from "../utils/auth";
import { sendJsonResponse, sendErrorResponse, handleError, corsOptions, isAllowedOrigin } from "../utils/http";

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

async function getStudioOwner(req: Request, res: Response): Promise<string | null> {
  let user;
  try {
    user = await verifyToken(req);
  } catch (authError) {
    handleError(req, res, authError);
    return null;
  }
  const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
  if (!studioOwnerId) {
    sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    return null;
  }
  return studioOwnerId;
}

app.get("/", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    const templates = await emailTemplatesService.listTemplates(studioOwnerId);
    sendJsonResponse(req, res, 200, templates);
  } catch (error) {
    console.error("Error listing email templates:", error);
    handleError(req, res, error);
  }
});

app.get("/:id", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    const template = await emailTemplatesService.getTemplate(req.params["id"] as string, studioOwnerId);
    if (!template) return sendErrorResponse(req, res, 404, "Not Found", "Template not found");
    sendJsonResponse(req, res, 200, template);
  } catch (error) {
    console.error("Error getting email template:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    const { name, design, html } = (req.body ?? {}) as { name?: string; design?: unknown; html?: string };
    if (!name || !name.trim()) return sendErrorResponse(req, res, 400, "Validation Error", "name is required");
    if (!design) return sendErrorResponse(req, res, 400, "Validation Error", "design is required");
    const id = await emailTemplatesService.saveTemplate(studioOwnerId, name.trim(), design as Record<string, unknown>, html ?? "");
    sendJsonResponse(req, res, 201, { id });
  } catch (error) {
    console.error("Error saving email template:", error);
    handleError(req, res, error);
  }
});

app.put("/:id", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    const { name, design, html } = (req.body ?? {}) as { name?: string; design?: unknown; html?: string };
    if (!name || !name.trim()) return sendErrorResponse(req, res, 400, "Validation Error", "name is required");
    if (!design) return sendErrorResponse(req, res, 400, "Validation Error", "design is required");
    await emailTemplatesService.updateTemplate(req.params["id"] as string, studioOwnerId, name.trim(), design as Record<string, unknown>, html ?? "");
    sendJsonResponse(req, res, 200, { success: true });
  } catch (error) {
    console.error("Error updating email template:", error);
    handleError(req, res, error);
  }
});

app.delete("/:id", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    await emailTemplatesService.deleteTemplate(req.params["id"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { success: true });
  } catch (error) {
    console.error("Error deleting email template:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const emailTemplates = functions.https.onRequest(app);
