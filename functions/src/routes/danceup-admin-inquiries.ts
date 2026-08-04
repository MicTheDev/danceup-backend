import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response } from "express";
import cors from "cors";
import { verifyToken } from "../utils/auth";
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

// GET / — list inquiries, newest first
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const db = getFirestore();
    const snap = await db.collection("Inquiry").orderBy("createdAt", "desc").limit(100).get();

    const inquiries = snap.docs.map(doc => {
      const d = doc.data() as Record<string, unknown>;
      const createdAt = d["createdAt"] as admin.firestore.Timestamp | undefined;
      const resolvedAt = d["resolvedAt"] as admin.firestore.Timestamp | undefined;
      return {
        id: doc.id,
        name: (d["name"] as string) ?? "",
        email: (d["email"] as string) ?? "",
        subject: (d["subject"] as string) ?? "",
        message: (d["message"] as string) ?? "",
        status: (d["status"] as string) ?? "new",
        source: (d["source"] as string) ?? "unknown",
        createdAt: createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
        resolvedBy: (d["resolvedBy"] as string) ?? null,
        resolvedAt: resolvedAt?.toDate?.()?.toISOString() ?? null,
      };
    });

    const newCount = inquiries.filter(i => i.status === "new").length;
    sendJsonResponse(req, res, 200, { inquiries, newCount });
  } catch (error) {
    console.error("danceup-admin-inquiries GET / error:", error);
    handleError(req, res, error);
  }
});

// POST /:id/resolve — admin marks an inquiry resolved
app.post("/:id/resolve", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const id = req.params["id"] as string;
    const db = getFirestore();
    const ref = db.collection("Inquiry").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Inquiry not found");

    await ref.update({
      status: "resolved",
      resolvedBy: user.email ?? "",
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { ok: true });
  } catch (error) {
    console.error("danceup-admin-inquiries POST /:id/resolve error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminInquiries = functions.https.onRequest(app);
