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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
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
 * POST /create-checkout
 * Create a Stripe Checkout Session for a private lesson.
 * Returns a checkout URL — the booking is created after payment via the Stripe webhook.
 */
app.post("/create-checkout", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to book a private lesson.");
    }

    const {instructorId, studioId, date, timeSlot, notes, contactInfo} = req.body;

    if (!instructorId || !studioId || !date || !timeSlot?.startTime || !timeSlot?.endTime) {
      return sendErrorResponse(req, res, 400, "Validation Error", "instructorId, studioId, date, and timeSlot are required");
    }

    const studentId = await bookingsService.getStudentId(user.uid);

    // Build redirect URLs pointing back to the users-app
    const appOrigin = req.headers.origin || "https://danceup.com";
    const successUrl = `${appOrigin}/bookings/confirmation`;
    const cancelUrl = `${appOrigin}/studios/${studioId}/instructor/${instructorId}/book`;

    const result = await bookingsService.createPrivateLessonCheckout(
        {instructorId, studioId, date, timeSlot, notes, contactInfo},
        {uid: user.uid, email: user.email},
        studentId,
        successUrl,
        cancelUrl,
    );

    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    console.error("Error creating private lesson checkout:", error);
    if (error.message === "This time slot is no longer available") {
      return sendErrorResponse(req, res, 409, "Conflict", error.message);
    }
    handleError(req, res, error);
  }
});

/**
 * POST /charge-saved
 * Charge a user's saved Stripe payment method directly for a private lesson.
 * Creates the confirmed booking immediately (no webhook needed).
 * Body: { instructorId, studioId, date, timeSlot, paymentMethodId, notes? }
 */
app.post("/charge-saved", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to book a private lesson.");
    }

    const {instructorId, studioId, date, timeSlot, paymentMethodId, notes} = req.body;
    if (!instructorId || !studioId || !date || !timeSlot?.startTime || !timeSlot?.endTime || !paymentMethodId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "instructorId, studioId, date, timeSlot, and paymentMethodId are required");
    }

    const db = require("./utils/firestore").getFirestore();
    const stripeService = require("./services/stripe.service");
    const instructorsService = require("./services/instructors.service");
    const authService = require("./services/auth.service");
    const sendgridService = require("./services/sendgrid.service");
    const notificationsService = require("./services/notifications.service");
    const admin = require("firebase-admin");

    // Confirm slot is still free
    const isAvailable = await bookingsService.isTimeSlotAvailable(instructorId, date, timeSlot);
    if (!isAvailable) {
      return sendErrorResponse(req, res, 409, "Conflict", "This time slot is no longer available");
    }

    // Get instructor rate
    const instructor = await instructorsService.getPublicInstructorById(instructorId);
    if (!instructor) return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    if (!instructor.privateRate || instructor.privateRate <= 0) {
      return sendErrorResponse(req, res, 400, "Bad Request", "This instructor does not have a private lesson rate set");
    }

    const instructorName = [instructor.firstName, instructor.lastName].filter(Boolean).join(" ");

    // Resolve Stripe customer ID from usersStudentProfiles
    const profileDoc = await authService.getStudentProfileByAuthUid(user.uid);
    let stripeCustomerId = profileDoc ? (profileDoc.data().stripeCustomerId || null) : null;

    if (!stripeCustomerId) {
      const userQuery = await db.collection("users").where("authUid", "==", user.uid).limit(1).get();
      if (!userQuery.empty) stripeCustomerId = userQuery.docs[0].data().stripeCustomerId || null;
    }

    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No saved payment method on file. Please add a card first.");
    }

    // Verify payment method belongs to this customer
    const savedMethods = await stripeService.listPaymentMethods(stripeCustomerId);
    if (!savedMethods.some((pm) => pm.id === paymentMethodId)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    // Look up studio owner's Stripe Connect account
    const studioOwnerDoc = await db.collection("users").doc(studioId).get();
    const studioOwnerData = studioOwnerDoc.exists ? studioOwnerDoc.data() : {};
    const connectedAccountId = studioOwnerData.stripeAccountId || null;
    const studioName = studioOwnerData.studioName || "Studio";

    const amountCents = Math.round(instructor.privateRate * 100);
    const studentId = await bookingsService.getStudentId(user.uid);

    const metadata = {
      purchaseType: "private_lesson",
      instructorId,
      instructorName,
      studioId,
      studioName,
      date,
      timeSlotStart: timeSlot.startTime,
      timeSlotEnd: timeSlot.endTime,
      notes: notes || "",
      studentId,
      authUid: user.uid,
      amountPaid: String(instructor.privateRate),
    };

    // Charge saved card
    const paymentIntent = await stripeService.chargePaymentMethodDirectly(
        stripeCustomerId,
        paymentMethodId,
        amountCents,
        metadata,
        connectedAccountId,
    );

    if (paymentIntent.status === "requires_action") {
      return sendJsonResponse(req, res, 200, {requiresAction: true, clientSecret: paymentIntent.client_secret});
    }

    if (paymentIntent.status !== "succeeded") {
      return sendErrorResponse(req, res, 402, "Payment Failed", "Payment could not be completed. Please try a different card.");
    }

    // Create confirmed booking
    const bookingDoc = {
      studentId,
      authUid: user.uid,
      instructorId,
      studioId,
      date,
      timeSlot: {startTime: timeSlot.startTime, endTime: timeSlot.endTime},
      status: "confirmed",
      paymentStatus: "paid",
      stripePaymentIntentId: paymentIntent.id,
      notes: notes || null,
      amountPaid: instructor.privateRate,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const bookingRef = await db.collection("privateLessonBookings").add(bookingDoc);

    // Send confirmation email (non-fatal)
    try {
      const recipientEmail = profileDoc ? profileDoc.data().email : user.email;
      if (recipientEmail) {
        await sendgridService.sendConfirmationEmail(recipientEmail, "private_lesson", {
          instructorName,
          studioName,
          date,
          timeSlot: `${timeSlot.startTime} – ${timeSlot.endTime}`,
          amountPaid: instructor.privateRate,
        });
      }
    } catch (emailErr) {
      console.error("[charge-saved booking] Email error:", emailErr);
    }

    // Notify studio owner (non-fatal)
    try {
      await notificationsService.createNotification(
          studioId,
          bookingRef.id,
          "private_lesson_booking",
          "New Private Lesson Booked & Paid",
          `A private lesson with ${instructorName} on ${date} was paid and confirmed.`,
      );
    } catch (notifyErr) {
      console.error("[charge-saved booking] Notification error:", notifyErr);
    }

    sendJsonResponse(req, res, 200, {
      success: true,
      bookingId: bookingRef.id,
      instructorName,
      studioName,
      date,
      timeSlot,
      amountPaid: instructor.privateRate,
    });
  } catch (error) {
    console.error("charge-saved booking error:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /instructor/:instructorId
 * Get bookings for an instructor within a date range
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 */
app.get("/instructor/:instructorId", async (req, res) => {
  try {
    // Verify token — booking schedules include student PII
    try {
      await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

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
