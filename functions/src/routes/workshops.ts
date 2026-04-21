import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import workshopsService from "../services/workshops.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { validateCreateWorkshopPayload, validateUpdateWorkshopPayload } from "../utils/validation";
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
      level: (req.query["level"] as string) || null,
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
    const workshops = await workshopsService.getAllPublicWorkshops(filters);
    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("Error getting public workshops:", error);
    handleError(req, res, error);
  }
});

app.get("/public/:id", async (req, res) => {
  try {
    const workshopData = await workshopsService.getPublicWorkshopById(req.params["id"] as string);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found or not available");
    }
    sendJsonResponse(req, res, 200, workshopData);
  } catch (error) {
    console.error("Error getting public workshop:", error);
    handleError(req, res, error);
  }
});

app.get("/upcoming", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const db = getFirestore();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const snapshot = await db.collection("workshops").where("studioOwnerId", "==", studioOwnerId).get();

    const workshops: Record<string, unknown>[] = [];
    snapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const startRaw = data["startTime"] as { toDate?: () => Date } | string | null;
      const startDate = startRaw && typeof startRaw === "object" && startRaw.toDate
        ? startRaw.toDate()
        : (startRaw ? new Date(startRaw as string) : null);
      if (startDate && startDate >= today) {
        const endRaw = data["endTime"] as { toDate?: () => Date } | string | null;
        workshops.push({
          id: doc.id,
          ...data,
          startTime: startDate.toISOString(),
          endTime: endRaw && typeof endRaw === "object" && endRaw.toDate
            ? endRaw.toDate().toISOString()
            : (endRaw || null),
        });
      }
    });

    workshops.sort((a, b) => new Date(a["startTime"] as string).getTime() - new Date(b["startTime"] as string).getTime());
    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("Error getting upcoming workshops:", error);
    handleError(req, res, error);
  }
});

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const workshops = await workshopsService.getWorkshops(studioOwnerId);
    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("Error getting workshops:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { imageFile, ...workshopData } = req.body as Record<string, unknown>;

    const validation = validateCreateWorkshopPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid workshop data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const workshopId = await workshopsService.createWorkshop(workshopData, studioOwnerId);

    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `workshop-${Date.now()}.${extension}`;
        const imageUrl = await storageService.uploadWorkshopImage(fileBuffer, fileName, mimeType, studioOwnerId, workshopId);
        await workshopsService.updateWorkshop(workshopId, { imageUrl }, studioOwnerId);
      } catch (imageError) {
        console.error("Error uploading workshop image:", imageError);
      }
    }

    sendJsonResponse(req, res, 201, { id: workshopId, message: "Workshop created successfully" });
  } catch (error) {
    console.error("Error creating workshop:", error);
    handleError(req, res, error);
  }
});

app.get("/:id/attendees", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;
    const db = getFirestore();
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const workshopData = await workshopsService.getWorkshopById(id, studioOwnerId);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");
    }

    const purchasesSnapshot = await db.collection("purchases")
      .where("purchaseType", "==", "workshop")
      .where("itemId", "==", id)
      .where("studioOwnerId", "==", studioOwnerId)
      .where("status", "==", "completed")
      .get();

    const attendees: Record<string, unknown>[] = [];
    for (const doc of purchasesSnapshot.docs) {
      const purchase = doc.data() as Record<string, unknown>;
      let firstName = "";
      let lastName = "";
      let email = "";
      let city: string | null = null;
      let state: string | null = null;
      let zip: string | null = null;
      const isGuest = !purchase["studentId"] || purchase["studentId"] === "guest";

      if (purchase["studentId"] && purchase["studentId"] !== "guest") {
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

      if (!firstName && !email && purchase["authUid"] && purchase["authUid"] !== "guest") {
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

      attendees.push({
        id: doc.id,
        purchaseId: doc.id,
        firstName, lastName, email, city, state, zip,
        priceTierName: null,
        priceTierPrice: purchase["price"] || null,
        price: purchase["price"] || 0,
        purchaseDate: purchase["createdAt"] || null,
        checkedIn: purchase["checkedIn"] || false,
        checkedInAt: purchase["checkedInAt"] || null,
        checkedInBy: purchase["checkedInBy"] || null,
        eventCode: null,
        stripePaymentIntentId: purchase["stripePaymentIntentId"] || null,
        isGuest,
      });
    }

    sendJsonResponse(req, res, 200, attendees);
  } catch (error) {
    console.error("Error getting workshop attendees:", error);
    handleError(req, res, error);
  }
});

