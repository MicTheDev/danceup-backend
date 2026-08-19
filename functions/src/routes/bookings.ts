import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import bookingsService from "../services/bookings.service";
import notificationsService from "../services/notifications.service";
import instructorsService from "../services/instructors.service";
import authService from "../services/auth.service";
import instructorLinkingService from "../services/instructor-linking.service";
import * as stripeService from "../services/stripe.service";
import * as sendgridService from "../services/sendgrid.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { validateCreateBookingPayload } from "../utils/validation";
import { sendStudentPush } from "../utils/push-notifications";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

/**
 * Sends the confirmation email + studio/instructor/student notifications for a
 * newly paid private-lesson booking. The single place all paid-booking entry
 * points (saved-card charge, new-card PaymentIntent confirm) call through, so
 * they can't drift out of sync the way the old Checkout-webhook path did when
 * it was never given the instructor-push logic added to the other two.
 */
async function notifyPrivateLessonBookingCreated(params: {
  bookingId: string;
  instructorId: string;
  studioId: string;
  studioName: string;
  instructorName: string;
  date: string;
  timeSlot: { startTime: string; endTime: string };
  amountPaid: number;
  authUid: string;
  studentEmail?: string | null;
}): Promise<void> {
  const { bookingId, instructorId, studioId, studioName, instructorName, date, timeSlot, amountPaid, authUid, studentEmail } = params;
  const db = getFirestore();

  try {
    if (studentEmail) {
      await sendgridService.sendConfirmationEmail(studentEmail, "private_lesson", {
        instructorName,
        studioName,
        date,
        timeSlot: `${timeSlot.startTime} – ${timeSlot.endTime}`,
        amountPaid,
      });
    }
  } catch (err) { console.error("[booking] Email error:", err); }

  try {
    await notificationsService.createNotification(
      studioId,
      bookingId,
      "private_lesson_booking",
      "New Private Lesson Request",
      `${instructorName} has a new private lesson request for ${date}. Payment received — confirm or cancel the booking.`,
    );
  } catch (err) { console.error("[booking] Studio notification error:", err); }

  try {
    const instructorDoc = await db.collection("instructors").doc(instructorId).get();
    const instructorAuthUid = instructorDoc.exists
      ? (instructorDoc.data() as Record<string, unknown>)["authUid"] as string | undefined
      : undefined;
    if (instructorAuthUid) {
      const pushTitle = "New private lesson request";
      const pushBody = `New request for ${date} at ${timeSlot.startTime} — payment received.`;
      await db.collection("studentNotifications").add({
        authUid: instructorAuthUid,
        context: "instructor",
        type: "new_private_booking",
        title: pushTitle,
        body: pushBody,
        bookingId,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await sendStudentPush(instructorAuthUid, pushTitle, pushBody);
    }
  } catch (err) { console.error("[booking] Instructor notification error:", err); }

  try {
    const pushTitle = "Private Lesson Payment Confirmed";
    const pushBody = `${instructorName} at ${studioName} — ${date} · $${amountPaid}`;
    await db.collection("studentNotifications").add({
      authUid,
      type: "payment",
      title: pushTitle,
      body: pushBody,
      bookingId,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await sendStudentPush(authUid, pushTitle, pushBody);
  } catch (err) { console.error("[booking] Student notification error:", err); }
}

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

    try {
      const instructorId = (req.body as Record<string, unknown>)["instructorId"] as string;
      const instructorDoc = await getFirestore().collection("instructors").doc(instructorId).get();
      const instructorAuthUid = instructorDoc.exists
        ? (instructorDoc.data() as Record<string, unknown>)["authUid"] as string | undefined
        : undefined;

      // Only linked instructors have a mobile identity to notify — a no-op for
      // instructors who haven't claimed a users-app account yet.
      if (instructorAuthUid) {
        const bookingDate = new Date((req.body as Record<string, unknown>)["date"] as string);
        const timeSlot = (req.body as Record<string, unknown>)["timeSlot"] as Record<string, unknown> | undefined;
        const formattedDate = bookingDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
        const studentProfileDoc = await getFirestore().collection("usersStudentProfiles").doc(studentId).get();
        const studentName = studentProfileDoc.exists
          ? `${(studentProfileDoc.data() as Record<string, unknown>)["firstName"] ?? ""} ${(studentProfileDoc.data() as Record<string, unknown>)["lastName"] ?? ""}`.trim()
          : "A student";

        const pushTitle = "New private lesson request";
        const pushBody = `${studentName || "A student"} requested a private lesson on ${formattedDate}${timeSlot?.["startTime"] ? ` at ${timeSlot["startTime"] as string}` : ""}`;

        await getFirestore().collection("studentNotifications").add({
          authUid: instructorAuthUid,
          context: "instructor",
          type: "new_private_booking",
          title: pushTitle,
          body: pushBody,
          bookingId,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await sendStudentPush(instructorAuthUid, pushTitle, pushBody);
      }
    } catch (err) { console.error("Error notifying instructor of new booking:", err); }

    sendJsonResponse(req, res, 201, booking);
  } catch (error) {
    console.error("Error creating booking:", error);
    if ((error as Error).message === "Time slot is already booked") {
      return sendErrorResponse(req, res, 409, "Conflict", (error as Error).message);
    }
    handleError(req, res, error);
  }
});

app.post("/create-payment-intent", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to book a private lesson.");
    }

    const { instructorId, studioId, date, timeSlot, notes, contactInfo, dependentId } = req.body as Record<string, unknown>;

    if (!instructorId || !studioId || !date || !(timeSlot as Record<string, unknown>)?.["startTime"] || !(timeSlot as Record<string, unknown>)?.["endTime"]) {
      return sendErrorResponse(req, res, 400, "Validation Error", "instructorId, studioId, date, and timeSlot are required");
    }

    // The account holder's own global profile id — unchanged for a dependent's
    // booking, since private lessons don't touch the per-studio credit ledger.
    // dependentId below is a display/notification tag only.
    const studentId = await bookingsService.getStudentId(user.uid);

    const result = await bookingsService.createPrivateLessonPaymentIntent(
      {
        instructorId: instructorId as string,
        studioId: studioId as string,
        date: date as string,
        timeSlot: timeSlot as { startTime: string; endTime: string },
        notes: notes as string | null | undefined,
        contactInfo: contactInfo as { email?: string; phone?: string } | null | undefined,
        dependentId: typeof dependentId === "string" ? dependentId : null,
      },
      { uid: user.uid, email: user.email },
      studentId,
    );

    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    console.error("Error creating private lesson payment intent:", error);
    if ((error as Error).message === "This time slot is no longer available") {
      return sendErrorResponse(req, res, 409, "Conflict", (error as Error).message);
    }
    handleError(req, res, error);
  }
});

