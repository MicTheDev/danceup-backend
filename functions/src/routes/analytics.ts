import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
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

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.sendStatus(204);
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

function getFingerprint(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (forwarded ? (forwarded as string).split(",")[0]?.trim() : null) ??
    req.ip ??
    (req.socket?.remoteAddress) ??
    "unknown";
  const ua = req.headers["user-agent"] ?? "unknown";
  return crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex");
}

app.post("/view", async (req, res) => {
  try {
    const { contentType, contentId, contentName, studioOwnerId } = req.body as {
      contentType?: string;
      contentId?: string;
      contentName?: string;
      studioOwnerId?: string;
    };

    if (!contentType || !contentId || !studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "contentType, contentId, and studioOwnerId are required");
    }
    if (!["class", "workshop", "event"].includes(contentType)) {
      return sendErrorResponse(req, res, 400, "Bad Request", "contentType must be class, workshop, or event");
    }

    const db = getFirestore();
    const fingerprint = getFingerprint(req);
    const docId = `${contentType}_${contentId}`;
    const viewsRef = db.collection("contentViews").doc(docId);
    const visitorRef = viewsRef.collection("visitors").doc(fingerprint);

    await db.runTransaction(async (tx) => {
      const viewsDoc = await tx.get(viewsRef);
      const visitorDoc = await tx.get(visitorRef);

      const now = admin.firestore.FieldValue.serverTimestamp();
      const isNewVisitor = !visitorDoc.exists;

      if (viewsDoc.exists) {
        tx.update(viewsRef, {
          totalViews: admin.firestore.FieldValue.increment(1),
          ...(isNewVisitor && { uniqueViews: admin.firestore.FieldValue.increment(1) }),
          contentName: contentName || (viewsDoc.data() as Record<string, unknown>)["contentName"],
          updatedAt: now,
        });
      } else {
        tx.set(viewsRef, {
          studioOwnerId,
          contentType,
          contentId,
          contentName: contentName || "",
          totalViews: 1,
          uniqueViews: 1,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (visitorDoc.exists) {
        tx.update(visitorRef, {
          lastSeenAt: now,
          viewCount: admin.firestore.FieldValue.increment(1),
        });
      } else {
        tx.set(visitorRef, { firstSeenAt: now, lastSeenAt: now, viewCount: 1 });
      }
    });

    sendJsonResponse(req, res, 200, { recorded: true });
  } catch (error) {
    console.error("Error recording view:", error);
    handleError(req, res, error);
  }
});

app.get("/content-views", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users").where("authUid", "==", user.uid).limit(1).get();
    if (userQuery.empty) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }
    const studioOwnerId = userQuery.docs[0]?.id;
    if (!studioOwnerId) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");

    const snapshot = await db.collection("contentViews").where("studioOwnerId", "==", studioOwnerId).get();
    const views = snapshot.docs.map((doc) => {
      const d = doc.data() as Record<string, unknown>;
      return {
        contentType: d["contentType"],
        contentId: d["contentId"],
        contentName: d["contentName"],
        totalViews: (d["totalViews"] as number) || 0,
        uniqueViews: (d["uniqueViews"] as number) || 0,
      };
    });

    sendJsonResponse(req, res, 200, { views });
  } catch (error) {
    console.error("Error fetching content views:", error);
    handleError(req, res, error);
  }
});

app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, _err));

export const analytics = functions.https.onRequest(app);
