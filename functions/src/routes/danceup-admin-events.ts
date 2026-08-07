import * as functions from "firebase-functions";
import express, { Request, Response } from "express";
import cors from "cors";
import eventsService from "../services/events.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { validateCreateEventPayload, validateUpdateEventPayload, validateRequiredString } from "../utils/validation";
import { sanitizeRichText } from "../utils/sanitize";
import { logAuditEvent } from "../services/audit.service";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";
import { getFirestore } from "../utils/firestore";

const app = express();

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  next();
});

app.use(cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);

// GET / — every event across every studio, optionally filtered to one studio.
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const studioOwnerId = req.query["studioOwnerId"] as string | undefined;
    const events = await eventsService.getAllEventsForAdmin(studioOwnerId);
    sendJsonResponse(req, res, 200, events);
  } catch (error) {
    console.error("danceup-admin-events list error:", error);
    handleError(req, res, error);
  }
});

// GET /:id — any studio's event, enriched with studio info.
app.get("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const event = await eventsService.getEventByIdForAdmin(req.params["id"] as string);
    if (!event) return sendErrorResponse(req, res, 404, "Not Found", "Event not found");

    sendJsonResponse(req, res, 200, event);
  } catch (error) {
    console.error("danceup-admin-events detail error:", error);
    handleError(req, res, error);
  }
});

// POST / — create an event on behalf of any studio (studioOwnerId required in body).
app.post("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateCreateEventPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid event data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = req.body["studioOwnerId"] as string | undefined;
    const studioV = validateRequiredString(studioOwnerId, "Studio");
    if (!studioV.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", studioV.message ?? "Studio is required");
    }

    const studioDoc = await getFirestore().collection("users").doc(studioOwnerId as string).get();
    if (!studioDoc.exists) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Studio not found");
    }

    const { imageFile, studioOwnerId: _ignored, ...eventData } = req.body as Record<string, unknown>;
    if (typeof eventData["description"] === "string") {
      eventData["description"] = sanitizeRichText(eventData["description"]);
    }

    const eventId = await eventsService.createEventForAdmin(eventData, studioOwnerId as string, user.uid);

    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `event-${Date.now()}.${extension}`;
        const imageUrl = await storageService.uploadEventImage(fileBuffer, fileName, mimeType, studioOwnerId as string, eventId);
        await eventsService.updateEventForAdmin(eventId, { imageUrl }, user.uid);
      } catch (imageError) {
        console.error("Error uploading event image:", imageError);
      }
    }

    logAuditEvent(user.uid, studioOwnerId as string, "event_admin_created", "event", eventId);
    sendJsonResponse(req, res, 201, { id: eventId, message: "Event created successfully" });
  } catch (error) {
    console.error("danceup-admin-events create error:", error);
    handleError(req, res, error);
  }
});

// PUT /:id — field updates only; ownership changes only via POST /:id/assign.
app.put("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateUpdateEventPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid event data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const eventId = req.params["id"] as string;
    const { imageFile, studioOwnerId: _ignored, ...eventData } = req.body as Record<string, unknown>;
    if (typeof eventData["description"] === "string") {
      eventData["description"] = sanitizeRichText(eventData["description"]);
    }

    let imageUrl: string | undefined;
    if (imageFile && typeof imageFile === "string") {
      const existing = await eventsService.getEventByIdForAdmin(eventId);
      if (!existing) return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `event-${Date.now()}.${extension}`;
        imageUrl = await storageService.uploadEventImage(
          fileBuffer, fileName, mimeType, existing["studioOwnerId"] as string, eventId,
        );
      } catch (imageError) {
        console.error("Error uploading event image:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", (imageError as Error).message || "Failed to upload event image");
      }
    }

    const payload = imageUrl !== undefined ? { ...eventData, imageUrl } : eventData;
    await eventsService.updateEventForAdmin(eventId, payload, user.uid);
    logAuditEvent(user.uid, "", "event_admin_updated", "event", eventId);
    sendJsonResponse(req, res, 200, { message: "Event updated successfully" });
  } catch (error) {
    console.error("danceup-admin-events update error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

// DELETE /:id — remove any studio's event.
app.delete("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const eventId = req.params["id"] as string;
    logAuditEvent(user.uid, "", "event_admin_deleted", "event", eventId);
    await eventsService.deleteEventForAdmin(eventId);
    sendJsonResponse(req, res, 200, { message: "Event deleted successfully" });
  } catch (error) {
    console.error("danceup-admin-events delete error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

// POST /:id/assign — reassign an event to a different studio (real or placeholder).
app.post("/:id/assign", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const studioOwnerId = req.body["studioOwnerId"] as string | undefined;
    const studioV = validateRequiredString(studioOwnerId, "Studio");
    if (!studioV.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", studioV.message ?? "Studio is required");
    }

    const eventId = req.params["id"] as string;
    const result = await eventsService.reassignEvent(eventId, studioOwnerId as string, user.uid);
    logAuditEvent(user.uid, result.toStudioOwnerId, "event_reassigned", "event", eventId, {
      fromStudioOwnerId: result.fromStudioOwnerId,
      toStudioOwnerId: result.toStudioOwnerId,
    });
    sendJsonResponse(req, res, 200, { message: "Event reassigned successfully" });
  } catch (error) {
    console.error("danceup-admin-events assign error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

export const danceupAdminEvents = functions.https.onRequest(app);
