import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import studentsService from "../services/students.service";
import * as marketingService from "../services/marketing.service";
import * as sendgridService from "../services/sendgrid.service";
import * as aiService from "../services/ai.service";
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
app.use(express.urlencoded({ extended: true }));

function getUnsubscribeBaseUrl(req: Request): string {
  const project = process.env["GCLOUD_PROJECT"] || process.env["GCP_PROJECT"];
  const region = process.env["FUNCTION_REGION"] || "us-central1";
  if (project) {
    return `https://${region}-${project}.cloudfunctions.net/marketing`;
  }
  const host = req.get("host");
  const protocol = req.protocol || "https";
  return host ? `${protocol}://${host}` : "";
}

const DEFAULT_FROM_EMAIL = process.env["SENDGRID_FROM_EMAIL"] || "info@danceup.app";
const DEFAULT_FROM_NAME = process.env["SENDGRID_FROM_NAME"] || "DanceUp";

app.get("/content", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const content = await marketingService.getStudioContentPreview(studioOwnerId);
    sendJsonResponse(req, res, 200, content);
  } catch (error) {
    console.error("Error fetching studio content:", error);
    handleError(req, res, error);
  }
});

app.post("/generate", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const tone = (body["tone"] as string) || "community";
    const selectedClassIds = body["selectedClassIds"];
    const selectedEventIds = body["selectedEventIds"];
    const selectedWorkshopIds = body["selectedWorkshopIds"];
    const instructions = body["instructions"];
    const imageUrl = body["imageUrl"];

    const validTones = ["promotional", "informational", "community"];
    const resolvedTone = validTones.includes(tone) ? tone : "community";
    const resolvedInstructions = typeof instructions === "string" ? instructions.trim().slice(0, 500) : "";
    const resolvedImageUrl = typeof imageUrl === "string" && imageUrl.trim().startsWith("http") ? imageUrl.trim() : null;

    const { studioName, classes, events, workshops } = await marketingService.getStudioContentForAI(studioOwnerId, {
      selectedClassIds: Array.isArray(selectedClassIds) ? (selectedClassIds as string[]) : undefined,
      selectedEventIds: Array.isArray(selectedEventIds) ? (selectedEventIds as string[]) : undefined,
      selectedWorkshopIds: Array.isArray(selectedWorkshopIds) ? (selectedWorkshopIds as string[]) : undefined,
    }) as { studioName: string; classes: unknown[]; events: unknown[]; workshops: unknown[] };

    const { subject, htmlBody } = await (aiService.generateEmailCampaign as (arg: { studioName: string; classes: unknown[]; events: unknown[]; workshops: unknown[]; tone: string; instructions?: string; imageUrl?: string }) => Promise<{ subject: string; htmlBody: string }>)({
      studioName,
      classes,
      events,
      workshops,
      tone: resolvedTone,
      instructions: resolvedInstructions || undefined,
      imageUrl: resolvedImageUrl || undefined,
    });

    sendJsonResponse(req, res, 200, { subject, htmlBody });
  } catch (error) {
    console.error("Error generating AI campaign:", error);
    handleError(req, res, error);
  }
});

app.get("/recipients", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const recipients = await marketingService.getSubscribedRecipients(studioOwnerId);
    sendJsonResponse(req, res, 200, recipients);
  } catch (error) {
    console.error("Error getting recipients:", error);
    handleError(req, res, error);
  }
});

app.get("/templates", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const templates = await sendgridService.getTemplates();
    sendJsonResponse(req, res, 200, templates);
  } catch (error) {
    console.error("Error fetching templates:", error);
    handleError(req, res, error);
  }
});

