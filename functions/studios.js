const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const studiosService = require("./services/studios.service");
const studioEnrollmentService = require("./services/studio-enrollment.service");
const notificationsService = require("./services/notifications.service");
const {verifyToken} = require("./utils/auth");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} = require("./utils/http");

// Initialize Express app
const app = express();

// CORS — only reflect origin if it is in the allowlist
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  next();
});

app.use(cors(corsOptions));

app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({extended: true}));


/**
 * GET /public
 * Get all public studios with optional filters (no authentication required)
 */
app.get("/public", async (req, res) => {
  try {
    // Extract filter parameters from query string
    const filters = {
      city: req.query.city || null,
      state: req.query.state || null,
      studioName: req.query.studioName || null,
    };

    // Get all public studios with filters
    const studios = await studiosService.getAllPublicStudios(filters);

    sendJsonResponse(req, res, 200, studios);
  } catch (error) {
    console.error("Error getting public studios:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /public/:id
 * Get a single public studio by ID with instructor details (no authentication required)
 */
app.get("/public/:id", async (req, res) => {
  try {
    const {id} = req.params;

    // Get the studio with instructor details
    const studioData = await studiosService.getPublicStudioById(id);
    if (!studioData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio not found");
    }

    sendJsonResponse(req, res, 200, studioData);
  } catch (error) {
    console.error("Error getting public studio:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /public/:id/packages
 * Get all active packages for a studio (no authentication required)
 */
app.get("/public/:id/packages", async (req, res) => {
  try {
    const {id} = req.params;

    const packagesService = require("./services/packages.service");
    
    // Get all active packages for this studio
    const packages = await packagesService.getPackages(id);
    
    // Filter to only active packages
    const activePackages = packages.filter((pkg) => pkg.isActive);

    sendJsonResponse(req, res, 200, activePackages);
  } catch (error) {
    console.error("Error getting studio packages:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /public/:id/classes
 * Get all active classes for a studio (no authentication required)
 */
app.get("/public/:id/classes", async (req, res) => {
  try {
    const {id} = req.params;

    const classesService = require("./services/classes.service");
    
    // Get all classes for this studio
    const classes = await classesService.getClasses(id);
    
    // Filter to only active classes and enrich with studio info
    const activeClasses = classes.filter((cls) => cls.isActive);
    
    // Get studio info for enrichment
    const studioData = await studiosService.getPublicStudioById(id);
    
    const enrichedClasses = activeClasses.map((cls) => ({
      ...cls,
      studio: studioData ? {
        id: studioData.id,
        name: studioData.studioName,
        city: studioData.city,
        state: studioData.state,
        addressLine1: studioData.studioAddressLine1,
        addressLine2: studioData.studioAddressLine2 || null,
        zip: studioData.zip,
      } : null,
    }));

    sendJsonResponse(req, res, 200, enrichedClasses);
  } catch (error) {
    console.error("Error getting studio classes:", error);
    handleError(req, res, error);
  }
});


/**
 * POST /:studioId/enroll
 * Enroll current user as a student for the studio
 */
app.post("/:studioId/enroll", async (req, res) => {
  try {
    // Verify authentication
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {studioId} = req.params;

    // Enroll the user
    const studentId = await studioEnrollmentService.enrollStudent(studioId, user.uid);

    // Get student data for notification
    const studentsService = require("./services/students.service");
    const studentData = await studentsService.getStudentById(studentId, studioId);

    // Create notification for studio owner
    const firstName = studentData.firstName || "A student";
    const lastName = studentData.lastName || "";
    const studentName = `${firstName} ${lastName}`.trim();
    
    await notificationsService.createNotification(
      studioId,
      null, // bookingId
      "student_enrollment",
      "New Student Enrollment",
      `${studentName} has joined your studio as a student`,
      studentId // studentId
    );

    sendJsonResponse(req, res, 200, {
      message: "Successfully enrolled as student",
      studentId: studentId,
    });
  } catch (error) {
    console.error("Error enrolling student:", error);
    
    // Handle specific error cases
    if (error.message?.includes("already enrolled")) {
      return sendErrorResponse(req, res, 400, "Bad Request", error.message);
    }
    if (error.message?.includes("profile not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    handleError(req, res, error);
  }
});


/**
 * POST /:studioId/unenroll
 * Unenroll current user from the studio
 */
app.post("/:studioId/unenroll", async (req, res) => {
  try {
    // Verify authentication
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {studioId} = req.params;

    // Unenroll the user
    await studioEnrollmentService.unenrollStudent(studioId, user.uid);

    sendJsonResponse(req, res, 200, {
      message: "Successfully unenrolled from studio",
    });
  } catch (error) {
    console.error("Error unenrolling student:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    handleError(req, res, error);
  }
});


/**
 * GET /:studioId/enrollment-status
 * Check if current user is enrolled as a student for the studio
 */
app.get("/:studioId/enrollment-status", async (req, res) => {
  try {
    // Verify authentication
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {studioId} = req.params;

    // Check enrollment status
    const isEnrolled = await studioEnrollmentService.checkEnrollmentStatus(studioId, user.uid);

    sendJsonResponse(req, res, 200, {
      isEnrolled: isEnrolled,
    });
  } catch (error) {
    console.error("Error checking enrollment status:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.studios = functions.https.onRequest(app);
