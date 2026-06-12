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

function deriveStatus(data: Record<string, unknown>): string {
  const ss = data["stripeSubscriptionStatus"] as string | undefined;
  if (ss === "active") return "active";
  if (ss === "trialing") return "trial";
  if (ss === "past_due") return "past_due";
  if (ss === "canceled" || ss === "unpaid" || ss === "incomplete_expired") return "churned";
  return "pending";
}

function derivePlan(membership: string | null | undefined): string {
  if (membership === "ultimate") return "studio";
  if (membership === "studio_owner") return "pro";
  if (membership === "individual_instructor" || membership === "event_organizer") return "starter";
  return "free";
}

function toIso(ts: unknown): string | null {
  if (!ts) return null;
  if (typeof ts === "object" && ts !== null && "toDate" in ts) {
    return (ts as admin.firestore.Timestamp).toDate().toISOString();
  }
  return null;
}

async function batchGetAuthUsers(uids: string[]): Promise<Map<string, string | null>> {
  const lastSignInMap = new Map<string, string | null>();
  const BATCH = 100;
  for (let i = 0; i < uids.length; i += BATCH) {
    const identifiers = uids.slice(i, i + BATCH).map((uid) => ({ uid }));
    const result = await admin.auth().getUsers(identifiers);
    for (const record of result.users) {
      const t = record.metadata.lastSignInTime;
      lastSignInMap.set(record.uid, t ? new Date(t).toISOString() : null);
    }
  }
  return lastSignInMap;
}

// GET /  — list all studio owners
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const db = getFirestore();
    const snapshot = await db
      .collection("users")
      .where("roles", "array-contains", "studio_owner")
      .get();

    const uids = snapshot.docs.map((doc) => doc.id);
    let lastSignInMap = new Map<string, string | null>();
    try {
      lastSignInMap = await batchGetAuthUsers(uids);
    } catch (authErr) {
      console.warn("danceup-admin-studios: auth lookup failed, lastActiveAt will be null", authErr);
    }

    const studios = snapshot.docs.map((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const membership = (d["membership"] as string | null) ?? null;

      return {
        id: doc.id,
        studioName: (d["studioName"] as string) || "Unnamed Studio",
        firstName: (d["firstName"] as string) || "",
        lastName: (d["lastName"] as string) || "",
        email: (d["email"] as string) || "",
        city: (d["city"] as string) || "",
        state: (d["state"] as string) || "",
        zip: (d["zip"] as string) || "",
        studioAddressLine1: (d["studioAddressLine1"] as string) || "",
        studioImageUrl: (d["studioImageUrl"] as string | null) ?? null,
        membership,
        roles: (d["roles"] as string[]) || [],
        stripeCustomerId: (d["stripeCustomerId"] as string | null) ?? null,
        stripeSubscriptionId: (d["stripeSubscriptionId"] as string | null) ?? null,
        stripeSubscriptionStatus: (d["stripeSubscriptionStatus"] as string | null) ?? null,
        subscriptionActive: (d["subscriptionActive"] as boolean | null) ?? null,
        instagram: (d["instagram"] as string | null) ?? null,
        facebook: (d["facebook"] as string | null) ?? null,
        phone: (d["phone"] as string | null) ?? null,
        createdAt: toIso(d["createdAt"]),
        updatedAt: toIso(d["updatedAt"]),
        lastActiveAt: lastSignInMap.get(doc.id) ?? null,
        // Derived fields
        status: deriveStatus(d),
        plan: derivePlan(membership),
      };
    });

    sendJsonResponse(req, res, 200, studios);
  } catch (error) {
    console.error("danceup-admin-studios error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminStudios = functions.https.onRequest(app);
