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
import { sendEmail } from "../services/sendgrid.service";

const ADMIN_EMAIL = "info@danceup.app";

type Audience = "all_studios" | "all_dancers" | "everyone" | "free_expiring" | "past_due" | "churned";
type Channel = "push" | "email" | "in_app";

const VALID_AUDIENCES: Audience[] = ["all_studios", "all_dancers", "everyone", "free_expiring", "past_due", "churned"];
const VALID_CHANNELS: Channel[] = ["push", "email", "in_app"];

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

// GET / — audience counts + recent campaigns
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    if (user.email !== ADMIN_EMAIL) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const db = getFirestore();
    const in7Days = new Date(Date.now() + 7 * 86400000);

    const [studiosSnap, dancersSnap, pastDueSnap, churnedSnap, campaignsSnap] = await Promise.all([
      db.collection("users").where("roles", "array-contains", "studio_owner").get(),
      db.collection("usersStudentProfiles").get(),
      db.collection("users").where("stripeSubscriptionStatus", "==", "past_due").get(),
      db.collection("users").where("subscriptionActive", "==", false).get(),
      db.collection("adminCampaigns").orderBy("sentAt", "desc").limit(20).get(),
    ]);

    // free_expiring requires composite index — fall back to 0 if unavailable
    let freeExpiringCount = 0;
    try {
      const freeSnap = await db.collection("users")
        .where("stripeSubscriptionStatus", "==", "trialing")
        .where("stripeTrialEnd", "<=", admin.firestore.Timestamp.fromDate(in7Days))
        .get();
      freeExpiringCount = freeSnap.size;
    } catch {
      const trialingSnap = await db.collection("users")
        .where("stripeSubscriptionStatus", "==", "trialing").get();
      freeExpiringCount = trialingSnap.size;
    }

    const campaigns = campaignsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        title: d["title"],
        body: d["body"],
        channel: d["channel"],
        audience: d["audience"],
        recipientCount: d["recipientCount"] ?? 0,
        successCount: d["successCount"] ?? 0,
        failureCount: d["failureCount"] ?? 0,
        sentBy: d["sentBy"],
        sentAt: (d["sentAt"] as admin.firestore.Timestamp | undefined)?.toDate?.()?.toISOString() ?? new Date().toISOString(),
      };
    });

    sendJsonResponse(req, res, 200, {
      counts: {
        studios: studiosSnap.size,
        dancers: dancersSnap.size,
        freeExpiring: freeExpiringCount,
        pastDue: pastDueSnap.size,
        churned: churnedSnap.size,
      },
      campaigns,
    });
  } catch (error) {
    console.error("danceup-admin-comms GET error:", error);
    handleError(req, res, error);
  }
});