app.post("/confirm-payment", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to book a private lesson.");
    }

    const { paymentIntentId } = req.body as Record<string, unknown>;
    if (!paymentIntentId || typeof paymentIntentId !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "paymentIntentId is required");
    }

    const booking = await bookingsService.confirmPrivateLessonPayment(paymentIntentId, user.uid);
    const bookingData = booking as Record<string, unknown>;

    const instructor = await instructorsService.getPublicInstructorById(bookingData["instructorId"] as string) as Record<string, unknown> | null;
    const instructorName = instructor ? [instructor["firstName"], instructor["lastName"]].filter(Boolean).join(" ") : "Instructor";
    const studioOwnerDoc = await getFirestore().collection("users").doc(bookingData["studioId"] as string).get();
    const studioName = studioOwnerDoc.exists
      ? ((studioOwnerDoc.data() as Record<string, unknown>)["studioName"] as string) || "Studio"
      : "Studio";

    const profileDoc = await authService.getStudentProfileByAuthUid(user.uid);
    const recipientEmail = profileDoc ? ((profileDoc.data() as Record<string, unknown>)["email"] as string) : user.email;

    const timeSlot = bookingData["timeSlot"] as { startTime: string; endTime: string };
    await notifyPrivateLessonBookingCreated({
      bookingId: booking.id,
      instructorId: bookingData["instructorId"] as string,
      studioId: bookingData["studioId"] as string,
      studioName,
      instructorName,
      date: bookingData["date"] as string,
      timeSlot,
      amountPaid: (bookingData["amountPaid"] as number) || 0,
      authUid: user.uid,
      studentEmail: recipientEmail,
    });

    sendJsonResponse(req, res, 200, {
      success: true,
      bookingId: booking.id,
      instructorName,
      studioName,
      date: bookingData["date"],
      timeSlot,
      amountPaid: bookingData["amountPaid"],
    });
  } catch (error) {
    console.error("Error confirming private lesson payment:", error);
    const msg = (error as Error).message;
    if (msg === "Payment record not found") return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg === "Access denied") return sendErrorResponse(req, res, 403, "Access Denied", msg);
    if (msg === "Payment not completed") return sendErrorResponse(req, res, 400, "Validation Error", msg);
    handleError(req, res, error);
  }
});

