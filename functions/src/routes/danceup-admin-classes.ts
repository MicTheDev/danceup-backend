import * as functions from "firebase-functions";
import express, { Request, Response } from "express";
import cors from "cors";
import classesService from "../services/classes.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { validateCreateClassPayload, validateUpdateClassPayload, validateRequiredString } from "../utils/validation";
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

// GET / — every class across every studio, optionally filtered to one studio.
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const studioOwnerId = req.query["studioOwnerId"] as string | undefined;
    const classes = await classesService.getAllClassesForAdmin(studioOwnerId);
    sendJsonResponse(req, res, 200, classes);
  } catch (error) {
    console.error("danceup-admin-classes list error:", error);
    handleError(req, res, error);
  }
});

// GET /:id — any studio's class, enriched with studio + instructor info.
app.get("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const classData = await classesService.getClassByIdForAdmin(req.params["id"] as string);
    if (!classData) return sendErrorResponse(req, res, 404, "Not Found", "Class not found");

    sendJsonResponse(req, res, 200, classData);
  } catch (error) {
    console.error("danceup-admin-classes detail error:", error);
    handleError(req, res, error);
  }
});

// POST / — create a class on behalf of any studio (studioOwnerId required in body).
app.post("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateCreateClassPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid class data", {
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

    const classBody: Record<string, unknown> = { ...req.body };
    delete classBody["studioOwnerId"];
    if (typeof classBody["description"] === "string") {
      classBody["description"] = sanitizeRichText(classBody["description"]);
    }
    if (classBody["imageFile"] && typeof classBody["imageFile"] === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(classBody["imageFile"] as string);
        const mimeType = storageService.getMimeTypeFromBase64(classBody["imageFile"] as string);
        const fileName = `class-image.${mimeType.split("/")[1]}`;
        classBody["imageUrl"] = await storageService.uploadClassImage(fileBuffer, fileName, mimeType, studioOwnerId as string, "new");
      } catch (imageError) {
        return sendErrorResponse(req, res, 400, "Image Upload Failed", (imageError as Error).message || "Failed to upload class image");
      }
    }
    delete classBody["imageFile"];

    const classId = await classesService.createClassForAdmin(classBody, studioOwnerId as string, user.uid);
    logAuditEvent(user.uid, studioOwnerId as string, "class_admin_created", "class", classId);
    sendJsonResponse(req, res, 201, { id: classId, message: "Class created successfully" });
  } catch (error) {
    console.error("danceup-admin-classes create error:", error);
    handleError(req, res, error);
  }
});

// PUT /:id — field updates only; ownership changes only via POST /:id/assign.
app.put("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateUpdateClassPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid class data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const classId = req.params["id"] as string;
    const updateBody: Record<string, unknown> = { ...req.body };
    delete updateBody["studioOwnerId"];
    if (typeof updateBody["description"] === "string") {
      updateBody["description"] = sanitizeRichText(updateBody["description"]);
    }
    if (updateBody["imageFile"] && typeof updateBody["imageFile"] === "string") {
      const existing = await classesService.getClassByIdForAdmin(classId);
      if (!existing) return sendErrorResponse(req, res, 404, "Not Found", "Class not found");
      try {
        const fileBuffer = storageService.base64ToBuffer(updateBody["imageFile"] as string);
        const mimeType = storageService.getMimeTypeFromBase64(updateBody["imageFile"] as string);
        const fileName = `class-image.${mimeType.split("/")[1]}`;
        updateBody["imageUrl"] = await storageService.uploadClassImage(
          fileBuffer, fileName, mimeType, existing["studioOwnerId"] as string, classId,
        );
      } catch (imageError) {
        return sendErrorResponse(req, res, 400, "Image Upload Failed", (imageError as Error).message || "Failed to upload class image");
      }
    }
    delete updateBody["imageFile"];

    await classesService.updateClassForAdmin(classId, updateBody, user.uid);
    logAuditEvent(user.uid, "", "class_admin_updated", "class", classId);
    sendJsonResponse(req, res, 200, { message: "Class updated successfully" });
  } catch (error) {
    console.error("danceup-admin-classes update error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

// DELETE /:id — remove any studio's class.
app.delete("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const classId = req.params["id"] as string;
    logAuditEvent(user.uid, "", "class_admin_deleted", "class", classId);
    await classesService.deleteClassForAdmin(classId);
    sendJsonResponse(req, res, 200, { message: "Class deleted successfully" });
  } catch (error) {
    console.error("danceup-admin-classes delete error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

// POST /:id/assign — reassign a class to a different studio (real or placeholder).
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

    const classId = req.params["id"] as string;
    const result = await classesService.reassignClass(classId, studioOwnerId as string, user.uid);
    logAuditEvent(user.uid, result.toStudioOwnerId, "class_reassigned", "class", classId, {
      fromStudioOwnerId: result.fromStudioOwnerId,
      toStudioOwnerId: result.toStudioOwnerId,
      clearedInstructorsAndRoom: result.clearedInstructorsAndRoom,
    });
    sendJsonResponse(req, res, 200, {
      message: "Class reassigned successfully",
      clearedInstructorsAndRoom: result.clearedInstructorsAndRoom,
    });
  } catch (error) {
    console.error("danceup-admin-classes assign error:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    handleError(req, res, error);
  }
});

export const danceupAdminClasses = functions.https.onRequest(app);