// POST /send — send announcement to selected audience via chosen channel
app.post("/send", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    if (user.email !== ADMIN_EMAIL) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const { audience, channel, title, body } = req.body as {
      audience?: string; channel?: string; title?: string; body?: string;
    };

    if (!title || !title.trim()) return sendErrorResponse(req, res, 400, "Validation Error", "title is required");
    if (!body || !body.trim()) return sendErrorResponse(req, res, 400, "Validation Error", "body is required");
    if (!audience || !VALID_AUDIENCES.includes(audience as Audience)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid audience");
    }
    if (!channel || !VALID_CHANNELS.includes(channel as Channel)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid channel");
    }

    const db = getFirestore();
    const aud = audience as Audience;
    const ch = channel as Channel;
    const in7Days = new Date(Date.now() + 7 * 86400000);

    // Resolve recipients
    const recipientDocs: admin.firestore.QueryDocumentSnapshot[] = [];

    if (aud === "all_studios" || aud === "everyone") {
      const snap = await db.collection("users").where("roles", "array-contains", "studio_owner").get();
      recipientDocs.push(...snap.docs);
    }
    if (aud === "all_dancers" || aud === "everyone") {
      const snap = await db.collection("usersStudentProfiles").get();
      recipientDocs.push(...snap.docs);
    }
    if (aud === "free_expiring") {
      try {
        const snap = await db.collection("users")
          .where("stripeSubscriptionStatus", "==", "trialing")
          .where("stripeTrialEnd", "<=", admin.firestore.Timestamp.fromDate(in7Days))
          .get();
        recipientDocs.push(...snap.docs);
      } catch {
        const snap = await db.collection("users")
          .where("stripeSubscriptionStatus", "==", "trialing").get();
        recipientDocs.push(...snap.docs);
      }
    }
    if (aud === "past_due") {
      const snap = await db.collection("users").where("stripeSubscriptionStatus", "==", "past_due").get();
      recipientDocs.push(...snap.docs);
    }
    if (aud === "churned") {
      const snap = await db.collection("users").where("subscriptionActive", "==", false).get();
      recipientDocs.push(...snap.docs);
    }

    const recipientCount = recipientDocs.length;
    let successCount = 0;
    let failureCount = 0;
    const titleTrimmed = title.trim();
    const bodyTrimmed = body.trim();

    if (ch === "push") {
      const tokens = recipientDocs
        .map((doc) => doc.data()["fcmToken"] as string | undefined)
        .filter((t): t is string => typeof t === "string" && t.length > 0);

      if (tokens.length === 0) {
        failureCount = recipientCount;
      } else {
        const CHUNK = 500;
        for (let i = 0; i < tokens.length; i += CHUNK) {
          const chunk = tokens.slice(i, i + CHUNK);
          try {
            const result = await admin.messaging().sendEachForMulticast({
              tokens: chunk,
              notification: { title: titleTrimmed, body: bodyTrimmed },
              data: { source: "admin_broadcast" },
            });
            successCount += result.successCount;
            failureCount += result.failureCount;
          } catch (e) {
            failureCount += chunk.length;
            console.error("[comms] FCM multicast chunk error:", e);
          }
        }
      }
    } else if (ch === "email") {
      const results = await Promise.allSettled(
        recipientDocs.map(async (doc) => {
          const email = doc.data()["email"] as string | undefined;
          if (!email) throw new Error("no email");
          await sendEmail({
            to: email,
            from: { email: "info@danceup.app", name: "DanceUp" },
            subject: titleTrimmed,
            text: bodyTrimmed,
            html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#f8fafc"><div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e8f0"><h2 style="color:#1e293b;margin:0 0 16px">${titleTrimmed}</h2><p style="color:#475569;line-height:1.6;white-space:pre-wrap">${bodyTrimmed}</p><hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/><p style="color:#94a3b8;font-size:12px;margin:0">You're receiving this as a DanceUp platform announcement.</p></div></div>`,
            categories: ["admin-broadcast"],
          });
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled") successCount++;
        else failureCount++;
      }
    } else if (ch === "in_app") {
      const BATCH_SIZE = 499;
      for (let i = 0; i < recipientDocs.length; i += BATCH_SIZE) {
        const chunk = recipientDocs.slice(i, i + BATCH_SIZE);
        const batch = db.batch();
        for (const doc of chunk) {
          const ref = db.collection("notifications").doc();
          batch.set(ref, {
            userId: doc.id,
            title: titleTrimmed,
            message: bodyTrimmed,
            type: "admin_broadcast",
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        try {
          await batch.commit();
          successCount += chunk.length;
        } catch (e) {
          failureCount += chunk.length;
          console.error("[comms] in-app batch error:", e);
        }
      }
    }

    const campaignRef = await db.collection("adminCampaigns").add({
      title: titleTrimmed,
      body: bodyTrimmed,
      channel: ch,
      audience: aud,
      recipientCount,
      successCount,
      failureCount,
      sentBy: user.email ?? "unknown",
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {
      campaignId: campaignRef.id,
      recipientCount,
      successCount,
      failureCount,
    });
  } catch (error) {
    console.error("danceup-admin-comms POST /send error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminComms = functions.https.onRequest(app);
