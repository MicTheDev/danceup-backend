import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import instructorsService from "../services/instructors.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { validateCreateInstructorPayload, validateUpdateInstructorPayload } from "../utils/validation";
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

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const instructors = await instructorsService.getInstructors(studioOwnerId);
    sendJsonResponse(req, res, 200, instructors);
  } catch (error) {
    console.error("Error getting instructors:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { photoFile, ...instructorData } = req.body as Record<string, unknown>;

    const validation = validateCreateInstructorPayload(instructorData);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid instructor data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    let photoUrl: string | null = null;
    if (photoFile && typeof photoFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(photoFile);
        const mimeType = storageService.getMimeTypeFromBase64(photoFile);
        const fileName = `instructor-${Date.now()}.${mimeType.split("/")[1]}`;
        photoUrl = await storageService.uploadInstructorPhoto(fileBuffer, fileName, mimeType);
      } catch (imageError) {
        console.error("Error uploading instructor photo:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", (imageError as Error).message || "Failed to upload instructor photo");
      }
    }

    const payload = photoUrl ? { ...instructorData, photoUrl } : instructorData;
    const instructorId = await instructorsService.createInstructor(payload, studioOwnerId);

    sendJsonResponse(req, res, 201, { id: instructorId, message: "Instructor created successfully" });
  } catch (error) {
    console.error("Error creating instructor:", error);
    handleError(req, res, error);
  }
});

app.get("/options", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const instructors = await instructorsService.getInstructors(studioOwnerId);
    const options = (instructors as Array<Record<string, unknown>>).map((instructor) => ({
      id: instructor["id"],
      name: `${instructor["firstName"] as string} ${instructor["lastName"] as string}`.trim(),
    }));

    sendJsonResponse(req, res, 200, options);
  } catch (error) {
    console.error("Error getting instructor options:", error);
    handleError(req, res, error);
  }
});

app.get("/public/:id", async (req, res) => {
  try {
    const instructorData = await instructorsService.getPublicInstructorById(req.params["id"] as string);
    if (!instructorData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    }
    sendJsonResponse(req, res, 200, instructorData);
  } catch (error) {
    console.error("Error getting public instructor:", error);
    handleError(req, res, error);
  }
});

app.get("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const instructorData = await instructorsService.getInstructorById(req.params["id"] as string, studioOwnerId);
    if (!instructorData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    }

    sendJsonResponse(req, res, 200, instructorData);
  } catch (error) {
    console.error("Error getting instructor:", error);
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

    const { photoFile, ...instructorData } = req.body as Record<string, unknown>;

    const validation = validateUpdateInstructorPayload(instructorData);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid instructor data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    let photoUrl: string | undefined;
    if (photoFile && typeof photoFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(photoFile);
        const mimeType = storageService.getMimeTypeFromBase64(photoFile);
        const fileName = `instructor-${Date.now()}.${mimeType.split("/")[1]}`;
        photoUrl = await storageService.uploadInstructorPhoto(fileBuffer, fileName, mimeType);
      } catch (imageError) {
        console.error("Error uploading instructor photo:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", (imageError as Error).message || "Failed to upload instructor photo");
      }
    }

    const payload = photoUrl !== undefined ? { ...instructorData, photoUrl } : instructorData;
    await instructorsService.updateInstructor(req.params["id"] as string, payload, studioOwnerId);

    sendJsonResponse(req, res, 200, { message: "Instructor updated successfully" });
  } catch (error) {
    console.error("Error updating instructor:", error);
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

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await instructorsService.deleteInstructor(req.params["id"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Instructor deleted successfully" });
  } catch (error) {
    console.error("Error deleting instructor:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const instructors = functions.https.onRequest(app);
