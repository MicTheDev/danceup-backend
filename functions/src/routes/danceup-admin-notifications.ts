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

interface NotificationItem {
  id: string;
  title: string;
  subtitle?: string;
  timestamp: string;
}

interface GCPLogEntry {
  insertId?: string;
  timestamp: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  resource?: { labels?: Record<string, string> };
}

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

function tsToIso(ts: unknown): string {
  if (ts && typeof ts === "object" && "toDate" in ts) {
    return (ts as admin.firestore.Timestamp).toDate().toISOString();
  }
  return new Date().toISOString();
}

// Mirrors the exact query danceup-admin-inquiries.ts's GET / already runs in
// production (single orderBy, no composite filter) — reused here so this
// never risks needing a Firestore index that doesn't already exist.
export async function getInquiriesSlice(): Promise<{ count: number; items: NotificationItem[] }> {
  const db = getFirestore();
  const snap = await db.collection("Inquiry").orderBy("createdAt", "desc").limit(100).get();
  const newOnes = snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as Record<string, unknown> }))
    .filter((d) => (d.data["status"] ?? "new") === "new");

  return {
    count: newOnes.length,
    items: newOnes.slice(0, 5).map((d) => ({
      id: d.id,
      title: (d.data["subject"] as string) || (d.data["name"] as string) || "New inquiry",
      subtitle: (d.data["name"] as string) || undefined,
      timestamp: tsToIso(d.data["createdAt"]),
    })),
  };
}

// Mirrors the exact query danceup-admin-moderation.ts's GET / already runs in
// production (flagCount > 0, orderBy flagCount) for the same index-safety reason.
export async function getModerationSlice(): Promise<{ count: number; items: NotificationItem[] }> {
  const db = getFirestore();
  const snap = await db.collection("reviews")
    .where("flagCount", ">", 0)
    .orderBy("flagCount", "desc")
    .limit(100)
    .get();

  const pending = snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as Record<string, unknown> }))
    .filter((r) => (r.data["moderationStatus"] ?? "pending") === "pending");

  const sortedByRecency = [...pending].sort((a, b) => {
    const at = a.data["createdAt"] as admin.firestore.Timestamp | undefined;
    const bt = b.data["createdAt"] as admin.firestore.Timestamp | undefined;
    return (bt?.toMillis?.() ?? 0) - (at?.toMillis?.() ?? 0);
  });

  return {
    count: pending.length,
    items: sortedByRecency.slice(0, 5).map((r) => ({
      id: r.id,
      title: `Flagged review (${(r.data["flagCount"] as number) ?? 1}x)`,
      subtitle: (r.data["studentName"] as string) || "Anonymous",
      timestamp: tsToIso(r.data["createdAt"]),
    })),
  };
}

async function getGCPToken(): Promise<string> {
  const resp = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  const data = await resp.json() as { access_token: string };
  return data.access_token;
}

function getProjectId(): string {
  return process.env["GCLOUD_PROJECT"] ?? process.env["GCP_PROJECT"] ?? admin.app().options.projectId ?? "";
}

// Deliberately lighter than danceup-admin-health.ts's GET / — that endpoint
// pings Firestore/Auth/Stripe, lists Cloud Functions, and pulls Cloud
// Monitoring quota metrics, which is too slow/expensive to run on every
// notification poll. This only checks for recent ERROR-severity log entries.
export async function getHealthSlice(since: Date): Promise<{ count: number; items: NotificationItem[] }> {
  try {
    const projectId = getProjectId();
    const token = await getGCPToken();
    const body = {
      resourceNames: [`projects/${projectId}`],
      filter: `(resource.type="cloud_run_revision" OR resource.type="cloud_function") severity="ERROR" timestamp>="${since.toISOString()}"`,
      pageSize: 10,
      orderBy: "timestamp desc",
    };
    const resp = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { count: 0, items: [] };
    const data = await resp.json() as { entries?: GCPLogEntry[] };
    const entries = data.entries ?? [];

    return {
      count: entries.length,
      items: entries.slice(0, 5).map((entry, i) => {
        const msg = typeof entry.jsonPayload?.["message"] === "string"
          ? entry.jsonPayload["message"] as string
          : typeof entry.textPayload === "string"
          ? entry.textPayload
          : "Error logged";
        const fn = entry.resource?.labels?.["function_name"] ?? entry.resource?.labels?.["service_name"] ?? "unknown";
        return {
          id: entry.insertId ?? String(i),
          title: msg.slice(0, 140),
          subtitle: fn,
          timestamp: entry.timestamp,
        };
      }),
    };
  } catch (error) {
    console.warn("danceup-admin-notifications health slice failed:", (error as Error).message);
    return { count: 0, items: [] };
  }
}

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
    console.warn("danceup-admin-notifications actor email lookup failed:", (error as Error).message);
  }
  return emails;
}

// Mirrors danceup-admin-audit.ts's GET / query shape (single orderBy, no
// composite filter) for the same index-safety reason as the slices above.
export async function getAuditSlice(since: Date): Promise<{ count: number; items: NotificationItem[] }> {
  const db = getFirestore();
  const snap = await db.collection("auditLogs").orderBy("timestamp", "desc").limit(50).get();

  const docs = snap.docs.map((doc) => ({ id: doc.id, data: doc.data() as Record<string, unknown> }));
  const sinceMs = since.getTime();
  const recent = docs.filter((d) => {
    const ts = d.data["timestamp"] as admin.firestore.Timestamp | undefined;
    return (ts?.toMillis?.() ?? 0) > sinceMs;
  });

  const preview = docs.slice(0, 5);
  const emails = await resolveActorEmails(preview.map((d) => d.data["actorUid"] as string));

  return {
    count: recent.length,
    items: preview.map((d) => ({
      id: d.id,
      title: formatAuditAction(d.data["action"] as string),
      subtitle: emails.get(d.data["actorUid"] as string) ?? (d.data["actorUid"] as string) ?? undefined,
      timestamp: tsToIso(d.data["timestamp"]),
    })),
  };
}

function formatAuditAction(action: string): string {
  return (action ?? "").replace(/_/g, " ");
}

// GET / — cross-cutting summary for the notification bell. Accepts an
// optional ?since= ISO timestamp used to gate the health/audit "new" counts
// (inquiries/moderation stay status-driven — they represent a real backlog,
// not something that should disappear just because the bell was opened).
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const sinceParam = req.query["since"] as string | undefined;
    const since = sinceParam && !isNaN(Date.parse(sinceParam))
      ? new Date(sinceParam)
      : new Date(Date.now() - 24 * 3600 * 1000);

    const [inquiries, moderation, health, audit] = await Promise.all([
      getInquiriesSlice(),
      getModerationSlice(),
      getHealthSlice(since),
      getAuditSlice(since),
    ]);

    sendJsonResponse(req, res, 200, { inquiries, moderation, health, audit });
  } catch (error) {
    console.error("danceup-admin-notifications error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminNotifications = functions.https.onRequest(app);
