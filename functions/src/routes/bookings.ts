import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import bookingsService from "../services/bookings.service";
import notificationsService from "../services/notifications.service";
import instructorsService from "../services/instructors.service";
import authService from "../services/auth.service";
import * as stripeService from "../services/stripe.service";
import * as sendgridService from "../services/sendgrid.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { validateCreateBookingPayload } from "../utils/validation";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

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
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

app.get("/student/my-bookings", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentId = await bookingsService.getStudentId(user.uid);
    const bookings = await bookingsService.getBookingsByStudent(studentId);
    sendJsonResponse(req, res, 200, bookings);
  } catch (error) {
    console.error("Error getting student bookings:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentId = await bookingsService.getStudentId(user.uid);

    const validation = validateCreateBookingPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid booking data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const bookingId = await bookingsService.createBooking(req.body, studentId);
    const booking = await bookingsService.getBookingById(bookingId);

    try {
      let instructorName = "an instructor";
      try {
        const instructor = await instructorsService.getPublicInstructorById((req.body as Record<string, unknown>)["instructorId"] as string) as Record<string, unknown> | null;
        if (instructor) {
          instructorName = `${instructor["firstName"] || ""} ${instructor["lastName"] || ""}`.trim() || "an instructor";
        }
      } catch (err) { console.error("Error fetching instructor for notification:", err); }

      const bookingDate = new Date((req.body as Record<string, unknown>)["date"] as string);
      const formattedDate = bookingDate.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      await notificationsService.createNotification(
        (req.body as Record<string, unknown>)["studioId"] as string,
        bookingId,
        "private_lesson_booking",
        "New Private Lesson Booking",
        `A new private lesson has been booked for ${instructorName} on ${formattedDate}`,
      );
    } catch (err) { console.error("Error creating notification:", err); }

    sendJsonResponse(req, res, 201, booking);
  } catch (error) {
    console.error("Error creating booking:", error);
    if ((error as Error).message === "Time slot is already booked") {
      return sendErrorResponse(req, res, 409, "Conflict", (error as Error).message);
    }
    handleError(req, res, error);
  }
});

app.post("/create-checkout", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to book a private lesson.");
    }

    const { instructorId, studioId, date, timeSlot, notes, contactInfo } = req.body as Record<string, unknown>;

    if (!instructorId || !studioId || !date || !(timeSlot as Record<string, unknown>)?.["startTime"] || !(timeSlot as Record<string, unknown>)?.["endTime"]) {
      return sendErrorResponse(req, res, 400, "Validation Error", "instructorId, studioId, date, and timeSlot are required");
    }

    const studentId = await bookingsService.getStudentId(user.uid);
    const appOrigin = req.headers.origin || "https://danceup.com";
    const successUrl = `${appOrigin}/bookings/confirmation`;
    const cancelUrl = `${appOrigin}/studios/${studioId}/instructor/${instructorId}/book`;

    const result = await bookingsService.createPrivateLessonCheckout(
      {
        instructorId: instructorId as string,
        studioId: studioId as string,
        date: date as string,
        timeSlot: timeSlot as { startTime: string; endTime: string },
        notes: notes as string | null | undefined,
        contactInfo: contactInfo as { email?: string; phone?: string } | null | undefined,
      },
      { uid: user.uid, email: user.email },
      studentId,
      successUrl as string,
      cancelUrl as string,
    );

    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    console.error("Error creating private lesson checkout:", error);
    if ((error as Error).message === "This time slot is no longer available") {
      return sendErrorResponse(req, res, 409, "Conflict", (error as Error).message);
    }
    handleError(req, res, error);
  }
});

