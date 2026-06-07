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

function toIso(ts: unknown): string | null {
  if (!ts) return null;
  if (typeof ts === "object" && ts !== null && "toDate" in ts) {
    return (ts as admin.firestore.Timestamp).toDate().toISOString();
  }
  return null;
}

function deriveStatus(d: Record<string, unknown>, disabled: boolean): string {
  if (disabled) return "suspended";
  const ds = d["deletionStatus"] as string | undefined;
  if (ds === "pending") return "deletion_req";
  return "active";
}

async function batchGetAuthMeta(
  uids: string[],
): Promise<Map<string, { lastSignInTime: string | null; disabled: boolean }>> {
  const map = new Map<string, { lastSignInTime: string | null; disabled: boolean }>();
  const BATCH = 100;
  for (let i = 0; i < uids.length; i += BATCH) {
    const identifiers = uids.slice(i, i + BATCH).map((uid) => ({ uid }));
    const result = await admin.auth().getUsers(identifiers);
    for (const record of result.users) {
      const t = record.metadata.lastSignInTime;
      map.set(record.uid, {
        lastSignInTime: t ? new Date(t).toISOString() : null,
        disabled: record.disabled,
      });
    }
  }
  return map;
}

// GET / — list all dancer accounts
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    if (user.email !== ADMIN_EMAIL) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const db = getFirestore();
    const now = admin.firestore.Timestamp.now();

    // Run all reads in parallel
    const [profilesSnap, purchasesSnap, cashPurchasesSnap, studentsSnap, creditsSnap] = await Promise.all([
      db.collection("usersStudentProfiles").get(),
      db.collection("purchases").where("status", "==", "completed").get(),
      db.collection("cashPurchases").where("status", "==", "completed").get(),
      db.collection("students").get(),
      db.collectionGroup("credits").get(),
    ]);

    // Build studentId → authUid map from students collection
    const authUidByStudentId = new Map<string, string>();
    for (const doc of studentsSnap.docs) {
      const uid = (doc.data() as Record<string, unknown>)["authUid"] as string | undefined;
      if (uid) authUidByStudentId.set(doc.id, uid);
    }

    // Build authUid → lifetimeSpend map from stripe purchases (price field is a string)
    const spendByAuthUid = new Map<string, number>();
    for (const doc of purchasesSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const uid = d["authUid"] as string | undefined;
      const amount = parseFloat(String(d["price"] ?? "0")) || 0;
      if (uid) spendByAuthUid.set(uid, (spendByAuthUid.get(uid) || 0) + amount);
    }

    // Include cash purchases (use studentId → authUid mapping, amount is a number)
    for (const doc of cashPurchasesSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const studentId = d["studentId"] as string | undefined;
      const uid = studentId ? authUidByStudentId.get(studentId) : undefined;
      const amount = (d["amount"] as number) || 0;
      if (uid) spendByAuthUid.set(uid, (spendByAuthUid.get(uid) || 0) + amount);
    }

    // Aggregate non-expired credits by authUid via collection-group
    const creditsByAuthUid = new Map<string, number>();
    for (const doc of creditsSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const expDate = d["expirationDate"] as admin.firestore.Timestamp | undefined;
      if (expDate && expDate.toMillis() < now.toMillis()) continue;
      const credits = (d["credits"] as number) || 0;
      // Path: students/{studentId}/credits/{creditId}
      const studentId = doc.ref.parent.parent?.id;
      if (!studentId) continue;
      const uid = authUidByStudentId.get(studentId);
      if (!uid) continue;
      creditsByAuthUid.set(uid, (creditsByAuthUid.get(uid) || 0) + credits);
    }

    // Batch-fetch Firebase Auth metadata
    const authUids = profilesSnap.docs
      .map((doc) => (doc.data() as Record<string, unknown>)["authUid"] as string | undefined)
      .filter((uid): uid is string => !!uid);

    let authMap = new Map<string, { lastSignInTime: string | null; disabled: boolean }>();
    try {
      authMap = await batchGetAuthMeta(authUids);
    } catch (authErr) {
      console.warn("danceup-admin-dancers: auth lookup failed, metadata will be null", authErr);
    }

    const dancers = profilesSnap.docs.map((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const authUid = (d["authUid"] as string) ?? "";
      const authData = authMap.get(authUid);
      const studios = (d["studios"] as Record<string, unknown>) ?? {};

      return {
        id: doc.id,
        authUid,
        firstName: (d["firstName"] as string) || "",
        lastName: (d["lastName"] as string) || "",
        email: (d["email"] as string) || "",
        city: (d["city"] as string) || "",
        state: (d["state"] as string) || "",
        phone: (d["phone"] as string | null) ?? null,
        danceGenres: (d["danceGenres"] as string[]) || [],
        photoURL: (d["photoURL"] as string | null) ?? null,
        studioCount: Object.keys(studios).length,
        totalCredits: creditsByAuthUid.get(authUid) ?? 0,
        lifetimeSpend: spendByAuthUid.get(authUid) ?? 0,
        createdAt: toIso(d["createdAt"]),
        lastActiveAt: authData?.lastSignInTime ?? null,
        status: deriveStatus(d, authData?.disabled ?? false),
      };
    });

    sendJsonResponse(req, res, 200, dancers);
  } catch (error) {
    console.error("danceup-admin-dancers error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminDancers = functions.https.onRequest(app);
