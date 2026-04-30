import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import attendanceService from "../services/attendance.service";
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

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

// Excludes ambiguous chars (0,O,1,I) for readability on tablet keyboards
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// POST / — Web app creates a new watch-mode session, returns {sessionId, code}
app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (e) { return handleError(req, res, e); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    const db = getFirestore();

    // Ensure code uniqueness among active sessions
    let code = generateCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await db.collection("kioskSessions")
        .where("code", "==", code)
        .where("active", "==", true)
        .limit(1)
        .get();
      if (clash.empty) break;
      code = generateCode();
    }

    const sessionRef = db.collection("kioskSessions").doc();
    await sessionRef.set({
      code,
      studioOwnerId,
      authUid: user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      active: true,
      tablets: {},
      lastCheckIn: null,
      checkIns: [],
    });

    sendJsonResponse(req, res, 201, { sessionId: sessionRef.id, code });
  } catch (error) {
    handleError(req, res, error);
  }
});

// GET /:sessionId — Web app polls for current session state
app.get("/:sessionId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (e) { return handleError(req, res, e); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    const db = getFirestore();
    const sessionRef = db.collection("kioskSessions").doc(req.params["sessionId"] as string);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Session not found");
    }

    const data = sessionDoc.data() as Record<string, unknown>;
    if (data["studioOwnerId"] !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Not authorized to view this session");
    }

    sendJsonResponse(req, res, 200, {
      sessionId: sessionDoc.id,
      code: data["code"],
      active: data["active"],
      tablets: data["tablets"] ?? {},
      lastCheckIn: data["lastCheckIn"] ?? null,
      checkIns: data["checkIns"] ?? [],
    });
  } catch (error) {
    handleError(req, res, error);
  }
});

// POST /pair — Tablet submits a code to join a session, returns {sessionId}
app.post("/pair", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (e) { return handleError(req, res, e); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    const body = req.body as Record<string, unknown>;
    const code = typeof body["code"] === "string" ? body["code"].toUpperCase().trim() : null;
    const tabletId = typeof body["tabletId"] === "string" ? body["tabletId"] : user.uid;

    if (!code) {
      return sendErrorResponse(req, res, 400, "Validation Error", "code is required");
    }

    const db = getFirestore();
    const snap = await db.collection("kioskSessions")
      .where("code", "==", code)
      .where("studioOwnerId", "==", studioOwnerId)
      .where("active", "==", true)
      .limit(1)
      .get();

    if (snap.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "No active session found with that code. Check the code on the web app and try again.");
    }

    const sessionDoc = snap.docs[0]!;
    await sessionDoc.ref.update({
      [`tablets.${tabletId}`]: { pairedAt: admin.firestore.FieldValue.serverTimestamp() },
    });

    sendJsonResponse(req, res, 200, { sessionId: sessionDoc.id });
  } catch (error) {
    handleError(req, res, error);
  }
});

// DELETE /:sessionId — Web app ends watch mode
app.delete("/:sessionId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (e) { return handleError(req, res, e); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    const db = getFirestore();
    const sessionRef = db.collection("kioskSessions").doc(req.params["sessionId"] as string);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Session not found");
    }

    const data = sessionDoc.data() as Record<string, unknown>;
    if (data["studioOwnerId"] !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Not authorized to end this session");
    }

    await sessionRef.update({ active: false });
    sendJsonResponse(req, res, 200, { message: "Session ended" });
  } catch (error) {
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const kioskSessions = functions.https.onRequest(app);