app.post("/charge-saved", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to book a private lesson.");
    }

    const { instructorId, studioId, date, timeSlot, paymentMethodId, notes } = req.body as Record<string, unknown>;
    const ts = timeSlot as Record<string, unknown> | undefined;
    if (!instructorId || !studioId || !date || !ts?.["startTime"] || !ts?.["endTime"] || !paymentMethodId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "instructorId, studioId, date, timeSlot, and paymentMethodId are required");
    }

    const isAvailable = await bookingsService.isTimeSlotAvailable(instructorId as string, date as string, timeSlot as { startTime: string; endTime: string });
    if (!isAvailable) {
      return sendErrorResponse(req, res, 409, "Conflict", "This time slot is no longer available");
    }

    const instructor = await instructorsService.getPublicInstructorById(instructorId as string) as Record<string, unknown> | null;
    if (!instructor) return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    if (!instructor["privateRate"] || (instructor["privateRate"] as number) <= 0) {
      return sendErrorResponse(req, res, 400, "Bad Request", "This instructor does not have a private lesson rate set");
    }

    const instructorName = [instructor["firstName"], instructor["lastName"]].filter(Boolean).join(" ");

    const db = getFirestore();
    const profileDoc = await authService.getStudentProfileByAuthUid(user.uid);
    let stripeCustomerId: string | null = profileDoc ? ((profileDoc.data() as Record<string, unknown>)["stripeCustomerId"] as string) || null : null;

    if (!stripeCustomerId) {
      const userQuery = await db.collection("users").where("authUid", "==", user.uid).limit(1).get();
      if (!userQuery.empty) {
        const firstDoc = userQuery.docs[0];
        if (firstDoc) stripeCustomerId = ((firstDoc.data() as Record<string, unknown>)["stripeCustomerId"] as string) || null;
      }
    }

    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No saved payment method on file. Please add a card first.");
    }

    const savedMethods = await stripeService.listPaymentMethods(stripeCustomerId);
    if (!savedMethods.some((pm) => pm.id === paymentMethodId)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    const studioOwnerDoc = await db.collection("users").doc(studioId as string).get();
    const studioOwnerData = studioOwnerDoc.exists ? (studioOwnerDoc.data() as Record<string, unknown>) : {};
    const connectedAccountId = (studioOwnerData["stripeAccountId"] as string) || null;
    const studioName = (studioOwnerData["studioName"] as string) || "Studio";

    const amountCents = Math.round((instructor["privateRate"] as number) * 100);
    const studentId = await bookingsService.getStudentId(user.uid);

    const metadata = {
      purchaseType: "private_lesson",
      instructorId: instructorId as string,
      instructorName,
      studioId: studioId as string,
      studioName,
      date: date as string,
      timeSlotStart: ts["startTime"] as string,
      timeSlotEnd: ts["endTime"] as string,
      notes: (notes as string) || "",
      studentId,
      authUid: user.uid,
      amountPaid: String(instructor["privateRate"]),
    };

    const paymentIntent = await stripeService.chargePaymentMethodDirectly(
      stripeCustomerId,
      paymentMethodId as string,
      amountCents,
      metadata,
      connectedAccountId,
    );

    const piData = paymentIntent as unknown as Record<string, unknown>;
    if (piData["status"] === "requires_action") {
      return sendJsonResponse(req, res, 200, { requiresAction: true, clientSecret: piData["client_secret"] });
    }

    if (piData["status"] !== "succeeded") {
      return sendErrorResponse(req, res, 402, "Payment Failed", "Payment could not be completed. Please try a different card.");
    }

    const bookingDoc = {
      studentId,
      authUid: user.uid,
      instructorId,
      studioId,
      date,
      timeSlot: { startTime: ts["startTime"], endTime: ts["endTime"] },
      status: "confirmed",
      paymentStatus: "paid",
      stripePaymentIntentId: piData["id"],
      notes: (notes as string) || null,
      amountPaid: instructor["privateRate"],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const bookingRef = await db.collection("privateLessonBookings").add(bookingDoc);

    try {
      const recipientEmail = profileDoc ? ((profileDoc.data() as Record<string, unknown>)["email"] as string) : user.email;
      if (recipientEmail) {
        await sendgridService.sendConfirmationEmail(recipientEmail, "private_lesson", {
          instructorName,
          studioName,
          date: date as string,
          timeSlot: `${ts["startTime"]} – ${ts["endTime"]}`,
          amountPaid: instructor["privateRate"] as number,
        });
      }
    } catch (emailErr) { console.error("[charge-saved booking] Email error:", emailErr); }

    try {
      await notificationsService.createNotification(
        studioId as string,
        bookingRef.id,
        "private_lesson_booking",
        "New Private Lesson Booked & Paid",
        `A private lesson with ${instructorName} on ${date} was paid and confirmed.`,
      );
    } catch (notifyErr) { console.error("[charge-saved booking] Notification error:", notifyErr); }

    sendJsonResponse(req, res, 200, {
      success: true,
      bookingId: bookingRef.id,
      instructorName,
      studioName,
      date,
      timeSlot,
      amountPaid: instructor["privateRate"],
    });
  } catch (error) {
    console.error("charge-saved booking error:", error);
    handleError(req, res, error);
  }
});

