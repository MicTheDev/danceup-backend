import * as functions from "firebase-functions";
import express, { Request, Response } from "express";
import cors from "cors";
import studentsService from "../services/students.service";
import { sendStudentImportInviteEmail } from "../services/sendgrid.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { validateBulkImportStudentsPayload, validateRequiredString } from "../utils/validation";
import { logAuditEvent } from "../services/audit.service";
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
app.use(express.json({ limit: "10mb" }));
applySecurityMiddleware(app);

// POST /bulk-import — same import behind studentsService.bulkImportStudents that
// self-serve studios use (routes/students.ts), just with an explicit studioOwnerId
// in the body instead of deriving it from the caller.
app.post("/bulk-import", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateBulkImportStudentsPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid import data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = req.body["studioOwnerId"] as string | undefined;
    const studioV = validateRequiredString(studioOwnerId, "Studio");
    if (!studioV.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", studioV.message ?? "Studio is required");
    }

    const studioDoc = await getFirestore().collection("users").doc(studioOwnerId as string).get();
    if (!studioDoc.exists) return sendErrorResponse(req, res, 400, "Validation Error", "Studio not found");

    const rows = (req.body as { rows: Array<Record<string, unknown>> }).rows;
    const result = await studentsService.bulkImportStudents(rows, studioOwnerId as string);

    if (result.newPlaceholders.length > 0) {
      const studioData = studioDoc.data() as Record<string, unknown>;
      const studioName = (studioData["studioName"] as string) || "your studio";
      await Promise.allSettled(
        result.newPlaceholders.map((p) => sendStudentImportInviteEmail(p.email, p.firstName, studioName)),
      );
    }

    await logAuditEvent(user.uid, studioOwnerId as string, "student_admin_bulk_imported", "student", "bulk", {
      created: result.created,
      updated: result.updated,
      linked: result.linked,
      errorCount: result.errors.length,
    });

    sendJsonResponse(req, res, 200, {
      created: result.created,
      updated: result.updated,
      linked: result.linked,
      errors: result.errors,
    });
  } catch (error) {
    console.error("danceup-admin-students bulk-import error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminStudents = functions.https.onRequest(app);
