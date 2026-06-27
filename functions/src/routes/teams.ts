import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import authService from "../services/auth.service";
import storageService from "../services/storage.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const VALID_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TIME_REGEX = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;

interface PracticeSlot {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
}

function validatePracticeSchedule(schedule: unknown): string | null {
  if (!Array.isArray(schedule)) return "practiceSchedule must be an array";
  for (const slot of schedule as PracticeSlot[]) {
    if (!VALID_DAYS.includes(slot.dayOfWeek)) return `Invalid dayOfWeek: ${slot.dayOfWeek}`;
    if (!TIME_REGEX.test(slot.startTime)) return "startTime must be in HH:mm format";
    if (!TIME_REGEX.test(slot.endTime)) return "endTime must be in HH:mm format";
  }
  return null;
}

const app = express();

app.use((req: Request, res: Response, next: NextFunction) => {
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

/**
 * GET /
 * List all performance teams for the authenticated studio owner
 */
app.get("/", async (req: Request, res: Response) => {
  try {
    let user: { uid: string };
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    if (!authService.hasStudioOwnerRole(userDoc)) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");

    const db = getFirestore();
    const snapshot = await db.collection("performanceTeams")
      .where("studioOwnerId", "==", userDoc.id)
      .orderBy("createdAt", "desc")
      .get();

    const teams: object[] = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      teams.push({
        id: doc.id,
        name: data["name"],
        description: data["description"] || null,
        imageUrl: data["imageUrl"] || null,
        memberIds: data["memberIds"] || [],
        memberCount: (data["memberIds"] || []).length,
        practiceSchedule: data["practiceSchedule"] || [],
        createdAt: data["createdAt"],
        updatedAt: data["updatedAt"],
      });
    });

    sendJsonResponse(req, res, 200, teams);
  } catch (error) {
    console.error("Get teams error:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new performance team
 */
app.post("/", async (req: Request, res: Response) => {
  try {
    let user: { uid: string };
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    if (!authService.hasStudioOwnerRole(userDoc)) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");

    const { name, description, memberIds, practiceSchedule, teamImageFile } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Team name is required");
    }
    if (!Array.isArray(memberIds)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "memberIds must be an array");
    }
    const scheduleError = validatePracticeSchedule(practiceSchedule || []);
    if (scheduleError) return sendErrorResponse(req, res, 400, "Validation Error", scheduleError);

    let imageUrl: string | null = null;
    if (teamImageFile && typeof teamImageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(teamImageFile);
        const mimeType = storageService.getMimeTypeFromBase64(teamImageFile);
        const fileName = `team-image-${user.uid}-${Date.now()}.${mimeType.split("/")[1]}`;
        imageUrl = await storageService.uploadStudioImage(fileBuffer, fileName, mimeType);
      } catch (imgErr: unknown) {
        const msg = imgErr instanceof Error ? imgErr.message : "Failed to upload team image";
        return sendErrorResponse(req, res, 400, "Image Upload Failed", msg);
      }
    }

    const db = getFirestore();
    const teamData = {
      studioOwnerId: userDoc.id,
      name: name.trim(),
      description: description ? (description as string).trim() : null,
      imageUrl,
      memberIds: (memberIds as unknown[]).filter((id) => typeof id === "string" && id.trim()),
      practiceSchedule: practiceSchedule || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("performanceTeams").add(teamData);
    sendJsonResponse(req, res, 201, { id: docRef.id, ...teamData });
  } catch (error) {
    console.error("Create team error:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id
 * Get a single team with enriched member data
 */
app.get("/:id", async (req: Request, res: Response) => {
  try {
    let user: { uid: string };
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    if (!authService.hasStudioOwnerRole(userDoc)) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");

    const db = getFirestore();
    const teamDoc = await db.collection("performanceTeams").doc(req.params["id"] as string).get();
    if (!teamDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Team not found");

    const teamData = teamDoc.data()!;
    if (teamData["studioOwnerId"] !== userDoc.id) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Team does not belong to this studio");
    }

    const memberIds: string[] = teamData["memberIds"] || [];
    const members: object[] = [];
    if (memberIds.length > 0) {
      const studentsSnapshot = await db.collection("students")
        .where("studioOwnerId", "==", userDoc.id)
        .get();
      const studentMap: Record<string, FirebaseFirestore.DocumentData> = {};
      studentsSnapshot.forEach((doc) => { studentMap[doc.id] = doc.data(); });
      for (const memberId of memberIds) {
        const s = studentMap[memberId];
        if (s) {
          members.push({
            id: memberId,
            firstName: s["firstName"] || "",
            lastName: s["lastName"] || "",
            email: s["email"] || null,
            lastAttendedAt: s["lastAttendedAt"] || null,
          });
        }
      }
    }

    sendJsonResponse(req, res, 200, {
      id: teamDoc.id,
      studioOwnerId: teamData["studioOwnerId"],
      name: teamData["name"],
      description: teamData["description"] || null,
      imageUrl: teamData["imageUrl"] || null,
      memberIds,
      memberCount: memberIds.length,
      practiceSchedule: teamData["practiceSchedule"] || [],
      members,
      createdAt: teamData["createdAt"],
      updatedAt: teamData["updatedAt"],
    });
  } catch (error) {
    console.error("Get team error:", error);
    handleError(req, res, error);
  }
});

/**
 * PUT /:id
 * Update a performance team
 */
app.put("/:id", async (req: Request, res: Response) => {
  try {
    let user: { uid: string };
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    if (!authService.hasStudioOwnerRole(userDoc)) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");

    const teamId = req.params["id"] as string;
    const db = getFirestore();
    const teamDoc = await db.collection("performanceTeams").doc(teamId).get();
    if (!teamDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Team not found");
    const teamData = teamDoc.data()!;
    if (teamData["studioOwnerId"] !== userDoc.id) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Team does not belong to this studio");
    }

    const { name, description, memberIds, practiceSchedule, teamImageFile } = req.body;
    const updateData: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (name !== undefined) {
      if (!name || typeof name !== "string" || !name.trim()) {
        return sendErrorResponse(req, res, 400, "Validation Error", "Team name cannot be empty");
      }
      updateData["name"] = (name as string).trim();
    }
    if (description !== undefined) {
      updateData["description"] = description ? (description as string).trim() : null;
    }
    if (memberIds !== undefined) {
      if (!Array.isArray(memberIds)) return sendErrorResponse(req, res, 400, "Validation Error", "memberIds must be an array");
      updateData["memberIds"] = (memberIds as unknown[]).filter((id) => typeof id === "string" && (id as string).trim());
    }
    if (practiceSchedule !== undefined) {
      const scheduleError = validatePracticeSchedule(practiceSchedule);
      if (scheduleError) return sendErrorResponse(req, res, 400, "Validation Error", scheduleError);
      updateData["practiceSchedule"] = practiceSchedule;
    }
    if (teamImageFile && typeof teamImageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(teamImageFile);
        const mimeType = storageService.getMimeTypeFromBase64(teamImageFile);
        const fileName = `team-image-${user.uid}-${Date.now()}.${mimeType.split("/")[1]}`;
        updateData["imageUrl"] = await storageService.uploadStudioImage(fileBuffer, fileName, mimeType);
        const oldUrl = teamData["imageUrl"] as string | undefined;
        if (oldUrl && oldUrl !== updateData["imageUrl"]) {
          storageService.deleteFile(oldUrl).catch((e: unknown) => console.error("Error deleting old team image:", e));
        }
      } catch (imgErr: unknown) {
        const msg = imgErr instanceof Error ? imgErr.message : "Failed to upload team image";
        return sendErrorResponse(req, res, 400, "Image Upload Failed", msg);
      }
    }

    await db.collection("performanceTeams").doc(teamId).update(updateData);
    const updated = await db.collection("performanceTeams").doc(teamId).get();
    const data = updated.data()!;

    sendJsonResponse(req, res, 200, {
      id: updated.id,
      studioOwnerId: data["studioOwnerId"],
      name: data["name"],
      description: data["description"] || null,
      imageUrl: data["imageUrl"] || null,
      memberIds: data["memberIds"] || [],
      memberCount: (data["memberIds"] || []).length,
      practiceSchedule: data["practiceSchedule"] || [],
      createdAt: data["createdAt"],
      updatedAt: data["updatedAt"],
    });
  } catch (error) {
    console.error("Update team error:", error);
    handleError(req, res, error);
  }
});

/**
 * DELETE /:id
 * Delete a performance team
 */
app.delete("/:id", async (req: Request, res: Response) => {
  try {
    let user: { uid: string };
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    if (!authService.hasStudioOwnerRole(userDoc)) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");

    const teamId = req.params["id"] as string;
    const db = getFirestore();
    const teamDoc = await db.collection("performanceTeams").doc(teamId).get();
    if (!teamDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Team not found");
    const teamData = teamDoc.data()!;
    if (teamData["studioOwnerId"] !== userDoc.id) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Team does not belong to this studio");
    }

    const imageUrl = teamData["imageUrl"] as string | undefined;
    await db.collection("performanceTeams").doc(teamId).delete();
    if (imageUrl) {
      storageService.deleteFile(imageUrl).catch((e: unknown) => console.error("Error deleting team image:", e));
    }

    sendJsonResponse(req, res, 200, { message: "Team deleted successfully" });
  } catch (error) {
    console.error("Delete team error:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const teams = functions.https.onRequest(app);
