const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const notificationsService = require("./services/notifications.service");
const {verifyToken} = require("./utils/auth");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
} = require("./utils/http");

// Initialize Express app
const app = express();

// CORS — only reflect origin if it is in the allowlist
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({extended: true}));

/**
 * GET /
 * Get notifications for current studio (with pagination, 90-day filter)
 */
app.get("/", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await notificationsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get query parameters
    const limit = parseInt(req.query.limit) || 50;
    const startAfter = req.query.startAfter || null;

    // Get notifications
    const notifications = await notificationsService.getNotificationsByStudio(
        studioOwnerId,
        limit,
        startAfter,
    );

    sendJsonResponse(req, res, 200, notifications);
  } catch (error) {
    console.error("Error getting notifications:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /unread-count
 * Get unread notification count
 */
app.get("/unread-count", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await notificationsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get unread count
    const count = await notificationsService.getUnreadCount(studioOwnerId);

    sendJsonResponse(req, res, 200, { count });
  } catch (error) {
    console.error("Error getting unread count:", error);
    handleError(req, res, error);
  }
});


/**
 * PATCH /:notificationId/read
 * Mark notification as read
 */
app.patch("/:notificationId/read", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {notificationId} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await notificationsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Mark as read
    await notificationsService.markNotificationAsRead(notificationId, studioOwnerId);

    // Get updated notification
    const {getFirestore} = require("./utils/firestore");
    const db = getFirestore();
    const notificationRef = db.collection("notifications").doc(notificationId);
    const doc = await notificationRef.get();
    const notification = {
      id: doc.id,
      ...doc.data(),
    };

    sendJsonResponse(req, res, 200, notification);
  } catch (error) {
    console.error("Error marking notification as read:", error);
    if (error.message === "Notification not found") {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }
    handleError(req, res, error);
  }
});


/**
 * PATCH /:notificationId/unread
 * Mark notification as unread
 */
app.patch("/:notificationId/unread", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {notificationId} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await notificationsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Mark as unread
    await notificationsService.markNotificationAsUnread(notificationId, studioOwnerId);

    // Get updated notification
    const {getFirestore} = require("./utils/firestore");
    const db = getFirestore();
    const notificationRef = db.collection("notifications").doc(notificationId);
    const doc = await notificationRef.get();
    const notification = {
      id: doc.id,
      ...doc.data(),
    };

    sendJsonResponse(req, res, 200, notification);
  } catch (error) {
    console.error("Error marking notification as unread:", error);
    if (error.message === "Notification not found") {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }
    handleError(req, res, error);
  }
});

// Export Express app as Firebase Function
exports.notifications = functions.https.onRequest(app);