app.post("/charge-saved", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to book a private lesson.");
    }

    const { instructorId, studioId, date, timeSlot, paymentMethodId, notes, dependentId } = req.body as Record<string, unknown>;
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
    const profileData = profileDoc ? (profileDoc.data() as Record<string, unknown>) : null;
    let stripeCustomerId: string | null = (profileData?.["stripeCustomerId"] as string) || null;
    let studentDocRef: FirebaseFirestore.DocumentReference | null =
      profileDoc ? db.collection("usersStudentProfiles").doc(profileDoc.id) : null;
    let studentConnectedCustomers: Record<string, string> =
      (profileData?.["stripeConnectedCustomers"] as Record<string, string>) || {};
    const studentEmail: string = (profileData?.["email"] as string) || user.email || "";

    if (!stripeCustomerId) {
      const userQuery = await db.collection("users").where("authUid", "==", user.uid).limit(1).get();
      if (!userQuery.empty) {
        const firstDoc = userQuery.docs[0];
        if (firstDoc) {
          const userData = firstDoc.data() as Record<string, unknown>;
          stripeCustomerId = (userData["stripeCustomerId"] as string) || null;
          studentDocRef = studentDocRef ?? db.collection("users").doc(firstDoc.id);
          studentConnectedCustomers =
            (userData["stripeConnectedCustomers"] as Record<string, string>) || {};
        }
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

    if (!connectedAccountId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "This studio has not completed Stripe setup.");
    }

    const amountCents = Math.round((instructor["privateRate"] as number) * 100);
    const studentId = await bookingsService.getStudentId(user.uid);

    // Find or create the student as a customer on the studio's connected Stripe account
    const existingConnectedCustomerId = studentConnectedCustomers[connectedAccountId] ?? null;
    const { customer: connectedCustomer, isNew } = await stripeService.findOrCreateConnectedCustomer(
      studentEmail,
      stripeCustomerId,
      connectedAccountId,
      undefined,
      existingConnectedCustomerId,
    );
    const connectedCustomerId = connectedCustomer.id;
    if ((isNew || !existingConnectedCustomerId) && studentDocRef) {
      await studentDocRef.update({
        [`stripeConnectedCustomers.${connectedAccountId}`]: connectedCustomerId,
      });
    }

    // Find the cloned PM on the connected account (by fingerprint) or clone it now
    let connectedPm = await stripeService.findConnectedPaymentMethod(
      paymentMethodId as string,
      connectedCustomerId,
      connectedAccountId,
    );
    if (!connectedPm) {
      connectedPm = await stripeService.clonePaymentMethodToConnectedAccount(
        paymentMethodId as string,
        stripeCustomerId,
        connectedCustomerId,
        connectedAccountId,
      );
    }

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

    // Direct charge on the studio's connected account — consistent with package and
    // subscription charges so all revenue appears in the studio's Stripe dashboard.
    const paymentIntent = await stripeService.chargePaymentMethodDirectly(
      connectedCustomerId,
      connectedPm.id,
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

    const booking = await bookingsService.createBookingRecord({
      studentId,
      authUid: user.uid,
      instructorId: instructorId as string,
      studioId: studioId as string,
      date: date as string,
      timeSlot: { startTime: ts["startTime"] as string, endTime: ts["endTime"] as string },
      notes: (notes as string) || null,
      amountPaid: instructor["privateRate"] as number,
      stripePaymentIntentId: piData["id"] as string,
      stripeConnectedAccountId: connectedAccountId,
      dependentId: typeof dependentId === "string" ? dependentId : null,
    });

    const recipientEmail = profileDoc ? ((profileDoc.data() as Record<string, unknown>)["email"] as string) : user.email;
    await notifyPrivateLessonBookingCreated({
      bookingId: booking.id,
      instructorId: instructorId as string,
      studioId: studioId as string,
      studioName,
      instructorName,
      date: date as string,
      timeSlot: { startTime: ts["startTime"] as string, endTime: ts["endTime"] as string },
      amountPaid: instructor["privateRate"] as number,
      authUid: user.uid,
      studentEmail: recipientEmail,
    });

    sendJsonResponse(req, res, 200, {
      success: true,
      bookingId: booking.id,
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
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

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

    // This endpoint is legitimately called by ANY authenticated user browsing an
    // instructor's public availability while booking a private lesson — it must stay
    // open for that. What was actually missing was redaction: it was handing back other
    // students' studentId/notes/contactInfo to anyone. Only the linked instructor
    // themself (or the studio that owns them) gets the unredacted view; everyone else
    // gets just enough to know a slot is taken.
    const links = await instructorLinkingService.getInstructorLinksForAuthUid(user.uid);
    const isThisInstructor = Object.values(links).some((link) => link.instructorId === instructorId);
    const isOwningStudio = !isThisInstructor && await (async () => {
      const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
      if (!userDoc) return false;
      const instructorData = await instructorsService.getInstructorById(instructorId, userDoc.id).catch(() => null);
      return !!instructorData;
    })();

    const response = (isThisInstructor || isOwningStudio)
      ? bookings
      : bookings.map((b) => ({ id: b["id"], date: b["date"], timeSlot: b["timeSlot"], status: b["status"] }));

    sendJsonResponse(req, res, 200, response);
  } catch (error) {
    console.error("Error getting instructor bookings:", error);
    handleError(req, res, error);
  }
});

app.get("/studio", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const status = req.query["status"] as string | undefined;
    const bookings = await bookingsService.getBookingsByStudio(userDoc.id, status);
    sendJsonResponse(req, res, 200, bookings);
  } catch (error) {
    console.error("Error listing studio bookings:", error);
    handleError(req, res, error);
  }
});