app.get("/instructor/:instructorId", async (req, res) => {
  try {
    try { await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const instructorId = req.params["instructorId"] as string;
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };

    if (!startDate || !endDate) {
      return sendErrorResponse(req, res, 400, "Validation Error", "startDate and endDate query parameters are required");
    }

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

app.get("/studio/:bookingId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const booking = await bookingsService.getBookingByIdForStudio(req.params["bookingId"] as string, userDoc.id);
    if (!booking) {
      return sendErrorResponse(req, res, 404, "Not Found", "Booking not found");
    }

    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error getting booking:", error);
    if ((error as Error).message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", (error as Error).message);
    }
    handleError(req, res, error);
  }
});

app.get("/:bookingId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const booking = await bookingsService.getBookingById(req.params["bookingId"] as string) as Record<string, unknown> | null;
    if (!booking) {
      return sendErrorResponse(req, res, 404, "Not Found", "Booking not found");
    }

    const studentId = await bookingsService.getStudentId(user.uid);
    if (booking["studentId"] !== studentId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only view your own bookings");
    }

    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error getting booking:", error);
    handleError(req, res, error);
  }
});

app.patch("/:bookingId/cancel", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentId = await bookingsService.getStudentId(user.uid);
    await bookingsService.cancelBooking(req.params["bookingId"] as string, studentId);
    const booking = await bookingsService.getBookingById(req.params["bookingId"] as string);
    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error cancelling booking:", error);
    const msg = (error as Error).message;
    if (msg === "Booking not found") return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied") || msg?.includes("already cancelled")) {
      return sendErrorResponse(req, res, 400, "Bad Request", msg);
    }
    handleError(req, res, error);
  }
});

app.patch("/:bookingId/confirm", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const studioOwnerId = userDoc.id;
    const bookingId = req.params["bookingId"] as string;

    const booking = await bookingsService.confirmBooking(bookingId, studioOwnerId);

    try {
      const db = getFirestore();
      const notificationsSnapshot = await db.collection("notifications")
        .where("studioId", "==", studioOwnerId)
        .where("bookingId", "==", bookingId)
        .limit(1)
        .get();
      if (!notificationsSnapshot.empty) {
        const notificationDoc = notificationsSnapshot.docs[0];
        if (notificationDoc) {
          await notificationsService.markNotificationAsRead(notificationDoc.id, studioOwnerId);
        }
      }
    } catch (err) { console.error("Error marking notification as read:", err); }

    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error confirming booking:", error);
    const msg = (error as Error).message;
    if (msg === "Booking not found") return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied") || msg?.includes("already confirmed") || msg?.includes("Cannot confirm")) {
      return sendErrorResponse(req, res, 400, "Bad Request", msg);
    }
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const bookings = functions.https.onRequest(app);
