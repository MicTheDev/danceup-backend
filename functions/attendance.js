const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const attendanceService = require("./services/attendance.service");
const {verifyToken} = require("./utils/auth");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  
  next();
});

// Apply CORS middleware (backup)
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({extended: true}));

/**
 * Helper function to parse date from query string
 * @param {string} dateString - ISO date string
 * @returns {Date | null} Parsed date or null
 */
function parseDate(dateString) {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * GET /classes
 * Get class attendance statistics (weekly, monthly, and per-class)
 */
app.get("/classes", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Parse optional date range from query params
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    // Get class attendance stats
    const stats = await attendanceService.getClassAttendanceStats(studioOwnerId, startDate, endDate);

    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting class attendance stats:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /workshops
 * Get workshop attendance statistics (total and per-workshop)
 */
app.get("/workshops", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Parse optional date range from query params
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    // Get workshop attendance stats
    const stats = await attendanceService.getWorkshopAttendanceStats(studioOwnerId, startDate, endDate);

    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting workshop attendance stats:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /events
 * Get event attendance statistics (weekly and monthly)
 */
app.get("/events", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Parse optional date range from query params
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    // Get event attendance stats
    const stats = await attendanceService.getEventAttendanceStats(studioOwnerId, startDate, endDate);

    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting event attendance stats:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /
 * Get aggregated attendance statistics for all types
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
    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Parse optional date range from query params
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    // Get all stats
    const [classStats, workshopStats, eventStats] = await Promise.all([
      attendanceService.getClassAttendanceStats(studioOwnerId, startDate, endDate),
      attendanceService.getWorkshopAttendanceStats(studioOwnerId, startDate, endDate),
      attendanceService.getEventAttendanceStats(studioOwnerId, startDate, endDate),
    ]);

    sendJsonResponse(req, res, 200, {
      classes: classStats,
      workshops: workshopStats,
      events: eventStats,
    });
  } catch (error) {
    console.error("Error getting attendance stats:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.attendance = functions.https.onRequest(app);