app.patch("/studio/:bookingId/cancel", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await bookingsService.cancelBookingAsStudio(req.params["bookingId"] as string, userDoc.id);
    const booking = await bookingsService.getBookingByIdForStudio(req.params["bookingId"] as string, userDoc.id);
    sendJsonResponse(req, res, 200, booking);
  } catch (error) {
    console.error("Error cancelling booking as studio:", error);
    const msg = (error as Error).message;
    if (msg === "Booking not found") return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied") || msg?.includes("already cancelled")) {
      return sendErrorResponse(req, res, 400, "Bad Request", msg);
    }
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

    // Either the studio owner or the assigned instructor themself can confirm —
    // resolve whichever identity this caller actually has.
    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    const instructorLink = userDoc
      ? null
      : await instructorLinkingService.resolveLink(user.uid, req.query["studioOwnerId"] as string | undefined);
    if (!userDoc && !instructorLink) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner or linked instructor access required");
    }
    const bookingId = req.params["bookingId"] as string;

    const rawStudioMessage = (req.body as Record<string, unknown> | undefined)?.["message"];
    const studioMessage = typeof rawStudioMessage === "string" ? rawStudioMessage.trim().slice(0, 500) || undefined : undefined;
    const booking = await bookingsService.confirmBooking(bookingId, userDoc
      ? { studioOwnerId: userDoc.id }
      : { instructorId: instructorLink!.instructorId });
    const studioOwnerId = (booking["studioId"] as string) ?? userDoc?.id ?? instructorLink?.studioOwnerId;

    const db = getFirestore();

    try {
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
    } catch (err) { console.error("Error marking studio notification as read:", err); }

    try {
      const bookingData = booking as Record<string, unknown>;
      const studentAuthUid = bookingData["authUid"] as string | undefined;
      if (studentAuthUid) {
        const bookingDate = bookingData["date"] as string | undefined;
        const bookingTs = bookingData["timeSlot"] as Record<string, unknown> | undefined;
        const timeLabel = bookingTs ? `${bookingTs["startTime"] as string} – ${bookingTs["endTime"] as string}` : "";
        const pushTitle = "Private Lesson Confirmed!";
        const defaultBody = `Your lesson${bookingDate ? ` on ${bookingDate}` : ""}${timeLabel ? ` at ${timeLabel}` : ""} has been confirmed.`;
        const pushBody = studioMessage ?? defaultBody;
        await db.collection("studentNotifications").add({
          authUid: studentAuthUid,
          type: "booking_confirmed",
          title: pushTitle,
          body: pushBody,
          bookingId,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        try {
          await sendStudentPush(studentAuthUid, pushTitle, pushBody);
        } catch (pushErr) { console.error("[confirm booking] Push notification error:", pushErr); }

        // Send confirmation email to student
        try {
          const studentProfileSnap = await db.collection("usersStudentProfiles")
            .where("authUid", "==", studentAuthUid)
            .limit(1)
            .get();
          const rawStudentEmail = studentProfileSnap.empty
            ? undefined
            : (studentProfileSnap.docs[0]!.data() as Record<string, unknown>)["email"];
          const studentEmail = typeof rawStudentEmail === "string" ? rawStudentEmail.trim() : "";

          if (studentEmail) {
            const instructorId = bookingData["instructorId"] as string | undefined;
            const instructorDoc = instructorId ? await db.collection("instructors").doc(instructorId).get() : null;
            const instructorData = instructorDoc?.exists ? instructorDoc.data() as Record<string, unknown> : null;
            const instructorName = instructorData
              ? `${instructorData["firstName"] ?? ""} ${instructorData["lastName"] ?? ""}`.trim()
              : "Your Instructor";

            const studioDoc = await db.collection("users").doc(studioOwnerId).get();
            const studioName = studioDoc.exists
              ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string ?? "The Studio")
              : "The Studio";

            await sendgridService.sendConfirmationEmail(studentEmail, "private_lesson_confirmed", {
              instructorName,
              studioName,
              date: bookingDate ?? "",
              timeSlot: timeLabel,
              studioMessage,
            });
          }
        } catch (emailErr) { console.error("[confirm booking] Confirmation email error:", emailErr); }
      }
    } catch (err) { console.error("Error notifying student of booking confirmation:", err); }

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
