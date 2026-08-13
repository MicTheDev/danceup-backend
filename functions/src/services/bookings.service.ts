import * as admin from "firebase-admin";
import * as stripeService from "./stripe.service";
import instructorsService from "./instructors.service";
import { getFirestore } from "../utils/firestore";

interface TimeSlot {
  startTime: string;
  endTime: string;
}

interface BookingData {
  instructorId: string;
  studioId: string;
  date: string;
  timeSlot: TimeSlot;
  notes?: string | null;
  contactInfo?: { email?: string; phone?: string } | null;
}

interface StudentInfo {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

export class BookingsService {
  async getStudentId(authUid: string): Promise<string> {
    const db = getFirestore();

    const usersSnapshot = await db.collection("usersStudentProfiles")
      .where("authUid", "==", authUid)
      .limit(1)
      .get();
    if (!usersSnapshot.empty) {
      const firstDoc = usersSnapshot.docs[0];
      if (firstDoc) return firstDoc.id;
    }

    const studentsSnapshot = await db.collection("students")
      .where("authUid", "==", authUid)
      .limit(1)
      .get();
    if (!studentsSnapshot.empty) {
      const firstDoc = studentsSnapshot.docs[0];
      if (firstDoc) return firstDoc.id;
    }

    return authUid;
  }

