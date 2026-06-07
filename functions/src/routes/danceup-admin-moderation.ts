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

const ADMIN_EMAIL = "info@danceup.app";

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

interface FlagEntry {
  reportedBy: string;
  reason: string | null;
  reportedAt: string;
}

// GET / — list all flagged reviews with studio names
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (user.email !== ADMIN_EMAIL) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const db = getFirestore();
    const snap = await db.collection("reviews")
      .where("flagCount", ">", 0)
      .orderBy("flagCount", "desc")
      .limit(100)
      .get();

    // Collect unique studio owner IDs for batch lookup
    const ownerIds = [...new Set(
      snap.docs.map(d => (d.data() as Record<string, unknown>)["studioOwnerId"] as string).filter(Boolean)
    )];

    const ownerDocs = await Promise.all(
      ownerIds.map(id => db.collection("users").doc(id).get())
    );
    const studioNames = new Map<string, string>();
    for (const doc of ownerDocs) {
      if (doc.exists) {
        const d = doc.data() as Record<string, unknown>;
        studioNames.set(doc.id, (d["studioName"] as string) || "Unknown Studio");
      }
    }

    const reviews = snap.docs.map(doc => {
      const d = doc.data() as Record<string, unknown>;
      const flags = (d["flags"] as FlagEntry[] | undefined) ?? [];
      const firstFlag = flags[0];
      const createdAt = d["createdAt"] as admin.firestore.Timestamp | undefined;

      return {
        id: doc.id,
        studioName: studioNames.get(d["studioOwnerId"] as string) ?? "Unknown Studio",
        studioOwnerId: (d["studioOwnerId"] as string) ?? "",
        author: (d["studentName"] as string) ?? "Anonymous",
        rating: (d["rating"] as number) ?? 0,
        body: (d["comment"] as string) ?? "",
        reason: firstFlag?.reason ?? null,
        flaggedBy: firstFlag?.reportedBy ?? "",
        flagCount: (d["flagCount"] as number) ?? 0,
        flaggedAt: firstFlag?.reportedAt ?? createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
        moderationStatus: (d["moderationStatus"] as string) ?? "pending",
      };
    });

    const pendingCount = reviews.filter(r => r.moderationStatus === "pending").length;

    sendJsonResponse(req, res, 200, { reviews, pendingCount });
  } catch (error) {
    console.error("danceup-admin-moderation GET / error:", error);
    handleError(req, res, error);
  }
});

// POST /:id/remove — admin removes a flagged review (soft delete)
app.post("/:id/remove", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (user.email !== ADMIN_EMAIL) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const id = req.params["id"] as string;
    const db = getFirestore();
    const ref = db.collection("reviews").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Review not found");

    await ref.update({
      isDeleted: true,
      moderationStatus: "removed",
      moderatedBy: user.email ?? ADMIN_EMAIL,
      moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { ok: true });
  } catch (error) {
    console.error("danceup-admin-moderation POST /:id/remove error:", error);
    handleError(req, res, error);
  }
});

// POST /:id/keep — admin keeps a flagged review (dismiss flag)
app.post("/:id/keep", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (user.email !== ADMIN_EMAIL) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const id = req.params["id"] as string;
    const db = getFirestore();
    const ref = db.collection("reviews").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Review not found");

    await ref.update({
      moderationStatus: "kept",
      moderatedBy: user.email ?? ADMIN_EMAIL,
      moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { ok: true });
  } catch (error) {
    console.error("danceup-admin-moderation POST /:id/keep error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminModeration = functions.https.onRequest(app);
