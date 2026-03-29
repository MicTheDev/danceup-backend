const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const studentsService = require("./services/students.service");
const emailTemplatesService = require("./services/email-templates.service");
const {verifyToken} = require("./utils/auth");
const {sendJsonResponse, sendErrorResponse, handleError, corsOptions, isAllowedOrigin} = require("./utils/http");

const app = express();

// CORS — only reflect origin if it is in the allowlist
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({limit: "5mb"})); // design JSON can be large
app.use(express.urlencoded({extended: true}));

async function getStudioOwner(req, res) {
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

/**
 * GET / - List templates (metadata only)
 */
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

/**
 * GET /:id - Get a single template including design JSON
 */
app.get("/:id", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    const template = await emailTemplatesService.getTemplate(req.params.id, studioOwnerId);
    if (!template) return sendErrorResponse(req, res, 404, "Not Found", "Template not found");
    sendJsonResponse(req, res, 200, template);
  } catch (error) {
    console.error("Error getting email template:", error);
    handleError(req, res, error);
  }
});

/**
 * POST / - Save a new template
 * Body: { name, design, html }
 */
app.post("/", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    const {name, design, html} = req.body || {};
    if (!name || !name.trim()) return sendErrorResponse(req, res, 400, "Validation Error", "name is required");
    if (!design) return sendErrorResponse(req, res, 400, "Validation Error", "design is required");
    const id = await emailTemplatesService.saveTemplate(studioOwnerId, name.trim(), design, html || "");
    sendJsonResponse(req, res, 201, {id});
  } catch (error) {
    console.error("Error saving email template:", error);
    handleError(req, res, error);
  }
});

/**
 * PUT /:id - Update an existing template
 * Body: { name, design, html }
 */
app.put("/:id", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    const {name, design, html} = req.body || {};
    if (!name || !name.trim()) return sendErrorResponse(req, res, 400, "Validation Error", "name is required");
    if (!design) return sendErrorResponse(req, res, 400, "Validation Error", "design is required");
    await emailTemplatesService.updateTemplate(req.params.id, studioOwnerId, name.trim(), design, html || "");
    sendJsonResponse(req, res, 200, {success: true});
  } catch (error) {
    console.error("Error updating email template:", error);
    handleError(req, res, error);
  }
});

/**
 * DELETE /:id - Delete a template
 */
app.delete("/:id", async (req, res) => {
  try {
    const studioOwnerId = await getStudioOwner(req, res);
    if (!studioOwnerId) return;
    await emailTemplatesService.deleteTemplate(req.params.id, studioOwnerId);
    sendJsonResponse(req, res, 200, {success: true});
  } catch (error) {
    console.error("Error deleting email template:", error);
    handleError(req, res, error);
  }
});

app.use((err, req, res, next) => handleError(req, res, err));

exports.emailTemplates = functions.https.onRequest(app);