  async createBooking(bookingData: BookingData, studentId: string): Promise<string> {
    const db = getFirestore();

    const isAvailable = await this.isTimeSlotAvailable(
      bookingData.instructorId,
      bookingData.date,
      bookingData.timeSlot,
    );
    if (!isAvailable) throw new Error("Time slot is already booked");

    return await db.runTransaction(async (transaction) => {
      const bookingsRef = db.collection("privateLessonBookings");
      const existingBookings = await transaction.get(
        bookingsRef
          .where("instructorId", "==", bookingData.instructorId)
          .where("date", "==", bookingData.date)
          .where("timeSlot.startTime", "==", bookingData.timeSlot.startTime)
          .where("status", "in", ["pending", "confirmed"]),
      );
      if (!existingBookings.empty) throw new Error("Time slot is already booked");

      const docRef = bookingsRef.doc();
      transaction.set(docRef, {
        studentId,
        instructorId: bookingData.instructorId,
        studioId: bookingData.studioId,
        date: bookingData.date,
        timeSlot: bookingData.timeSlot,
        status: "pending",
        notes: bookingData.notes ?? null,
        contactInfo: bookingData.contactInfo ?? null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return docRef.id;
    });
  }

  async getBookingsByInstructor(
    instructorId: string, startDate: string, endDate: string,
  ): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const snapshot = await db.collection("privateLessonBookings")
      .where("instructorId", "==", instructorId)
      .where("date", ">=", startDate)
      .where("date", "<=", endDate)
      .where("status", "in", ["pending", "confirmed"])
      .orderBy("date")
      .orderBy("timeSlot.startTime")
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
  }

  async getBookingById(bookingId: string): Promise<(Record<string, unknown> & { id: string }) | null> {
    const db = getFirestore();
    const doc = await db.collection("privateLessonBookings").doc(bookingId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...(doc.data() as Record<string, unknown>) };
  }

  async isTimeSlotAvailable(instructorId: string, date: string, timeSlot: TimeSlot): Promise<boolean> {
    const db = getFirestore();
    const snapshot = await db.collection("privateLessonBookings")
      .where("instructorId", "==", instructorId)
      .where("date", "==", date)
      .where("timeSlot.startTime", "==", timeSlot.startTime)
      .where("status", "in", ["pending", "confirmed"])
      .limit(1)
      .get();
    return snapshot.empty;
  }

  async getBookingsByStudent(studentId: string): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const snapshot = await db.collection("privateLessonBookings")
      .where("studentId", "==", studentId)
      .orderBy("date", "desc")
      .orderBy("timeSlot.startTime", "desc")
      .get();

    return await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data() as Record<string, unknown>;
      let instructorName: string | null = null;
      if (data["instructorId"]) {
        try {
          const instructor = await instructorsService.getPublicInstructorById(data["instructorId"] as string);
          if (instructor) {
            instructorName = [instructor.firstName, instructor.lastName].filter(Boolean).join(" ") || null;
          }
        } catch (_) { /* instructor may have been removed */ }
      }
      return { id: doc.id, ...data, instructorName };
    }));
  }

  async cancelBooking(bookingId: string, studentId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("privateLessonBookings").doc(bookingId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Booking not found");
    const bookingData = doc.data() as Record<string, unknown>;
    if (bookingData["studentId"] !== studentId) {
      throw new Error("Access denied: You can only cancel your own bookings");
    }
    if (bookingData["status"] === "cancelled") throw new Error("Booking is already cancelled");
    await ref.update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  /**
   * Confirms a booking on behalf of either the studio owner (via studioOwnerId)
   * or the assigned instructor themself (via instructorId) — same booking,
   * same status transition, two different people allowed to trigger it, kept
   * in sync since it's the one Firestore doc either caller is updating.
   */
  async confirmBooking(
    bookingId: string, caller: { studioOwnerId?: string; instructorId?: string },
  ): Promise<Record<string, unknown> & { id: string }> {
    const db = getFirestore();
    const ref = db.collection("privateLessonBookings").doc(bookingId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Booking not found");
    const bookingData = doc.data() as Record<string, unknown>;

    const isStudioOwner = caller.studioOwnerId && bookingData["studioId"] === caller.studioOwnerId;
    const isAssignedInstructor = caller.instructorId && bookingData["instructorId"] === caller.instructorId;
    if (!isStudioOwner && !isAssignedInstructor) {
      throw new Error("Access denied: Booking does not belong to this studio");
    }
    if (bookingData["status"] === "confirmed") throw new Error("Booking is already confirmed");
    if (bookingData["status"] === "cancelled") throw new Error("Cannot confirm a cancelled booking");
    await ref.update({ status: "confirmed", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    const updatedDoc = await ref.get();
    return { id: updatedDoc.id, ...(updatedDoc.data() as Record<string, unknown>) };
  }

  async cancelBookingAsStudio(bookingId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("privateLessonBookings").doc(bookingId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Booking not found");
    const bookingData = doc.data() as Record<string, unknown>;
    if (bookingData["studioId"] !== studioOwnerId) {
      throw new Error("Access denied: Booking does not belong to this studio");
    }
    if (bookingData["status"] === "cancelled") throw new Error("Booking is already cancelled");

    // Issue refund if the student already paid
    const paymentIntentId = bookingData["stripePaymentIntentId"] as string | undefined;
    if (paymentIntentId && bookingData["paymentStatus"] === "paid") {
      const stripeService = await import("./stripe.service");
      // Direct-charge bookings store stripeConnectedAccountId; destination-charge
      // (legacy) bookings do not — omitting the account ID refunds on the platform.
      const connectedAccountId = bookingData["stripeConnectedAccountId"] as string | undefined;
      try {
        await stripeService.createRefund(paymentIntentId, "Studio cancelled the booking", connectedAccountId);
      } catch (refundErr) {
        console.error("[cancelBookingAsStudio] Refund failed:", refundErr);
        // Don't block the cancellation if refund fails — log and continue
      }
    }

    await ref.update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  async getBookingsByStudio(
    studioOwnerId: string, status?: string,
  ): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    let query = db.collection("privateLessonBookings")
      .where("studioId", "==", studioOwnerId)
      .orderBy("date", "desc") as FirebaseFirestore.Query;
    if (status) {
      query = query.where("status", "==", status);
    }
    const snapshot = await query.get();

    const bookings = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data() as Record<string, unknown>;

      let studentInfo: StudentInfo | null = null;
      if (data["studentId"]) {
        const sid = data["studentId"] as string;
        const usersDoc = await db.collection("usersStudentProfiles").doc(sid).get();
        if (usersDoc.exists) {
          const sd = usersDoc.data() as Record<string, unknown>;
          studentInfo = {
            id: usersDoc.id,
            firstName: (sd["firstName"] as string) || "",
            lastName: (sd["lastName"] as string) || "",
            email: (sd["email"] as string | null) ?? null,
            phone: (sd["phone"] as string | null) ?? null,
          };
        } else {
          const studentsDoc = await db.collection("students").doc(sid).get();
          if (studentsDoc.exists) {
            const sd = studentsDoc.data() as Record<string, unknown>;
            studentInfo = {
              id: studentsDoc.id,
              firstName: (sd["firstName"] as string) || "",
              lastName: (sd["lastName"] as string) || "",
              email: (sd["email"] as string | null) ?? null,
              phone: (sd["phone"] as string | null) ?? null,
            };
          }
        }
      }

      let instructorInfo: Record<string, unknown> | null = null;
      if (data["instructorId"]) {
        try {
          instructorInfo = await instructorsService.getInstructorById(
            data["instructorId"] as string, studioOwnerId,
          );
        } catch (_) { /* instructor may have been removed */ }
      }

      return { id: doc.id, ...data, student: studentInfo, instructor: instructorInfo };
    }));

    return bookings;
  }

  async getBookingByIdForStudio(
    bookingId: string, studioOwnerId: string,
  ): Promise<Record<string, unknown> | null> {
    const db = getFirestore();
    const doc = await db.collection("privateLessonBookings").doc(bookingId).get();
    if (!doc.exists) return null;
    const bookingData = doc.data() as Record<string, unknown>;
    if (bookingData["studioId"] !== studioOwnerId) {
      throw new Error("Access denied: Booking does not belong to this studio");
    }

    let studentInfo: StudentInfo | null = null;
    if (bookingData["studentId"]) {
      const studentId = bookingData["studentId"] as string;
      const usersDoc = await db.collection("usersStudentProfiles").doc(studentId).get();
      if (usersDoc.exists) {
        const sd = usersDoc.data() as Record<string, unknown>;
        studentInfo = {
          id: usersDoc.id,
          firstName: (sd["firstName"] as string) || "",
          lastName: (sd["lastName"] as string) || "",
          email: (sd["email"] as string | null) ?? null,
          phone: (sd["phone"] as string | null) ?? null,
        };
      } else {
        const studentsDoc = await db.collection("students").doc(studentId).get();
        if (studentsDoc.exists) {
          const sd = studentsDoc.data() as Record<string, unknown>;
          studentInfo = {
            id: studentsDoc.id,
            firstName: (sd["firstName"] as string) || "",
            lastName: (sd["lastName"] as string) || "",
            email: (sd["email"] as string | null) ?? null,
            phone: (sd["phone"] as string | null) ?? null,
          };
        }
      }
    }

    let instructorInfo: Record<string, unknown> | null = null;
    if (bookingData["instructorId"]) {
      try {
        instructorInfo = await instructorsService.getInstructorById(
          bookingData["instructorId"] as string,
          studioOwnerId,
        );
      } catch (error) {
        console.error("Error fetching instructor:", error);
      }
    }

    return { id: doc.id, ...bookingData, student: studentInfo, instructor: instructorInfo };
  }

  /**
   * Creates a PaymentIntent directly on the studio's connected account for a new
   * (non-saved) card — the self-hosted Payment Element flow, consistent with how
   * packages/events/classes take payment. Replaces the old hosted Stripe Checkout
   * redirect, whose fulfillment depended on a webhook that connected-account direct
   * charges never reliably delivered.
   */
  async createPrivateLessonPaymentIntent(
    bookingData: BookingData,
    user: { uid: string; email?: string | null },
    studentId: string,
  ): Promise<{ clientSecret: string; paymentIntentId: string; connectedAccountId: string }> {
    const isAvailable = await this.isTimeSlotAvailable(
      bookingData.instructorId,
      bookingData.date,
      bookingData.timeSlot,
    );
    if (!isAvailable) throw new Error("This time slot is no longer available");

    const instructor = await instructorsService.getPublicInstructorById(bookingData.instructorId);
    if (!instructor) throw new Error("Instructor not found");

    const privateRate = instructor.privateRate;
    if (!privateRate || privateRate <= 0) {
      throw new Error("This instructor does not have a private lesson rate set");
    }

    const db = getFirestore();
    const studioOwnerDoc = await db.collection("users").doc(bookingData.studioId).get();
    const studioOwnerData = studioOwnerDoc.exists ? (studioOwnerDoc.data() as Record<string, unknown>) : {};
    const connectedAccountId = (studioOwnerData["stripeAccountId"] as string | null) ?? null;
    if (!connectedAccountId) throw new Error("This studio has not completed Stripe setup.");

    const instructorName = [instructor.firstName, instructor.lastName].filter(Boolean).join(" ");
    const amountCents = Math.round(privateRate * 100);
    const applicationFeeAmount = stripeService.platformFeeCents(amountCents);

    const metadata: Record<string, string> = {
      purchaseType: "private_lesson",
      instructorId: bookingData.instructorId,
      instructorName,
      studioId: bookingData.studioId,
      date: bookingData.date,
      timeSlotStart: bookingData.timeSlot.startTime,
      timeSlotEnd: bookingData.timeSlot.endTime,
      notes: bookingData.notes || "",
      studentId,
      authUid: user.uid,
      amountPaid: String(privateRate),
    };
    if (bookingData.contactInfo?.email) metadata["contactEmail"] = bookingData.contactInfo.email;
    if (bookingData.contactInfo?.phone) metadata["contactPhone"] = bookingData.contactInfo.phone;

    const paymentIntent = await stripeService.createDirectPaymentIntent(
      amountCents,
      connectedAccountId,
      applicationFeeAmount,
      metadata,
    );

    // Server-side record of which connected account this PaymentIntent lives on, so
    // /confirm-payment never has to trust a client-supplied connectedAccountId.
    await db.collection("pendingPrivateLessonPaymentIntents").doc(paymentIntent.id).set({
      connectedAccountId,
      authUid: user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      clientSecret: paymentIntent.client_secret as string,
      paymentIntentId: paymentIntent.id,
      connectedAccountId,
    };
  }

  /**
   * Creates the paid booking doc, or returns the existing one if this
   * stripePaymentIntentId has already been recorded — the single source of truth
   * both the saved-card charge and the confirm-payment flow write through, so they
   * can't drift out of sync with each other again.
   */
  async createBookingRecord(params: {
    studentId: string;
    authUid: string;
    instructorId: string;
    studioId: string;
    date: string;
    timeSlot: TimeSlot;
    notes?: string | null;
    contactInfo?: { email?: string | null; phone?: string | null } | null;
    amountPaid: number;
    stripePaymentIntentId: string;
    stripeConnectedAccountId: string | null;
  }): Promise<Record<string, unknown> & { id: string }> {
    const db = getFirestore();

    const existing = await db.collection("privateLessonBookings")
      .where("stripePaymentIntentId", "==", params.stripePaymentIntentId)
      .limit(1)
      .get();
    if (!existing.empty) {
      const doc = existing.docs[0]!;
      return { id: doc.id, ...doc.data() };
    }

    const bookingDoc = {
      studentId: params.studentId,
      authUid: params.authUid,
      instructorId: params.instructorId,
      studioId: params.studioId,
      date: params.date,
      timeSlot: params.timeSlot,
      status: "pending",
      paymentStatus: "paid",
      stripePaymentIntentId: params.stripePaymentIntentId,
      stripeConnectedAccountId: params.stripeConnectedAccountId,
      notes: params.notes || null,
      contactInfo: params.contactInfo || null,
      amountPaid: params.amountPaid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const bookingRef = await db.collection("privateLessonBookings").add(bookingDoc);
    return { id: bookingRef.id, ...bookingDoc };
  }

  /**
   * Verifies a PaymentIntent succeeded and creates the booking doc from its
   * (server-set, tamper-proof) metadata.
   */
  async confirmPrivateLessonPayment(
    paymentIntentId: string,
    authUid: string,
  ): Promise<Record<string, unknown> & { id: string }> {
    const db = getFirestore();

    const existing = await db.collection("privateLessonBookings")
      .where("stripePaymentIntentId", "==", paymentIntentId)
      .limit(1)
      .get();
    if (!existing.empty) {
      const doc = existing.docs[0]!;
      return { id: doc.id, ...doc.data() };
    }

    const pendingDoc = await db.collection("pendingPrivateLessonPaymentIntents").doc(paymentIntentId).get();
    if (!pendingDoc.exists) throw new Error("Payment record not found");

    const pendingData = pendingDoc.data() as Record<string, unknown>;
    if (pendingData["authUid"] !== authUid) throw new Error("Access denied");
    const connectedAccountId = pendingData["connectedAccountId"] as string;

    const paymentIntent = await stripeService.retrieveConnectedPaymentIntent(paymentIntentId, connectedAccountId);
    if (paymentIntent.status !== "succeeded") throw new Error("Payment not completed");

    const meta = (paymentIntent.metadata || {}) as Record<string, string>;

    const booking = await this.createBookingRecord({
      studentId: meta["studentId"] || "",
      authUid: meta["authUid"] || authUid,
      instructorId: meta["instructorId"] as string,
      studioId: meta["studioId"] as string,
      date: meta["date"] as string,
      timeSlot: { startTime: meta["timeSlotStart"] as string, endTime: meta["timeSlotEnd"] as string },
      notes: meta["notes"] || null,
      contactInfo: { email: meta["contactEmail"] || null, phone: meta["contactPhone"] || null },
      amountPaid: parseFloat(meta["amountPaid"] ?? "0") || 0,
      stripePaymentIntentId: paymentIntentId,
      stripeConnectedAccountId: connectedAccountId,
    });
    await pendingDoc.ref.delete();

    return booking;
  }
}

export default new BookingsService();