app.get("/:id/report", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;
    const db = getFirestore();

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const workshopData = await workshopsService.getWorkshopById(id, studioOwnerId) as Record<string, unknown> | null;
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");
    }

    const purchasesSnapshot = await db.collection("purchases")
      .where("purchaseType", "==", "workshop")
      .where("itemId", "==", id)
      .where("studioOwnerId", "==", studioOwnerId)
      .where("status", "==", "completed")
      .get();

    const purchases = purchasesSnapshot.docs.map((d) => d.data() as Record<string, unknown>);
    const totalTickets = purchases.length;
    const totalRevenue = purchases.reduce((sum, p) => sum + ((p["price"] as number) || 0), 0);
    const checkedInCount = purchases.filter((p) => p["checkedIn"] === true).length;

    const priceTiers = (workshopData["priceTiers"] as Array<Record<string, unknown>>) || [];
    const tierMap = new Map<number, { tierName: string; quantity: number; revenue: number }>();
    for (const tier of priceTiers) {
      tierMap.set(tier["price"] as number, {
        tierName: (tier["name"] as string) || "Tier",
        quantity: 0,
        revenue: 0,
      });
    }

    const fallback = { tierName: "General", quantity: 0, revenue: 0 };
    for (const purchase of purchases) {
      const price = (purchase["price"] as number) || 0;
      const entry = tierMap.get(price);
      if (entry) {
        entry.quantity += 1;
        entry.revenue += price;
      } else {
        fallback.quantity += 1;
        fallback.revenue += price;
      }
    }

    const ticketSalesByTier = [...tierMap.values()];
    if (fallback.quantity > 0) ticketSalesByTier.push(fallback);

    sendJsonResponse(req, res, 200, {
      workshopId: id,
      name: (workshopData["name"] as string) || "Workshop",
      attendeesCount: totalTickets,
      checkedInCount,
      ticketSalesByTier,
      totalTickets,
      totalRevenue,
    });
  } catch (error) {
    console.error("Error getting workshop report:", error);
    handleError(req, res, error);
  }
});

app.get("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const workshopData = await workshopsService.getWorkshopById(req.params["id"] as string, studioOwnerId);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");
    }

    sendJsonResponse(req, res, 200, workshopData);
  } catch (error) {
    console.error("Error getting workshop:", error);
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
    const { imageFile, ...workshopData } = req.body as Record<string, unknown>;

    const validation = validateUpdateWorkshopPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid workshop data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    let imageUrl: string | undefined;
    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `workshop-${Date.now()}.${extension}`;
        imageUrl = await storageService.uploadWorkshopImage(fileBuffer, fileName, mimeType, studioOwnerId, id);
      } catch (imageError) {
        console.error("Error uploading workshop image:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", (imageError as Error).message || "Failed to upload workshop image");
      }
    }

    const payload = imageUrl !== undefined ? { ...workshopData, imageUrl } : workshopData;
    await workshopsService.updateWorkshop(id, payload, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Workshop updated successfully" });
  } catch (error) {
    console.error("Error updating workshop:", error);
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

    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await workshopsService.deleteWorkshop(req.params["id"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Workshop deleted successfully" });
  } catch (error) {
    console.error("Error deleting workshop:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const workshops = functions.https.onRequest(app);
