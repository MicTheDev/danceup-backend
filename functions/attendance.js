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
    console.log("[Attendance API] GET /classes - Starting request");
    
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
      console.log("[Attendance API] User authenticated:", user.uid);
    } catch (authError) {
      console.error("[Attendance API] Authentication error:", authError);
      return handleError(req, res, authError);
    }

    // Get studio owner ID from authenticated user
    console.log("[Attendance API] Getting studio owner ID...");
    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      console.error("[Attendance API] Studio owner not found for user:", user.uid);
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    console.log("[Attendance API] Studio owner ID:", studioOwnerId);

    // Parse optional date range from query params
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);
    console.log("[Attendance API] Date range:", { startDate, endDate });

    // Get class attendance stats
    console.log("[Attendance API] Fetching class attendance stats...");
    const stats = await attendanceService.getClassAttendanceStats(studioOwnerId, startDate, endDate);
    console.log("[Attendance API] Stats retrieved:", {
      total: stats.total,
      weeklyCount: stats.weekly.length,
      monthlyCount: stats.monthly.length,
      byClassCount: stats.byClass.length,
    });

    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("[Attendance API] Error getting class attendance stats:", error);
    console.error("[Attendance API] Error stack:", error.stack);
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

/**
 * GET /students/:studentId
 * Get all attendance records for a specific student
 */
app.get("/students/:studentId", async (req, res) => {
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

    const {studentId} = req.params;

    // Get attendance records for the student
    const records = await attendanceService.getAttendanceRecordsByStudent(studentId, studioOwnerId);

    sendJsonResponse(req, res, 200, records);
  } catch (error) {
    console.error("Error getting attendance records for student:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }
    if (error.message?.includes("does not belong") || error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * GET /classes/:classId
 * Get attendance statistics for a specific class
 */
app.get("/classes/:classId", async (req, res) => {
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

    const { classId } = req.params;

    // Parse optional date range from query params
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    // Get class-specific attendance stats
    const stats = await attendanceService.getClassSpecificAttendanceStats(studioOwnerId, classId, startDate, endDate);

    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting class-specific attendance stats:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new attendance record
 */
app.post("/", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const body = req.body;

    // Validate required fields
    if (!body.studentId && !body.studentAuthUid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Either studentId or studentAuthUid is required");
    }

    // Validate checkedInBy
    if (!body.checkedInBy || !["studio", "student"].includes(body.checkedInBy)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "checkedInBy must be 'studio' or 'student'");
    }

    // Resolve studentId from authUid if needed
    let studentId = body.studentId;
    if (!studentId && body.studentAuthUid) {
      studentId = await attendanceService.getStudentIdByAuthUid(body.studentAuthUid);
      if (!studentId) {
        return sendErrorResponse(req, res, 404, "Not Found", "Student not found for the provided authUid");
      }
    }

    // Get studio owner ID based on who is checking in
    let studioOwnerId;
    if (body.checkedInBy === "student") {
      // For student check-ins, get studio owner ID from the student record
      const {getFirestore} = require("./utils/firestore");
      const db = getFirestore();
      const studentRef = db.collection("students").doc(studentId);
      const studentDoc = await studentRef.get();
      
      if (!studentDoc.exists) {
        return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
      }
      
      const studentData = studentDoc.data();
      studioOwnerId = studentData.studioOwnerId;
      
      if (!studioOwnerId) {
        return sendErrorResponse(req, res, 400, "Validation Error", "Student record does not have a studio owner ID");
      }

      // Verify that the authenticated user matches the student
      if (studentData.authUid !== user.uid) {
        return sendErrorResponse(req, res, 403, "Access Denied", "You can only check in as yourself");
      }
    } else {
      // For studio check-ins, get studio owner ID from authenticated user
      studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
      if (!studioOwnerId) {
        return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
      }
    }

    // Validate that exactly one of classId, workshopId, or eventId is provided
    const idCount = [body.classId, body.workshopId, body.eventId].filter(Boolean).length;
    if (idCount !== 1) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Exactly one of classId, workshopId, or eventId must be provided");
    }

    // Validate classInstanceDate
    if (!body.classInstanceDate) {
      return sendErrorResponse(req, res, 400, "Validation Error", "classInstanceDate is required");
    }

    // Prepare attendance data
    const attendanceData = {
      studentId: studentId,
      classId: body.classId,
      workshopId: body.workshopId,
      eventId: body.eventId,
      classInstanceDate: body.classInstanceDate,
      checkedInBy: body.checkedInBy,
      checkedInById: body.checkedInById,
      checkedInAt: body.checkedInAt,
    };

    // Create attendance record
    const attendanceId = await attendanceService.createAttendanceRecord(attendanceData, studioOwnerId);

    sendJsonResponse(req, res, 201, {
      id: attendanceId,
      message: "Attendance record created successfully",
    });
  } catch (error) {
    console.error("Error creating attendance record:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }
    if (error.message?.includes("does not belong") || error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }
    if (error.message?.includes("required") || error.message?.includes("must be")) {
      return sendErrorResponse(req, res, 400, "Validation Error", error.message);
    }
    if (error.message?.includes("already checked in")) {
      return sendErrorResponse(req, res, 409, "Conflict", error.message);
    }
    if (error.message?.includes("Insufficient credits") || error.message?.includes("No available credits")) {
      return sendErrorResponse(req, res, 402, "Payment Required", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * DELETE /:id
 * Remove an attendance record (studio owner only)
 */
app.delete("/:id", async (req, res) => {
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

    const {id} = req.params;

    // Remove attendance record
    await attendanceService.removeAttendanceRecord(id, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Attendance record removed successfully",
      creditRestored: true,
    });
  } catch (error) {
    console.error("Error removing attendance record:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }
    if (error.message?.includes("does not belong") || error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }
    if (error.message?.includes("already removed")) {
      return sendErrorResponse(req, res, 409, "Conflict", error.message);
    }

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



