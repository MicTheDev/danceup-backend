import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import eventsService from "../services/events.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { validateCreateEventPayload, validateUpdateEventPayload } from "../utils/validation";
import { getFirestore } from "../utils/firestore";
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

app.get("/public", async (req, res) => {
  try {
    const filters = {
      type: (req.query["type"] as string) || null,
      city: (req.query["city"] as string) || null,
      state: (req.query["state"] as string) || null,
      studioName: (req.query["studioName"] as string) || null,
      minPrice: req.query["minPrice"] ? parseFloat(req.query["minPrice"] as string) : null,
      maxPrice: req.query["maxPrice"] ? parseFloat(req.query["maxPrice"] as string) : null,
      startDate: (req.query["startDate"] as string) || null,
      endDate: (req.query["endDate"] as string) || null,
      lat: req.query["lat"] ? parseFloat(req.query["lat"] as string) : null,
      lng: req.query["lng"] ? parseFloat(req.query["lng"] as string) : null,
      radius: req.query["radius"] ? parseFloat(req.query["radius"] as string) : null,
      limit: req.query["limit"] ? parseInt(req.query["limit"] as string, 10) : null,
    };
    const events = await eventsService.getAllPublicEvents(filters);
    sendJsonResponse(req, res, 200, events);
  } catch (error) {
    console.error("Error getting public events:", error);
    handleError(req, res, error);
  }
});

app.get("/public/:id", async (req, res) => {
  try {
    const eventData = await eventsService.getPublicEventById(req.params["id"] as string);
    if (!eventData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found or not available");
    }
    sendJsonResponse(req, res, 200, eventData);
  } catch (error) {
    console.error("Error getting public event:", error);
    handleError(req, res, error);
  }
});

app.get("/upcoming", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const db = getFirestore();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const snapshot = await db.collection("events").where("studioOwnerId", "==", studioOwnerId).get();

    const events: Record<string, unknown>[] = [];
    snapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const startRaw = data["startTime"] as { toDate?: () => Date } | string | null;
      const startDate = startRaw && typeof startRaw === "object" && startRaw.toDate
        ? startRaw.toDate()
        : (startRaw ? new Date(startRaw as string) : null);
      if (startDate && startDate >= today) {
        const endRaw = data["endTime"] as { toDate?: () => Date } | string | null;
        events.push({
          id: doc.id,
          ...data,
          startTime: startDate.toISOString(),
          endTime: endRaw && typeof endRaw === "object" && endRaw.toDate
            ? endRaw.toDate().toISOString()
            : (endRaw || null),
        });
      }
    });

    events.sort((a, b) => new Date(a["startTime"] as string).getTime() - new Date(b["startTime"] as string).getTime());
    sendJsonResponse(req, res, 200, events);
  } catch (error) {
    console.error("Error getting upcoming events:", error);
    handleError(req, res, error);
  }
});

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const events = await eventsService.getEvents(studioOwnerId);
    sendJsonResponse(req, res, 200, events);
  } catch (error) {
    console.error("Error getting events:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { imageFile, ...eventData } = req.body as Record<string, unknown>;

    const validation = validateCreateEventPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid event data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const eventId = await eventsService.createEvent(eventData, studioOwnerId);

    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `event-${Date.now()}.${extension}`;
        const imageUrl = await storageService.uploadEventImage(fileBuffer, fileName, mimeType, studioOwnerId, eventId);
        await eventsService.updateEvent(eventId, { imageUrl }, studioOwnerId);
      } catch (imageError) {
        console.error("Error uploading event image:", imageError);
      }
    }

    sendJsonResponse(req, res, 201, { id: eventId, message: "Event created successfully" });
  } catch (error) {
    console.error("Error creating event:", error);
    handleError(req, res, error);
  }
});

app.get("/:id/attendees", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const eventData = await eventsService.getEventById(id, studioOwnerId);
    if (!eventData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
    }

    sendJsonResponse(req, res, 200, []);
  } catch (error) {
    console.error("Error getting event attendees:", error);
    handleError(req, res, error);
  }
});

app.get("/:id/report", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const eventData = await eventsService.getEventById(id, studioOwnerId) as Record<string, unknown> | null;
    if (!eventData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
    }

    const priceTiers = (eventData["priceTiers"] as Array<Record<string, unknown>>) || [];
    const ticketSalesByTier = priceTiers.map((t) => ({
      tierName: (t["name"] as string) || "Tier",
      quantity: 0,
      revenue: 0,
    }));

    sendJsonResponse(req, res, 200, {
      eventId: id,
      name: (eventData["name"] as string) || "Event",
      attendeesCount: 0,
      ticketSalesByTier,
      totalTickets: 0,
      totalRevenue: 0,
    });
  } catch (error) {
    console.error("Error getting event report:", error);
    handleError(req, res, error);
  }
});

app.get("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const eventData = await eventsService.getEventById(req.params["id"] as string, studioOwnerId);
    if (!eventData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
    }

    sendJsonResponse(req, res, 200, eventData);
  } catch (error) {
    console.error("Error getting event:", error);
    if ((error as Error).message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", (error as Error).message);
    }
    handleError(req, res, error);
  }
});

app.put("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;
    const { imageFile, ...eventData } = req.body as Record<string, unknown>;

    const validation = validateUpdateEventPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid event data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    let imageUrl: string | undefined;
    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `event-${Date.now()}.${extension}`;
        imageUrl = await storageService.uploadEventImage(fileBuffer, fileName, mimeType, studioOwnerId, id);
      } catch (imageError) {
        console.error("Error uploading event image:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", (imageError as Error).message || "Failed to upload event image");
      }
    }

    const payload = imageUrl !== undefined ? { ...eventData, imageUrl } : eventData;
    await eventsService.updateEvent(id, payload, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Event updated successfully" });
  } catch (error) {
    console.error("Error updating event:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.delete("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await eventsService.deleteEvent(req.params["id"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Event deleted successfully" });
  } catch (error) {
    console.error("Error deleting event:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const events = functions.https.onRequest(app);
