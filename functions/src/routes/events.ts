import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import eventsService from "../services/events.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { validateCreateEventPayload, validateUpdateEventPayload } from "../utils/validation";
import { sanitizeRichText } from "../utils/sanitize";
import { getFirestore } from "../utils/firestore";
import {
  sendVendorConfirmationEmail,
  sendVendorApprovalEmail,
  sendVendorDeclineEmail,
} from "../services/sendgrid.service";
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
    if (typeof eventData["description"] === "string") {
      eventData["description"] = sanitizeRichText(eventData["description"]);
    }

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

    const db = getFirestore();
    const purchasesSnapshot = await db.collection("purchases")
      .where("purchaseType", "==", "event")
      .where("itemId", "==", id)
      .where("studioOwnerId", "==", studioOwnerId)
      .where("status", "==", "completed")
      .get();

    const rawTiers = ((eventData as Record<string, unknown>)["priceTiers"] as Array<Record<string, unknown>>) ?? [];
    const priceToTierName = new Map<number, string>();
    for (const tier of rawTiers) {
      priceToTierName.set(tier["price"] as number, (tier["name"] as string) || "");
    }

    const attendees: Record<string, unknown>[] = [];
    for (const doc of purchasesSnapshot.docs) {
      const purchase = doc.data() as Record<string, unknown>;
      let firstName = "";
      let lastName = "";
      let email = "";
      let city: string | null = null;
      let state: string | null = null;
      let zip: string | null = null;
      if (purchase["studentId"]) {
        try {
          const studentDoc = await db.collection("students").doc(purchase["studentId"] as string).get();
          if (studentDoc.exists) {
            const s = studentDoc.data() as Record<string, unknown>;
            firstName = (s["firstName"] as string) || "";
            lastName = (s["lastName"] as string) || "";
            email = (s["email"] as string) || "";
            city = (s["city"] as string) || null;
            state = (s["state"] as string) || null;
            zip = (s["zip"] as string) || null;
          }
        } catch (err) {
          console.error(`Error fetching student ${purchase["studentId"]}:`, err);
        }
      }

      if (!firstName && !email && purchase["authUid"]) {
        try {
          const userSnapshot = await db.collection("users").where("authUid", "==", purchase["authUid"]).limit(1).get();
          if (!userSnapshot.empty) {
            const firstDoc = userSnapshot.docs[0];
            if (firstDoc) {
              const u = firstDoc.data() as Record<string, unknown>;
              firstName = firstName || (u["firstName"] as string) || "";
              lastName = lastName || (u["lastName"] as string) || "";
              email = email || (u["email"] as string) || "";
            }
          }
        } catch (err) {
          console.error(`Error fetching user profile ${purchase["authUid"]}:`, err);
        }
      }

      const meta = (purchase["metadata"] as Record<string, unknown>) ?? {};
      const tierBreakdown = (meta["tierBreakdown"] as Array<{ tierName: string; quantity: number; unitPrice: number; total: number }> | undefined) ?? null;
      const priceTierName = tierBreakdown && tierBreakdown.length > 0
        ? (tierBreakdown[0]?.tierName ?? null)
        : (priceToTierName.get(purchase["price"] as number) ?? null);

      attendees.push({
        id: doc.id,
        purchaseId: doc.id,
        firstName, lastName, email, city, state, zip,
        priceTierName,
        priceTierPrice: purchase["price"] || null,
        price: purchase["price"] || 0,
        tierBreakdown,
        purchaseDate: purchase["createdAt"] || null,
        checkedIn: purchase["checkedIn"] || false,
        checkedInAt: purchase["checkedInAt"] || null,
        checkedInBy: purchase["checkedInBy"] || null,
        eventCode: null,
        stripePaymentIntentId: purchase["stripePaymentIntentId"] || null,
        teamName: (meta["teamName"] as string) || null,
      });
    }

    sendJsonResponse(req, res, 200, attendees);
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

    const db = getFirestore();
    const purchasesSnapshot = await db.collection("purchases")
      .where("purchaseType", "==", "event")
      .where("itemId", "==", id)
      .where("studioOwnerId", "==", studioOwnerId)
      .where("status", "==", "completed")
      .get();

    const purchases = purchasesSnapshot.docs.map((d) => d.data() as Record<string, unknown>);
    const totalRevenue = purchases.reduce((sum, p) => sum + ((p["price"] as number) || 0), 0);
    const checkedInCount = purchases.filter((p) => p["checkedIn"] === true).length;

    const priceTiers = (eventData["priceTiers"] as Array<Record<string, unknown>>) || [];
    const tierMap = new Map<string, { tierName: string; quantity: number; revenue: number }>();
    for (const tier of priceTiers) {
      const name = ((tier["name"] as string) || "Tier").toLowerCase();
      tierMap.set(name, { tierName: (tier["name"] as string) || "Tier", quantity: 0, revenue: 0 });
    }

    const fallback = { tierName: "Other", quantity: 0, revenue: 0 };
    let totalTickets = 0;

    for (const purchase of purchases) {
      const meta = (purchase["metadata"] as Record<string, unknown>) || {};
      const breakdown = meta["tierBreakdown"] as Array<{ tierName: string; quantity: number; unitPrice: number; total: number }> | undefined;

      if (breakdown && breakdown.length > 0) {
        for (const line of breakdown) {
          totalTickets += line.quantity;
          const entry = tierMap.get(line.tierName.toLowerCase());
          if (entry) {
            entry.quantity += line.quantity;
            entry.revenue += line.total;
          } else {
            fallback.quantity += line.quantity;
            fallback.revenue += line.total;
          }
        }
      } else {
        totalTickets += 1;
        const price = (purchase["price"] as number) || 0;
        const matched = [...tierMap.values()].find(
          (e) => Math.abs((priceTiers.find((t) => t["name"] === e.tierName)?.["price"] as number ?? 0) - price) < 0.01,
        );
        if (matched) {
          matched.quantity += 1;
          matched.revenue += price;
        } else {
          fallback.quantity += 1;
          fallback.revenue += price;
        }
      }
    }

    const ticketSalesByTier = [...tierMap.values()];
    if (fallback.quantity > 0) ticketSalesByTier.push(fallback);

    sendJsonResponse(req, res, 200, {
      eventId: id,
      name: (eventData["name"] as string) || "Event",
      attendeesCount: totalTickets,
      checkedInCount,
      ticketSalesByTier,
      totalTickets,
      totalRevenue,
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
    if (typeof eventData["description"] === "string") {
      eventData["description"] = sanitizeRichText(eventData["description"]);
    }

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

// ─── Performer Applications ────────────────────────────────────────────────────

app.post("/performer-applications", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { eventId, teamName, answers } = req.body as {
      eventId: string;
      teamName: string;
      answers: Record<string, string>;
    };

    if (!eventId || typeof eventId !== "string") {
      return sendErrorResponse(req, res, 400, "Bad Request", "eventId is required");
    }
    if (!teamName || typeof teamName !== "string" || teamName.trim() === "") {
      return sendErrorResponse(req, res, 400, "Bad Request", "teamName is required");
    }

    const db = getFirestore();
    const eventDoc = await db.collection("events").doc(eventId).get();
    if (!eventDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
    }

    const docRef = await db.collection("performerApplications").add({
      eventId,
      studioOwnerId: eventDoc.data()!["studioOwnerId"],
      teamName: teamName.trim(),
      answers: answers ?? {},
      status: "pending",
      paymentUrl: null,
      submittedBy: user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 201, { id: docRef.id });
  } catch (error) {
    console.error("Error submitting performer application:", error);
    handleError(req, res, error);
  }
});

// ─── Vendor Applications ──────────────────────────────────────────────────────

app.post("/vendor-applications", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { eventId, businessName, email, answers } = req.body as {
      eventId: string;
      businessName: string;
      email: string;
      answers: Record<string, string>;
    };

    if (!eventId || typeof eventId !== "string") {
      return sendErrorResponse(req, res, 400, "Bad Request", "eventId is required");
    }
    if (!businessName || typeof businessName !== "string" || businessName.trim() === "") {
      return sendErrorResponse(req, res, 400, "Bad Request", "businessName is required");
    }
    if (!email || typeof email !== "string" || email.trim() === "") {
      return sendErrorResponse(req, res, 400, "Bad Request", "email is required");
    }

    const db = getFirestore();
    const eventDoc = await db.collection("events").doc(eventId).get();
    if (!eventDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
    }

    const eventData = eventDoc.data()!;
    const docRef = await db.collection("vendorApplications").add({
      eventId,
      studioOwnerId: eventData["studioOwnerId"],
      businessName: businessName.trim(),
      email: email.trim().toLowerCase(),
      answers: answers ?? {},
      status: "pending",
      declineReason: null,
      paymentUrl: null,
      submittedBy: user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    try {
      await sendVendorConfirmationEmail(
        email.trim(),
        businessName.trim(),
        eventData["name"] as string ?? "the event",
        eventData["studioName"] as string ?? "the studio",
      );
    } catch (emailErr) {
      console.warn("[vendor-applications] confirmation email failed:", emailErr);
    }

    sendJsonResponse(req, res, 201, { id: docRef.id });
  } catch (error) {
    console.error("Error submitting vendor application:", error);
    handleError(req, res, error);
  }
});

app.post("/vendor-applications/:appId/approve", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { appId } = req.params;
    const { paymentUrl } = req.body as { paymentUrl: string };

    if (!paymentUrl || typeof paymentUrl !== "string") {
      return sendErrorResponse(req, res, 400, "Bad Request", "paymentUrl is required");
    }

    const db = getFirestore();
    const appDoc = await db.collection("vendorApplications").doc(appId).get();
    if (!appDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Vendor application not found");
    }

    const appData = appDoc.data()!;
    const ownerDoc = await db.collection("users").doc(appData["studioOwnerId"]).get();
    if (!ownerDoc.exists || ownerDoc.data()!["authUid"] !== user.uid) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Access denied");
    }

    await appDoc.ref.update({
      status: "approved",
      paymentUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const eventDoc = await db.collection("events").doc(appData["eventId"]).get();
    const eventName = (eventDoc.data()?.["name"] as string) ?? "the event";

    try {
      await sendVendorApprovalEmail(
        appData["email"] as string,
        appData["businessName"] as string,
        eventName,
        paymentUrl,
      );
    } catch (emailErr) {
      console.warn("[vendor-applications/approve] approval email failed:", emailErr);
    }

    sendJsonResponse(req, res, 200, { success: true });
  } catch (error) {
    console.error("Error approving vendor application:", error);
    handleError(req, res, error);
  }
});

