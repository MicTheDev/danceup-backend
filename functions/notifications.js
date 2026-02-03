const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const notificationsService = require("./services/notifications.service");
const {verifyToken} = require("./utils/auth");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
} = require("./utils/http");

// Initialize Express app
const app = express();

// Explicit CORS handling - must be before other middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Set CORS headers
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  
  next();
});

// CORS configuration (backup)
const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return callback(null, true);
    }
    callback(null, true);
  },
  credentials: true,
  methods: ["GET", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

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
 * OPTIONS /:notificationId/read
 * Handle CORS preflight for mark as read endpoint
 */
app.options("/:notificationId/read", (req, res) => {
  res.status(204).send("");
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
 * OPTIONS /:notificationId/unread
 * Handle CORS preflight for mark as unread endpoint
 */
app.options("/:notificationId/unread", (req, res) => {
  res.status(204).send("");
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

