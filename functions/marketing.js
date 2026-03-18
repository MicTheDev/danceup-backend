const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const studentsService = require("./services/students.service");
const marketingService = require("./services/marketing.service");
const sendgridService = require("./services/sendgrid.service");
const {verifyToken} = require("./utils/auth");
const {sendJsonResponse, sendErrorResponse, handleError} = require("./utils/http");

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  next();
});

const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return callback(null, true);
    }
    callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({extended: true}));

function getUnsubscribeBaseUrl(req) {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  const region = process.env.FUNCTION_REGION || "us-central1";
  if (project) {
    return `https://${region}-${project}.cloudfunctions.net/marketing`;
  }
  const host = req.get("host");
  const protocol = req.protocol || "https";
  return host ? `${protocol}://${host}` : "";
}

const DEFAULT_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "info@danceup.app";
const DEFAULT_FROM_NAME = process.env.SENDGRID_FROM_NAME || "DanceUp";

/**
 * GET /recipients - List subscribed students (requires auth)
 */
app.get("/recipients", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
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

/**
 * GET /templates - List available SendGrid dynamic templates (requires auth)
 */
app.get("/templates", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
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

/**
 * POST /send - Send campaign (requires auth)
 * Body (template): { subject, templateId, bodyContent?, recipientIds?: string[], sendToAll?: boolean }
 * Body (custom):   { subject, bodyHtml?, bodyText?, recipientIds?: string[], sendToAll?: boolean }
 */
app.post("/send", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const {subject, bodyHtml, bodyText, templateId, bodyContent, recipientIds, sendToAll} = req.body || {};
    if (!subject || (typeof subject !== "string") || !subject.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "subject is required");
    }
    const hasTemplate = typeof templateId === "string" && !!templateId.trim();
    const hasHtml = bodyHtml != null && typeof bodyHtml === "string";
    const hasText = bodyText != null && typeof bodyText === "string";
    if (!hasTemplate && !hasHtml && !hasText) {
      return sendErrorResponse(req, res, 400, "Validation Error", "templateId or bodyHtml/bodyText is required");
    }

    const allRecipients = await marketingService.getSubscribedRecipients(studioOwnerId);
    let toSend = allRecipients;
    if (!sendToAll && Array.isArray(recipientIds) && recipientIds.length > 0) {
      const idSet = new Set(recipientIds);
      toSend = allRecipients.filter((r) => idSet.has(r.id));
    }
    if (toSend.length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "No recipients selected or no subscribed students");
    }

    const baseUrl = getUnsubscribeBaseUrl(req);
    const {campaignId, category: categoryId} = await marketingService.createCampaign(
        studioOwnerId,
        subject.trim(),
        toSend.length,
        hasTemplate ? undefined : (hasText ? bodyText : undefined),
        hasTemplate ? undefined : (hasHtml ? bodyHtml : undefined),
    );

    const from = {email: DEFAULT_FROM_EMAIL, name: DEFAULT_FROM_NAME};

    for (const recipient of toSend) {
      const token = await marketingService.createUnsubscribeToken(recipient.authUid);
      const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;

      let msg;
      if (hasTemplate) {
        const firstName = recipient.firstName || recipient.name?.split(" ")[0] || "";
        msg = {
          to: recipient.email,
          from,
          templateId: templateId.trim(),
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
        const html = hasHtml ? (bodyHtml + footerHtml) : null;
        const text = hasText ? (bodyText + footerText) : null;
        msg = {
          to: recipient.email,
          from,
          subject: subject.trim(),
          categories: [categoryId],
        };
        if (html) msg.html = html;
        if (text) msg.text = text;
      }

      try {
        await sendgridService.sendEmail(msg);
      } catch (sendErr) {
        console.error("SendGrid error for", recipient.email, sendErr);
        // Continue with other recipients; campaign is already created
      }
    }

    sendJsonResponse(req, res, 201, {campaignId, recipientCount: toSend.length});
  } catch (error) {
    console.error("Error sending campaign:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /campaigns - List campaigns (requires auth)
 */
app.get("/campaigns", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
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

/**
 * GET /campaigns/:id - Get a single campaign by ID (requires auth)
 */
app.get("/campaigns/:id", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const campaign = await marketingService.getCampaignById(req.params.id, studioOwnerId);
    if (!campaign) {
      return sendErrorResponse(req, res, 404, "Not Found", "Campaign not found");
    }
    sendJsonResponse(req, res, 200, campaign);
  } catch (error) {
    console.error("Error getting campaign:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /campaigns/:id/stats - Get campaign stats (requires auth)
 */
app.get("/campaigns/:id/stats", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const campaignId = req.params.id;
    const campaign = await marketingService.getCampaignById(campaignId, studioOwnerId);
    if (!campaign) {
      return sendErrorResponse(req, res, 404, "Not Found", "Campaign not found");
    }

    const sentAt = campaign.sentAt ? new Date(campaign.sentAt) : new Date();
    const startDate = sentAt.toISOString().slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    let sendgridStats = {};
    let statsError = null;
    if (campaign.category) {
      const result = await sendgridService.getCategoryStats(campaign.category, startDate, endDate);
      sendgridStats = result.metrics || result;
      if (result.error) statsError = result.error;
    }

    sendJsonResponse(req, res, 200, {
      campaign: {
        id: campaign.id,
        subject: campaign.subject,
        recipientCount: campaign.recipientCount,
        sentAt: campaign.sentAt,
      },
      stats: sendgridStats,
      statsError: statsError || undefined,
    });
  } catch (error) {
    console.error("Error getting campaign stats:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /unsubscribe - One-click unsubscribe (no auth). Query: ?token=<signed_token>
 */
app.get("/unsubscribe", async (req, res) => {
  const token = req.query.token;
  const htmlPage = (message, success = true) => {
    const title = success ? "Unsubscribed" : "Error";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;max-width:480px;margin:48px auto;padding:24px;"><h1>${title}</h1><p>${message}</p></body></html>`;
  };

  if (!token) {
    res.status(400).set("Content-Type", "text/html").send(htmlPage("Missing unsubscribe token.", false));
    return;
  }

  try {
    const authUid = await marketingService.verifyUnsubscribeToken(token);
    await marketingService.unsubscribeByAuthUid(authUid);
    res.status(200).set("Content-Type", "text/html").send(htmlPage("You have been unsubscribed. You will no longer receive marketing emails from this studio."));
  } catch (err) {
    console.error("Unsubscribe error:", err);
    const msg = err.message && (err.message.includes("expired") || err.message.includes("Invalid")) ? err.message : "This link is invalid or has expired.";
    res.status(400).set("Content-Type", "text/html").send(htmlPage(msg, false));
  }
});

app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

exports.marketing = functions.https.onRequest(app);
