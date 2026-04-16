const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const {verifyToken} = require("./utils/auth");
const {getFirestore} = require("./utils/firestore");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} = require("./utils/http");

if (!admin.apps.length) {
  admin.initializeApp();
}

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

/**
 * Build a privacy-safe fingerprint from IP + User-Agent.
 * SHA256 so the raw IP is never stored.
 */
function getFingerprint(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (forwarded ? forwarded.split(",")[0].trim() : null) ||
    req.ip ||
    req.connection?.remoteAddress ||
    "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  return crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex");
}

/**
 * POST /view
 * Record a content view. No auth required — called from the public users app.
 * Body: { contentType: 'class'|'workshop'|'event', contentId, contentName, studioOwnerId }
 */
app.post("/view", async (req, res) => {
  try {
    const {contentType, contentId, contentName, studioOwnerId} = req.body;

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

      // Update or create the top-level stats doc
      if (viewsDoc.exists) {
        tx.update(viewsRef, {
          totalViews: admin.firestore.FieldValue.increment(1),
          ...(isNewVisitor && {uniqueViews: admin.firestore.FieldValue.increment(1)}),
          contentName: contentName || viewsDoc.data().contentName,
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

      // Update or create the visitor record
      if (visitorDoc.exists) {
        tx.update(visitorRef, {
          lastSeenAt: now,
          viewCount: admin.firestore.FieldValue.increment(1),
        });
      } else {
        tx.set(visitorRef, {
          firstSeenAt: now,
          lastSeenAt: now,
          viewCount: 1,
        });
      }
    });

    sendJsonResponse(req, res, 200, {recorded: true});
  } catch (error) {
    console.error("Error recording view:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /content-views
 * Return view stats for all content owned by the authenticated studio owner.
 * Returns: { views: Array<{ contentType, contentId, contentName, totalViews, uniqueViews }> }
 */
app.get("/content-views", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const db = getFirestore();

    // Resolve studioOwnerId
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();
    if (userQuery.empty) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }
    const studioOwnerId = userQuery.docs[0].id;

    const snapshot = await db.collection("contentViews")
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const views = snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        contentType: d.contentType,
        contentId: d.contentId,
        contentName: d.contentName,
        totalViews: d.totalViews || 0,
        uniqueViews: d.uniqueViews || 0,
      };
    });

    sendJsonResponse(req, res, 200, {views});
  } catch (error) {
    console.error("Error fetching content views:", error);
    handleError(req, res, error);
  }
});

exports.analytics = functions.https.onRequest(app);