app.post("/send", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const { subject, bodyHtml, bodyText, templateId, bodyContent, recipientIds, sendToAll } = (req.body || {}) as {
      subject?: string;
      bodyHtml?: string;
      bodyText?: string;
      templateId?: string;
      bodyContent?: string;
      recipientIds?: string[];
      sendToAll?: boolean;
    };

    if (!subject || typeof subject !== "string" || !subject.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "subject is required");
    }
    const hasTemplate = typeof templateId === "string" && !!templateId.trim();
    const hasHtml = bodyHtml != null && typeof bodyHtml === "string";
    const hasText = bodyText != null && typeof bodyText === "string";
    if (!hasTemplate && !hasHtml && !hasText) {
      return sendErrorResponse(req, res, 400, "Validation Error", "templateId or bodyHtml/bodyText is required");
    }

    const allRecipients = await marketingService.getSubscribedRecipients(studioOwnerId) as Array<Record<string, unknown>>;
    let toSend = allRecipients;
    if (!sendToAll && Array.isArray(recipientIds) && recipientIds.length > 0) {
      const idSet = new Set(recipientIds);
      toSend = allRecipients.filter((r) => idSet.has(r["id"] as string));
    }
    if (toSend.length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "No recipients selected or no subscribed students");
    }

    const baseUrl = getUnsubscribeBaseUrl(req);
    const campaignResult = await marketingService.createCampaign(
      studioOwnerId,
      subject.trim(),
      toSend.length,
      hasTemplate ? undefined : (hasText ? bodyText : undefined),
      hasTemplate ? undefined : (hasHtml ? bodyHtml : undefined),
    ) as { campaignId: string; category: string };
    const { campaignId, category: categoryId } = campaignResult;

    const from = { email: DEFAULT_FROM_EMAIL, name: DEFAULT_FROM_NAME };

    for (const recipient of toSend) {
      const token = await marketingService.createUnsubscribeToken(recipient["authUid"] as string) as string;
      const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;

      let msg: Record<string, unknown>;
      if (hasTemplate) {
        const firstName = (recipient["firstName"] as string) || (recipient["name"] as string | undefined)?.split(" ")?.[0] || "";
        msg = {
          to: recipient["email"],
          from,
          templateId: (templateId as string).trim(),
          dynamicTemplateData: {
            firstName,
            subject: subject.trim(),
            bodyContent: bodyContent || "",
            unsubscribeUrl,
          },
          categories: [categoryId],
        };
      } else {
        const footerHtml = `<p style="margin-top:24px;font-size:12px;color:#666;">If you no longer wish to receive these emails, <a href="${unsubscribeUrl}">unsubscribe here</a>.</p>`;
        const footerText = `\n\nIf you no longer wish to receive these emails, unsubscribe here: ${unsubscribeUrl}`;
        const html = hasHtml ? (bodyHtml as string) + footerHtml : null;
        const text = hasText ? (bodyText as string) + footerText : null;
        msg = {
          to: recipient["email"],
          from,
          subject: subject.trim(),
          categories: [categoryId],
        };
        if (html) msg["html"] = html;
        if (text) msg["text"] = text;
      }

      try {
        await sendgridService.sendEmail(msg as unknown as Parameters<typeof sendgridService.sendEmail>[0]);
      } catch (sendErr) {
        console.error("SendGrid error for", recipient["email"], sendErr);
      }
    }

    sendJsonResponse(req, res, 201, { campaignId, recipientCount: toSend.length });
  } catch (error) {
    console.error("Error sending campaign:", error);
    handleError(req, res, error);
  }
});

app.get("/campaigns", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const campaigns = await marketingService.listCampaigns(studioOwnerId);
    sendJsonResponse(req, res, 200, campaigns);
  } catch (error) {
    console.error("Error listing campaigns:", error);
    handleError(req, res, error);
  }
});

// /campaigns/:id/stats must come BEFORE /campaigns/:id to avoid route conflict
app.get("/campaigns/:id/stats", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const campaignId = req.params["id"] as string;
    const campaign = await marketingService.getCampaignById(campaignId, studioOwnerId) as Record<string, unknown> | null;
    if (!campaign) {
      return sendErrorResponse(req, res, 404, "Not Found", "Campaign not found");
    }

    const sentAt = campaign["sentAt"] ? new Date(campaign["sentAt"] as string) : new Date();
    const startDate = sentAt.toISOString().slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    let sendgridStats: Record<string, unknown> = {};
    let statsError: string | null = null;
    if (campaign["category"]) {
      const result = await sendgridService.getCategoryStats(campaign["category"] as string, startDate, endDate) as unknown as Record<string, unknown>;
      sendgridStats = (result["metrics"] as Record<string, unknown>) || result;
      if (result["error"]) statsError = result["error"] as string;
    }

    sendJsonResponse(req, res, 200, {
      campaign: {
        id: campaign["id"],
        subject: campaign["subject"],
        recipientCount: campaign["recipientCount"],
        sentAt: campaign["sentAt"],
      },
      stats: sendgridStats,
      statsError: statsError || undefined,
    });
  } catch (error) {
    console.error("Error getting campaign stats:", error);
    handleError(req, res, error);
  }
});

app.get("/campaigns/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const campaign = await marketingService.getCampaignById(req.params["id"] as string, studioOwnerId);
    if (!campaign) {
      return sendErrorResponse(req, res, 404, "Not Found", "Campaign not found");
    }
    sendJsonResponse(req, res, 200, campaign);
  } catch (error) {
    console.error("Error getting campaign:", error);
    handleError(req, res, error);
  }
});

app.get("/unsubscribe", async (req, res) => {
  const token = req.query["token"] as string | undefined;
  const htmlPage = (message: string, success = true): string => {
    const title = success ? "Unsubscribed" : "Error";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;max-width:480px;margin:48px auto;padding:24px;"><h1>${title}</h1><p>${message}</p></body></html>`;
  };

  if (!token) {
    res.status(400).set("Content-Type", "text/html").send(htmlPage("Missing unsubscribe token.", false));
    return;
  }

  try {
    const authUid = await marketingService.verifyUnsubscribeToken(token) as string;
    await marketingService.unsubscribeByAuthUid(authUid);
    res.status(200).set("Content-Type", "text/html").send(htmlPage("You have been unsubscribed. You will no longer receive marketing emails from this studio."));
  } catch (err) {
    console.error("Unsubscribe error:", err);
    const errMsg = (err as Error).message || "";
    const msg = errMsg.includes("expired") || errMsg.includes("Invalid") ? errMsg : "This link is invalid or has expired.";
    res.status(400).set("Content-Type", "text/html").send(htmlPage(msg, false));
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const marketing = functions.https.onRequest(app);
