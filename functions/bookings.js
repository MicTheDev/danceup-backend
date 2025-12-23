const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const bookingsService = require("./services/bookings.service");
const {verifyToken} = require("./utils/auth");
const {validateCreateBookingPayload} = require("./utils/validation");
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
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
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
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
 * POST /
 * Create a new booking
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

    // Get student ID from authenticated user (or use authUid if no profile exists)
    const studentId = await bookingsService.getStudentId(user.uid);

    // Validate payload
    const validation = validateCreateBookingPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid booking data", {
        errors: validation.errors,
      });
    }

    // Create booking
    const bookingId = await bookingsService.createBooking(req.body, studentId);
    const booking = await bookingsService.getBookingById(bookingId);

    // Create notification for studio owner
    try {
      const notificationsService = require("./services/notifications.service");
      const instructorsService = require("./services/instructors.service");
      
      // Get instructor name for notification message
      let instructorName = "an instructor";
      try {
        const instructor = await instructorsService.getPublicInstructorById(req.body.instructorId);
        if (instructor) {
          instructorName = `${instructor.firstName || ""} ${instructor.lastName || ""}`.trim() || "an instructor";
        }
      } catch (error) {
        console.error("Error fetching instructor for notification:", error);
      }

      // Format date for notification message
      const bookingDate = new Date(req.body.date);
      const formattedDate = bookingDate.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      await notificationsService.createNotification(
          req.body.studioId,
          bookingId,
          "private_lesson_booking",
          "New Private Lesson Booking",
          `A new private lesson has been booked for ${instructorName} on ${formattedDate}`,
      );
    } catch (error) {
      // Log error but don't fail the booking creation
      console.error("Error creating notification:", error);
    }

    sendJsonResponse(req, res, 201, booking);
  } catch (error) {
    console.error("Error creating booking:", error);
    if (error.message === "Time slot is already booked") {
      return sendErrorResponse(req, res, 409, "Conflict", error.message);
    }
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /instructor/:instructorId
 * Handle CORS preflight for instructor bookings endpoint
 */
app.options("/instructor/:instructorId", (req, res) => {
  res.status(204).send("");
});

/**
 * GET /instructor/:instructorId
 * Get bookings for an instructor within a date range
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 */
app.get("/instructor/:instructorId", async (req, res) => {
  try {
    const {instructorId} = req.params;
    const {startDate, endDate} = req.query;

    if (!startDate || !endDate) {
      return sendErrorResponse(req, res, 400, "Validation Error", "startDate and endDate query parameters are required");
    }

    // Validate date formats
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Dates must be in YYYY-MM-DD format");
    }

    const bookings = await bookingsService.getBookingsByInstructor(instructorId, startDate, endDate);

    sendJsonResponse(req, res, 200, bookings);
  } catch (error) {
    console.error("Error getting instructor bookings:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /:bookingId
 * Handle CORS preflight for booking detail endpoint
 */
app.options("/:bookingId", (req, res) => {
  res.status(204).send("");
});

/**
 * GET /:bookingId
 * Get a single booking by ID
 */
app.get("/:bookingId", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {bookingId} = req.params;
    const booking = await bookingsService.getBookingById(bookingId);

    if (!booking) {
      return sendErrorResponse(req, res, 404, "Not Found", "Booking not found");
    }

    // Verify ownership (user can only view their own bookings)
    const studentId = await bookingsService.getStudentId(user.uid);
    if (booking.studentId !== studentId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only view your own bookings");
    }

    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error getting booking:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /:bookingId/cancel
 * Handle CORS preflight for cancel booking endpoint
 */
app.options("/:bookingId/cancel", (req, res) => {
  res.status(204).send("");
});

/**
 * PATCH /:bookingId/cancel
 * Cancel a booking
 */
app.patch("/:bookingId/cancel", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {bookingId} = req.params;

    // Get student ID from authenticated user (or use authUid if no profile exists)
    const studentId = await bookingsService.getStudentId(user.uid);

    // Cancel booking
    await bookingsService.cancelBooking(bookingId, studentId);
    const booking = await bookingsService.getBookingById(bookingId);

    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error cancelling booking:", error);
    if (error.message === "Booking not found") {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }
    if (error.message.includes("Access denied") || error.message.includes("already cancelled")) {
      return sendErrorResponse(req, res, 400, "Bad Request", error.message);
    }
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /student/my-bookings
 * Handle CORS preflight for student bookings endpoint
 */
app.options("/student/my-bookings", (req, res) => {
  res.status(204).send("");
});

/**
 * GET /student/my-bookings
 * Get authenticated student's bookings
 */
app.get("/student/my-bookings", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get student ID from authenticated user (or use authUid if no profile exists)
    const studentId = await bookingsService.getStudentId(user.uid);

    // Get student's bookings
    const bookings = await bookingsService.getBookingsByStudent(studentId);

    sendJsonResponse(req, res, 200, bookings);
  } catch (error) {
    console.error("Error getting student bookings:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /:bookingId/confirm
 * Handle CORS preflight for confirm booking endpoint
 */
app.options("/:bookingId/confirm", (req, res) => {
  res.status(204).send("");
});

/**
 * PATCH /:bookingId/confirm
 * Confirm a booking (studio owner only)
 */
app.patch("/:bookingId/confirm", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {bookingId} = req.params;

    // Get studio owner ID from authenticated user
    const authService = require("./services/auth.service");
    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const studioOwnerId = userDoc.id;

    // Confirm booking
    const booking = await bookingsService.confirmBooking(bookingId, studioOwnerId);

    // Mark related notification as read
    try {
      const notificationsService = require("./services/notifications.service");
      const db = require("firebase-admin").firestore();
      const notificationsSnapshot = await db.collection("notifications")
          .where("studioId", "==", studioOwnerId)
          .where("bookingId", "==", bookingId)
          .limit(1)
          .get();

      if (!notificationsSnapshot.empty) {
        const notificationDoc = notificationsSnapshot.docs[0];
        await notificationsService.markNotificationAsRead(notificationDoc.id, studioOwnerId);
      }
    } catch (error) {
      // Log error but don't fail the confirmation
      console.error("Error marking notification as read:", error);
    }

    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error confirming booking:", error);
    if (error.message === "Booking not found") {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }
    if (error.message?.includes("Access denied") || error.message?.includes("already confirmed") || error.message?.includes("Cannot confirm")) {
      return sendErrorResponse(req, res, 400, "Bad Request", error.message);
    }
    handleError(req, res, error);
  }
});

/**
 * GET /studio/:bookingId
 * Get a booking by ID for studio owner (includes student/instructor info)
 */
app.get("/studio/:bookingId", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {bookingId} = req.params;

    // Get studio owner ID from authenticated user
    const authService = require("./services/auth.service");
    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const studioOwnerId = userDoc.id;

    // Get booking with student/instructor info
    const booking = await bookingsService.getBookingByIdForStudio(bookingId, studioOwnerId);

    if (!booking) {
      return sendErrorResponse(req, res, 404, "Not Found", "Booking not found");
    }

    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error getting booking:", error);
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }
    handleError(req, res, error);
  }
});

// Export Express app as Firebase Function
exports.bookings = functions.https.onRequest(app);
