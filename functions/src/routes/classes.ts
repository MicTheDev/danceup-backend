import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import classesService from "../services/classes.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { validateCreateClassPayload, validateUpdateClassPayload } from "../utils/validation";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  next();
});

app.use(cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

app.get("/public", async (req, res) => {
  try {
    const filters = {
      danceGenre: (req.query["danceGenre"] as string) || null,
      city: (req.query["city"] as string) || null,
      state: (req.query["state"] as string) || null,
      studioName: (req.query["studioName"] as string) || null,
      minPrice: req.query["minPrice"] ? parseFloat(req.query["minPrice"] as string) : null,
      maxPrice: req.query["maxPrice"] ? parseFloat(req.query["maxPrice"] as string) : null,
      level: (req.query["level"] as string) || null,
      lat: req.query["lat"] ? parseFloat(req.query["lat"] as string) : null,
      lng: req.query["lng"] ? parseFloat(req.query["lng"] as string) : null,
      radius: req.query["radius"] ? parseFloat(req.query["radius"] as string) : null,
      limit: req.query["limit"] ? parseInt(req.query["limit"] as string, 10) : null,
    };
    const classes = await classesService.getAllPublicClasses(filters);
    sendJsonResponse(req, res, 200, classes);
  } catch (error) {
    console.error("Error getting public classes:", error);
    handleError(req, res, error);
  }
});

app.get("/public/:id", async (req, res) => {
  try {
    const classData = await classesService.getPublicClassById(req.params["id"] as string);
    if (!classData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Class not found or not available");
    }
    const relatedClasses = await classesService.getRelatedClasses(
      req.params["id"] as string,
      (classData as Record<string, unknown>)["studioOwnerId"] as string,
      4,
    );
    sendJsonResponse(req, res, 200, { ...classData, relatedClasses });
  } catch (error) {
    console.error("Error getting public class:", error);
    handleError(req, res, error);
  }
});

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const classes = await classesService.getClasses(studioOwnerId);
    sendJsonResponse(req, res, 200, classes);
  } catch (error) {
    console.error("Error getting classes:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const validation = validateCreateClassPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid class data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const classBody: Record<string, unknown> = { ...req.body };
    if (classBody["imageFile"] && typeof classBody["imageFile"] === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(classBody["imageFile"] as string);
        const mimeType = storageService.getMimeTypeFromBase64(classBody["imageFile"] as string);
        const fileName = `class-image.${mimeType.split("/")[1]}`;
        classBody["imageUrl"] = await storageService.uploadClassImage(fileBuffer, fileName, mimeType, studioOwnerId, "new");
      } catch (imageError) {
        return sendErrorResponse(req, res, 400, "Image Upload Failed", (imageError as Error).message || "Failed to upload class image");
      }
    }
    delete classBody["imageFile"];

    const classId = await classesService.createClass(classBody, studioOwnerId);
    sendJsonResponse(req, res, 201, { id: classId, message: "Class created successfully" });
  } catch (error) {
    console.error("Error creating class:", error);
    handleError(req, res, error);
  }
});

app.get("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const classData = await classesService.getClassById(req.params["id"] as string, studioOwnerId);
    if (!classData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Class not found");
    }

    sendJsonResponse(req, res, 200, classData);
  } catch (error) {
    console.error("Error getting class:", error);
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

    const validation = validateUpdateClassPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid class data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const updateBody: Record<string, unknown> = { ...req.body };
    if (updateBody["imageFile"] && typeof updateBody["imageFile"] === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(updateBody["imageFile"] as string);
        const mimeType = storageService.getMimeTypeFromBase64(updateBody["imageFile"] as string);
        const fileName = `class-image.${mimeType.split("/")[1]}`;
        updateBody["imageUrl"] = await storageService.uploadClassImage(fileBuffer, fileName, mimeType, studioOwnerId, req.params["id"] as string);
      } catch (imageError) {
        return sendErrorResponse(req, res, 400, "Image Upload Failed", (imageError as Error).message || "Failed to upload class image");
      }
    }
    delete updateBody["imageFile"];

    await classesService.updateClass(req.params["id"] as string, updateBody, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Class updated successfully" });
  } catch (error) {
    console.error("Error updating class:", error);
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

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await classesService.deleteClass(req.params["id"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Class deleted successfully" });
  } catch (error) {
    console.error("Error deleting class:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.post("/:classId/waitlist", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const { classId } = req.params;
    const { studentId, classInstanceDate } = req.body as Record<string, string>;
    if (!studentId || !classInstanceDate) {
      return sendErrorResponse(req, res, 400, "Validation Error", "studentId and classInstanceDate are required");
    }

    const entryId = await classesService.addToWaitlist(classId as string, studentId, classInstanceDate, studioOwnerId);
    sendJsonResponse(req, res, 201, { id: entryId, message: "Added to waitlist successfully" });
  } catch (error) {
    console.error("Error adding to waitlist:", error);
    const msg = (error as Error).message;
    if (msg?.includes("already on the waitlist")) return sendErrorResponse(req, res, 409, "Conflict", msg);
    handleError(req, res, error);
  }
});

app.get("/:classId/waitlist", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const { classId } = req.params;
    const classInstanceDate = req.query["classInstanceDate"] as string | undefined;
    if (!classInstanceDate) {
      return sendErrorResponse(req, res, 400, "Validation Error", "classInstanceDate query parameter is required");
    }

    const waitlist = await classesService.getWaitlist(classId as string, classInstanceDate);
    sendJsonResponse(req, res, 200, waitlist);
  } catch (error) {
    console.error("Error getting waitlist:", error);
    handleError(req, res, error);
  }
});

app.delete("/:classId/waitlist/:entryId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await classesService.removeFromWaitlist(req.params["entryId"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Removed from waitlist successfully" });
  } catch (error) {
    console.error("Error removing from waitlist:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const classes = functions.https.onRequest(app);
