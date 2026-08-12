import * as functions from "firebase-functions";
import express, { Request, Response } from "express";
import cors from "cors";
import workshopsService from "../services/workshops.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { validateCreateWorkshopPayload, validateUpdateWorkshopPayload, validateRequiredString } from "../utils/validation";
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

// GET / — every workshop across every studio, optionally filtered to one studio.
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const studioOwnerId = req.query["studioOwnerId"] as string | undefined;
    const workshops = await workshopsService.getAllWorkshopsForAdmin(studioOwnerId);
    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("danceup-admin-workshops list error:", error);
    handleError(req, res, error);
  }
});

// GET /:id — any studio's workshop, enriched with studio info.
app.get("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const workshop = await workshopsService.getWorkshopByIdForAdmin(req.params["id"] as string);
    if (!workshop) return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");

    sendJsonResponse(req, res, 200, workshop);
  } catch (error) {
    console.error("danceup-admin-workshops detail error:", error);
    handleError(req, res, error);
  }
});

// POST / — create a workshop on behalf of any studio (studioOwnerId required in body).
app.post("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateCreateWorkshopPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid workshop data", {
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

    const { imageFile, studioOwnerId: _ignored, ...workshopData } = req.body as Record<string, unknown>;
    if (typeof workshopData["description"] === "string") {
      workshopData["description"] = sanitizeRichText(workshopData["description"]);
    }

    const workshopId = await workshopsService.createWorkshopForAdmin(workshopData, studioOwnerId as string, user.uid);

    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `workshop-${Date.now()}.${extension}`;
        const imageUrl = await storageService.uploadWorkshopImage(fileBuffer, fileName, mimeType, studioOwnerId as string, workshopId);
        await workshopsService.updateWorkshopForAdmin(workshopId, { imageUrl }, user.uid);
      } catch (imageError) {
        console.error("Error uploading workshop image:", imageError);
      }
    }

    logAuditEvent(user.uid, studioOwnerId as string, "workshop_admin_created", "workshop", workshopId);
    sendJsonResponse(req, res, 201, { id: workshopId, message: "Workshop created successfully" });
  } catch (error) {
    console.error("danceup-admin-workshops create error:", error);
    handleError(req, res, error);
  }
});

// PUT /:id — field updates only; ownership changes only via POST /:id/assign.
app.put("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateUpdateWorkshopPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid workshop data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const workshopId = req.params["id"] as string;
    const { imageFile, studioOwnerId: _ignored, ...workshopData } = req.body as Record<string, unknown>;
    if (typeof workshopData["description"] === "string") {
      workshopData["description"] = sanitizeRichText(workshopData["description"]);
    }

    let imageUrl: string | undefined;
    if (imageFile && typeof imageFile === "string") {
      const existing = await workshopsService.getWorkshopByIdForAdmin(workshopId);
      if (!existing) return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `workshop-${Date.now()}.${extension}`;
        imageUrl = await storageService.uploadWorkshopImage(
          fileBuffer, fileName, mimeType, existing["studioOwnerId"] as string, workshopId,
        );
      } catch (imageError) {
        console.error("Error uploading workshop image:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", (imageError as Error).message || "Failed to upload workshop image");
      }
    }

    const payload = imageUrl !== undefined ? { ...workshopData, imageUrl } : workshopData;
    await workshopsService.updateWorkshopForAdmin(workshopId, payload, user.uid);
    logAuditEvent(user.uid, "", "workshop_admin_updated", "workshop", workshopId);
    sendJsonResponse(req, res, 200, { message: "Workshop updated successfully" });
  } catch (error) {
    console.error("danceup-admin-workshops update error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

// DELETE /:id — remove any studio's workshop.
app.delete("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const workshopId = req.params["id"] as string;
    logAuditEvent(user.uid, "", "workshop_admin_deleted", "workshop", workshopId);
    await workshopsService.deleteWorkshopForAdmin(workshopId);
    sendJsonResponse(req, res, 200, { message: "Workshop deleted successfully" });
  } catch (error) {
    console.error("danceup-admin-workshops delete error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

// POST /:id/assign — reassign a workshop to a different studio (real or placeholder).
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

    const workshopId = req.params["id"] as string;
    const result = await workshopsService.reassignWorkshop(workshopId, studioOwnerId as string, user.uid);
    logAuditEvent(user.uid, result.toStudioOwnerId, "workshop_reassigned", "workshop", workshopId, {
      fromStudioOwnerId: result.fromStudioOwnerId,
      toStudioOwnerId: result.toStudioOwnerId,
    });
    sendJsonResponse(req, res, 200, { message: "Workshop reassigned successfully" });
  } catch (error) {
    console.error("danceup-admin-workshops assign error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

export const danceupAdminWorkshops = functions.https.onRequest(app);
