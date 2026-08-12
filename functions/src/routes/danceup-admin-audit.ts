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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

async function resolveActorEmails(uids: string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  const unique = [...new Set(uids)].filter(Boolean);
  if (unique.length === 0) return emails;
  try {
    const result = await admin.auth().getUsers(unique.map((uid) => ({ uid })));
    for (const record of result.users) {
      emails.set(record.uid, record.email ?? record.uid);
    }
  } catch (error) {
    console.warn("danceup-admin-audit actor email lookup failed:", (error as Error).message);
  }
  return emails;
}

export interface AuditLogPage {
  items: Array<{
    id: string;
    actorUid: string;
    actorEmail: string | null;
    studioOwnerId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
    timestamp: string;
  }>;
  hasMore: boolean;
}

// `before` + orderBy both target the `timestamp` field, which Firestore can
// serve off the automatic single-field index — no composite index needed.
export async function getAuditLogPage(limit: number, before?: string): Promise<AuditLogPage> {
  const db = getFirestore();
  let query: FirebaseFirestore.Query = db.collection("auditLogs").orderBy("timestamp", "desc");
  if (before && !isNaN(Date.parse(before))) {
    query = query.where("timestamp", "<", admin.firestore.Timestamp.fromDate(new Date(before)));
  }
  const snap = await query.limit(limit + 1).get();

  const hasMore = snap.docs.length > limit;
  const docs = snap.docs.slice(0, limit);
  const emails = await resolveActorEmails(docs.map((doc) => (doc.data() as Record<string, unknown>)["actorUid"] as string));

  const items = docs.map((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const ts = d["timestamp"] as admin.firestore.Timestamp | undefined;
    return {
      id: doc.id,
      actorUid: (d["actorUid"] as string) ?? "",
      actorEmail: emails.get(d["actorUid"] as string) ?? null,
      studioOwnerId: (d["studioOwnerId"] as string) || null,
      action: (d["action"] as string) ?? "",
      resourceType: (d["resourceType"] as string) ?? "",
      resourceId: (d["resourceId"] as string) ?? "",
      metadata: (d["metadata"] as Record<string, unknown>) ?? {},
      timestamp: ts?.toDate?.()?.toISOString() ?? new Date().toISOString(),
    };
  });

  return { items, hasMore };
}

// GET /?limit=50&before=<ISO timestamp> — paginated audit log, newest first.
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const limitParam = parseInt((req.query["limit"] as string) ?? "50", 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
    const beforeParam = req.query["before"] as string | undefined;

    const page = await getAuditLogPage(limit, beforeParam);
    sendJsonResponse(req, res, 200, page);
  } catch (error) {
    console.error("danceup-admin-audit error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminAudit = functions.https.onRequest(app);