app.post("/vendor-applications/:appId/decline", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { appId } = req.params;
    const { reason } = req.body as { reason: string };

    if (!reason || typeof reason !== "string" || reason.trim() === "") {
      return sendErrorResponse(req, res, 400, "Bad Request", "reason is required");
    }

    const db = getFirestore();
    const appDoc = await db.collection("vendorApplications").doc(appId).get();
    if (!appDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Vendor application not found");
    }

    const appData = appDoc.data()!;
    const ownerDoc = await db.collection("users").doc(appData["studioOwnerId"]).get();
    if (!ownerDoc.exists || ownerDoc.data()!["authUid"] !== user.uid) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Access denied");
    }

    await appDoc.ref.update({
      status: "declined",
      declineReason: reason.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const eventDoc = await db.collection("events").doc(appData["eventId"]).get();
    const eventName = (eventDoc.data()?.["name"] as string) ?? "the event";

    try {
      await sendVendorDeclineEmail(
        appData["email"] as string,
        appData["businessName"] as string,
        eventName,
        reason.trim(),
      );
    } catch (emailErr) {
      console.warn("[vendor-applications/decline] decline email failed:", emailErr);
    }

    sendJsonResponse(req, res, 200, { success: true });
  } catch (error) {
    console.error("Error declining vendor application:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const events = functions.https.onRequest(app);
