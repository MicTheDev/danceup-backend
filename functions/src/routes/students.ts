import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import studentsService from "../services/students.service";
import creditTrackingService from "../services/credit-tracking.service";
import { getFirestore } from "../utils/firestore";
import { verifyToken } from "../utils/auth";
import { validateCreateStudentPayload, validateUpdateStudentPayload } from "../utils/validation";
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

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const limitStr = req.query["limit"] as string | undefined;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const after = (req.query["after"] as string) || null;
    const result = await studentsService.getStudents(studioOwnerId, { limit, after });

    sendJsonResponse(req, res, 200, {
      data: result.students,
      pagination: {
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        limit: result.students.length,
      },
    });
  } catch (error) {
    console.error("Error getting students:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const validation = validateCreateStudentPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid student data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const studentId = await studentsService.createStudent(req.body, studioOwnerId);
    sendJsonResponse(req, res, 201, { id: studentId, message: "Student created successfully" });
  } catch (error) {
    console.error("Error creating student:", error);
    handleError(req, res, error);
  }
});

app.get("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const studentData = await studentsService.getStudentById(req.params["id"] as string, studioOwnerId);
    if (!studentData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    sendJsonResponse(req, res, 200, studentData);
  } catch (error) {
    console.error("Error getting student:", error);
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

    const validation = validateUpdateStudentPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid student data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await studentsService.updateStudent(req.params["id"] as string, req.body, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Student updated successfully" });
  } catch (error) {
    console.error("Error updating student:", error);
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

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await studentsService.deleteStudent(req.params["id"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Student deleted successfully" });
  } catch (error) {
    console.error("Error deleting student:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.get("/:id/referrals", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Verify the referrer student belongs to this studio
    const referrer = await studentsService.getStudentById(req.params["id"] as string, studioOwnerId);
    if (!referrer) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    const db = getFirestore();
    const [referredSnap, attendanceSnap] = await Promise.all([
      db.collection("students")
        .where("studioOwnerId", "==", studioOwnerId)
        .where("referredBy", "==", req.params["id"] as string)
        .get(),
      db.collection("attendance")
        .where("studioOwnerId", "==", studioOwnerId)
        .where("isRemoved", "==", false)
        .get(),
    ]);

    // Build set of students who have attended at least once
    const attendedStudents = new Set<string>();
    attendanceSnap.forEach((doc) => {
      const sid = (doc.data() as Record<string, unknown>)["studentId"] as string | undefined;
      if (sid) attendedStudents.add(sid);
    });

    const referrals = referredSnap.docs.map((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const ts = d["createdAt"] as { toDate?: () => Date } | null;
      return {
        id: doc.id,
        firstName: d["firstName"] as string || "",
        lastName: d["lastName"] as string || "",
        email: d["email"] as string || null,
        status: attendedStudents.has(doc.id) ? "converted" : "pending",
        joinedAt: ts?.toDate ? ts.toDate().toISOString() : null,
      };
    });

    sendJsonResponse(req, res, 200, { referrals, total: referrals.length });
  } catch (error) {
    handleError(req, res, error);
  }
});

app.post("/:id/adjust-credits", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;
    const { amount, reason } = req.body as { amount?: unknown; reason?: unknown };

    if (typeof amount !== "number" || !Number.isInteger(amount) || amount === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "amount must be a non-zero integer");
    }
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "reason is required");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const studentData = await studentsService.getStudentById(id, studioOwnerId);
    if (!studentData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    if (amount > 0) {
      await creditTrackingService.addCredits(id, studioOwnerId, amount, 365, null, null);
    } else {
      await creditTrackingService.removeCredits(id, studioOwnerId, Math.abs(amount));
    }

    const newBalance = await creditTrackingService.getAvailableCredits(id, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: `Credits adjusted by ${amount > 0 ? "+" : ""}${amount}`,
      newBalance,
    });
  } catch (error) {
    console.error("Error adjusting credits:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found") || msg?.includes("Access denied")) {
      return sendErrorResponse(req, res, 404, "Not Found", msg);
    }
    if (msg?.includes("Not enough credits")) {
      return sendErrorResponse(req, res, 400, "Insufficient Credits", msg);
    }
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const students = functions.https.onRequest(app);
