const admin = require("firebase-admin");
const authService = require("./auth.service");
const stripeService = require("./stripe.service");
const instructorsService = require("./instructors.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling private lesson booking operations
 */
class BookingsService {
  /**
   * Get student ID from Firebase Auth UID
   * First checks usersStudentProfiles (users-app), then students collection (studio-owners-app)
   * If neither exists, returns the authUid itself to allow any authenticated user to book
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string>} Student document ID or authUid
   */
  async getStudentId(authUid) {
    const db = getFirestore();
    
    // First check usersStudentProfiles collection (users-app)
    const usersStudentProfilesRef = db.collection("usersStudentProfiles");
    const usersSnapshot = await usersStudentProfilesRef
        .where("authUid", "==", authUid)
        .limit(1)
        .get();

    if (!usersSnapshot.empty) {
      return usersSnapshot.docs[0].id;
    }

    // Then check students collection (studio-owners-app)
    const studentsRef = db.collection("students");
    const studentsSnapshot = await studentsRef
        .where("authUid", "==", authUid)
        .limit(1)
        .get();

    if (!studentsSnapshot.empty) {
      return studentsSnapshot.docs[0].id;
    }

    // If no profile exists, use authUid directly to allow any authenticated user to book
    return authUid;
  }

  /**
   * Create a new booking
   * @param {Object} bookingData - Booking data
   * @param {string} studentId - Student document ID
   * @returns {Promise<string>} Created booking document ID
   */
  async createBooking(bookingData, studentId) {
    const db = getFirestore();

    // Check if time slot is already booked
    const isAvailable = await this.isTimeSlotAvailable(
        bookingData.instructorId,
        bookingData.date,
        bookingData.timeSlot,
    );

    if (!isAvailable) {
      throw new Error("Time slot is already booked");
    }

    // Use transaction to ensure atomicity
    return await db.runTransaction(async (transaction) => {
      // Double-check availability within transaction
      const bookingsRef = db.collection("privateLessonBookings");
      const existingBookings = await transaction.get(
          bookingsRef
              .where("instructorId", "==", bookingData.instructorId)
              .where("date", "==", bookingData.date)
              .where("timeSlot.startTime", "==", bookingData.timeSlot.startTime)
              .where("status", "in", ["pending", "confirmed"]),
      );

      if (!existingBookings.empty) {
        throw new Error("Time slot is already booked");
      }

      // Create booking
      const bookingDataWithMetadata = {
        studentId,
        instructorId: bookingData.instructorId,
        studioId: bookingData.studioId,
        date: bookingData.date,
        timeSlot: bookingData.timeSlot,
        status: "pending",
        notes: bookingData.notes || null,
        contactInfo: bookingData.contactInfo || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const docRef = bookingsRef.doc();
      transaction.set(docRef, bookingDataWithMetadata);

      return docRef.id;
    });
  }

  /**
   * Get bookings for an instructor within a date range
   * @param {string} instructorId - Instructor document ID
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Promise<Array>} Array of bookings
   */
  async getBookingsByInstructor(instructorId, startDate, endDate) {
    const db = getFirestore();
    const bookingsRef = db.collection("privateLessonBookings");

    const snapshot = await bookingsRef
        .where("instructorId", "==", instructorId)
        .where("date", ">=", startDate)
        .where("date", "<=", endDate)
        .where("status", "in", ["pending", "confirmed"])
        .orderBy("date")
        .orderBy("timeSlot.startTime")
        .get();

    const bookings = [];
    snapshot.forEach((doc) => {
      bookings.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return bookings;
  }

  /**
   * Get a single booking by ID
   * @param {string} bookingId - Booking document ID
   * @returns {Promise<Object | null>} Booking data or null if not found
   */
  async getBookingById(bookingId) {
    const db = getFirestore();
    const bookingRef = db.collection("privateLessonBookings").doc(bookingId);
    const doc = await bookingRef.get();

    if (!doc.exists) {
      return null;
    }

    return {
      id: doc.id,
      ...doc.data(),
    };
  }


  /**
   * Check if a time slot is available
   * @param {string} instructorId - Instructor document ID
   * @param {string} date - Date (YYYY-MM-DD)
   * @param {Object} timeSlot - Time slot object with startTime and endTime
   * @returns {Promise<boolean>} True if available, false if booked
   */
  async isTimeSlotAvailable(instructorId, date, timeSlot) {
    const db = getFirestore();
    const bookingsRef = db.collection("privateLessonBookings");

    const snapshot = await bookingsRef
        .where("instructorId", "==", instructorId)
        .where("date", "==", date)
        .where("timeSlot.startTime", "==", timeSlot.startTime)
        .where("status", "in", ["pending", "confirmed"])
        .limit(1)
        .get();

    return snapshot.empty;
  }

  /**
   * Get bookings for a student
   * @param {string} studentId - Student document ID or authUid
   * @returns {Promise<Array>} Array of bookings
   */
  async getBookingsByStudent(studentId) {
    const db = getFirestore();
    const bookingsRef = db.collection("privateLessonBookings");

    const snapshot = await bookingsRef
        .where("studentId", "==", studentId)
        .orderBy("date", "desc")
        .orderBy("timeSlot.startTime", "desc")
        .get();

    const bookings = [];
    snapshot.forEach((doc) => {
      bookings.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return bookings;
  }

  /**
   * Cancel a booking - updated to handle authUid as studentId
   * @param {string} bookingId - Booking document ID
   * @param {string} studentId - Student document ID or authUid (for verification)
   * @returns {Promise<void>}
   */
  async cancelBooking(bookingId, studentId) {
    const db = getFirestore();
    const bookingRef = db.collection("privateLessonBookings").doc(bookingId);
    const doc = await bookingRef.get();

    if (!doc.exists) {
      throw new Error("Booking not found");
    }

    const bookingData = doc.data();
    if (bookingData.studentId !== studentId) {
      throw new Error("Access denied: You can only cancel your own bookings");
    }

    if (bookingData.status === "cancelled") {
      throw new Error("Booking is already cancelled");
    }

    await bookingRef.update({
      status: "cancelled",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Confirm a booking (studio owner only)
   * @param {string} bookingId - Booking document ID
   * @param {string} studioOwnerId - Studio owner document ID (for verification)
   * @returns {Promise<Object>} Updated booking data
   */
  async confirmBooking(bookingId, studioOwnerId) {
    const db = getFirestore();
    const bookingRef = db.collection("privateLessonBookings").doc(bookingId);
    const doc = await bookingRef.get();

    if (!doc.exists) {
      throw new Error("Booking not found");
    }

    const bookingData = doc.data();
    
    // Verify booking belongs to studio
    if (bookingData.studioId !== studioOwnerId) {
      throw new Error("Access denied: Booking does not belong to this studio");
    }

    if (bookingData.status === "confirmed") {
      throw new Error("Booking is already confirmed");
    }

    if (bookingData.status === "cancelled") {
      throw new Error("Cannot confirm a cancelled booking");
    }

    // Update booking status
    await bookingRef.update({
      status: "confirmed",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Return updated booking
    const updatedDoc = await bookingRef.get();
    return {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };
  }

  /**
   * Get booking by ID with student and instructor info (for studio owners)
   * @param {string} bookingId - Booking document ID
   * @param {string} studioOwnerId - Studio owner document ID (for verification)
   * @returns {Promise<Object | null>} Booking data with student/instructor info or null if not found
   */
  async getBookingByIdForStudio(bookingId, studioOwnerId) {
    const db = getFirestore();
    const bookingRef = db.collection("privateLessonBookings").doc(bookingId);
    const doc = await bookingRef.get();

    if (!doc.exists) {
      return null;
    }

    const bookingData = doc.data();
    
    // Verify booking belongs to studio
    if (bookingData.studioId !== studioOwnerId) {
      throw new Error("Access denied: Booking does not belong to this studio");
    }

    // Get student information
    let studentInfo = null;
    if (bookingData.studentId) {
      // Try usersStudentProfiles first
      const usersStudentProfilesRef = db.collection("usersStudentProfiles");
      const usersDoc = await usersStudentProfilesRef.doc(bookingData.studentId).get();

      if (usersDoc.exists) {
        const studentData = usersDoc.data();
        studentInfo = {
          id: usersDoc.id,
          firstName: studentData.firstName || "",
          lastName: studentData.lastName || "",
          email: studentData.email || null,
          phone: studentData.phone || null,
        };
      } else {
        // Try students collection
        const studentsRef = db.collection("students");
        const studentsDoc = await studentsRef.doc(bookingData.studentId).get();

        if (studentsDoc.exists) {
          const studentData = studentsDoc.data();
          studentInfo = {
            id: studentsDoc.id,
            firstName: studentData.firstName || "",
            lastName: studentData.lastName || "",
            email: studentData.email || null,
            phone: studentData.phone || null,
          };
        }
      }
    }

    // Get instructor information
    let instructorInfo = null;
    if (bookingData.instructorId) {
      const instructorsService = require("./instructors.service");
      try {
        instructorInfo = await instructorsService.getInstructorById(
            bookingData.instructorId,
            studioOwnerId,
        );
      } catch (error) {
        console.error("Error fetching instructor:", error);
        // Continue without instructor info
      }
    }

    return {
      id: doc.id,
      ...bookingData,
      student: studentInfo,
      instructor: instructorInfo,
    };
  }

  /**
   * Create a Stripe Checkout Session for a private lesson.
   * Validates the time slot is still available before creating the session.
   * The booking itself is created later by the Stripe webhook on payment success.
   * @param {Object} bookingData - { instructorId, studioId, date, timeSlot, notes, contactInfo }
   * @param {Object} user - Firebase Auth user object { uid, email }
   * @param {string} studentId - Student document ID
   * @param {string} successUrl - Redirect URL (must include {CHECKOUT_SESSION_ID} placeholder)
   * @param {string} cancelUrl - Redirect URL on cancellation
   * @returns {Promise<{ checkoutUrl: string, sessionId: string }>}
   */
  async createPrivateLessonCheckout(bookingData, user, studentId, successUrl, cancelUrl) {
    // Confirm slot is still free
    const isAvailable = await this.isTimeSlotAvailable(
        bookingData.instructorId,
        bookingData.date,
        bookingData.timeSlot,
    );
    if (!isAvailable) {
      throw new Error("This time slot is no longer available");
    }

    // Fetch instructor to get rate and studioOwnerId
    const instructor = await instructorsService.getPublicInstructorById(bookingData.instructorId);
    if (!instructor) {
      throw new Error("Instructor not found");
    }

    const privateRate = instructor.privateRate;
    if (!privateRate || privateRate <= 0) {
      throw new Error("This instructor does not have a private lesson rate set");
    }

    // Look up studio owner's Stripe Connect account (if configured)
    const db = getFirestore();
    const studioOwnerRef = db.collection("users").doc(bookingData.studioId);
    const studioOwnerDoc = await studioOwnerRef.get();
    const studioOwnerData = studioOwnerDoc.exists ? studioOwnerDoc.data() : {};
    const connectedAccountId = studioOwnerData.stripeAccountId || null;
    const studioName = studioOwnerData.studioName || "Studio";

    const instructorName = [instructor.firstName, instructor.lastName].filter(Boolean).join(" ");
    const amountCents = Math.round(privateRate * 100);

    const metadata = {
      purchaseType: "private_lesson",
      instructorId: bookingData.instructorId,
      instructorName,
      studioId: bookingData.studioId,
      studioName,
      date: bookingData.date,
      timeSlotStart: bookingData.timeSlot.startTime,
      timeSlotEnd: bookingData.timeSlot.endTime,
      notes: bookingData.notes || "",
      studentId,
      authUid: user.uid,
      amountPaid: String(privateRate),
    };

    if (bookingData.contactInfo?.email) metadata.contactEmail = bookingData.contactInfo.email;
    if (bookingData.contactInfo?.phone) metadata.contactPhone = bookingData.contactInfo.phone;

    // Build full success URL with all booking details so the confirmation page can display them
    const timeLabel = encodeURIComponent(`${bookingData.timeSlot.startTime} - ${bookingData.timeSlot.endTime}`);
    const fullSuccessUrl = `${successUrl}?session_id={CHECKOUT_SESSION_ID}` +
      `&studioId=${encodeURIComponent(bookingData.studioId)}` +
      `&instructorId=${encodeURIComponent(bookingData.instructorId)}` +
      `&bookingDate=${encodeURIComponent(bookingData.date)}` +
      `&bookingTime=${timeLabel}` +
      `&instructorName=${encodeURIComponent(instructorName)}` +
      `&studioName=${encodeURIComponent(studioName)}`;

    const session = await stripeService.createPrivateLessonCheckoutSession({
      amountCents,
      instructorName,
      customerEmail: user.email || undefined,
      connectedAccountId,
      metadata,
      successUrl: fullSuccessUrl,
      cancelUrl,
    });

    return {checkoutUrl: session.url, sessionId: session.id};
  }

  /**
   * Create a confirmed booking from a completed Stripe Checkout Session.
   * Called by the Stripe webhook handler after checkout.session.completed.
   * @param {Object} session - Stripe Checkout Session object (already verified)
   * @returns {Promise<string>} Created booking document ID
   */
  async createConfirmedBookingFromSession(session) {
    const meta = session.metadata || {};
    if (meta.purchaseType !== "private_lesson") {
      throw new Error("Session is not a private_lesson purchase");
    }

    const db = getFirestore();
    const bookingsRef = db.collection("privateLessonBookings");

    // Idempotency: skip if a booking for this session already exists
    const existing = await bookingsRef
        .where("stripeSessionId", "==", session.id)
        .limit(1)
        .get();
    if (!existing.empty) {
      return existing.docs[0].id;
    }

    const bookingDoc = {
      studentId: meta.studentId || "guest",
      authUid: meta.authUid || "guest",
      instructorId: meta.instructorId,
      studioId: meta.studioId,
      date: meta.date,
      timeSlot: {startTime: meta.timeSlotStart, endTime: meta.timeSlotEnd},
      status: "confirmed",
      paymentStatus: "paid",
      stripeSessionId: session.id,
      notes: meta.notes || null,
      contactInfo: {
        email: meta.contactEmail || session.customer_details?.email || null,
        phone: meta.contactPhone || null,
      },
      amountPaid: parseFloat(meta.amountPaid) || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await bookingsRef.add(bookingDoc);
    return docRef.id;
  }
}

module.exports = new BookingsService();
