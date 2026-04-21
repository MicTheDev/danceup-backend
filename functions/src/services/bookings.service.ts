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
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
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

  async confirmBooking(
    bookingId: string, studioOwnerId: string,
  ): Promise<Record<string, unknown> & { id: string }> {
    const db = getFirestore();
    const ref = db.collection("privateLessonBookings").doc(bookingId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Booking not found");
    const bookingData = doc.data() as Record<string, unknown>;
    if (bookingData["studioId"] !== studioOwnerId) {
      throw new Error("Access denied: Booking does not belong to this studio");
    }
    if (bookingData["status"] === "confirmed") throw new Error("Booking is already confirmed");
    if (bookingData["status"] === "cancelled") throw new Error("Cannot confirm a cancelled booking");
    await ref.update({ status: "confirmed", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    const updatedDoc = await ref.get();
    return { id: updatedDoc.id, ...(updatedDoc.data() as Record<string, unknown>) };
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

  async createPrivateLessonCheckout(
    bookingData: BookingData,
    user: { uid: string; email?: string | null },
    studentId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
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
    const studioName = (studioOwnerData["studioName"] as string) || "Studio";

    const instructorName = [instructor.firstName, instructor.lastName].filter(Boolean).join(" ");
    const amountCents = Math.round(privateRate * 100);

    const metadata: Record<string, string> = {
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

    if (bookingData.contactInfo?.email) metadata["contactEmail"] = bookingData.contactInfo.email;
    if (bookingData.contactInfo?.phone) metadata["contactPhone"] = bookingData.contactInfo.phone;

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
      customerEmail: user.email ?? undefined,
      connectedAccountId,
      metadata,
      successUrl: fullSuccessUrl,
      cancelUrl,
    });

    return { checkoutUrl: session.url as string, sessionId: session.id };
  }

  async createConfirmedBookingFromSession(session: Record<string, unknown>): Promise<string> {
    const meta = (session["metadata"] ?? {}) as Record<string, string>;
    if (meta["purchaseType"] !== "private_lesson") {
      throw new Error("Session is not a private_lesson purchase");
    }

    const db = getFirestore();
    const bookingsRef = db.collection("privateLessonBookings");

    const existing = await bookingsRef
      .where("stripeSessionId", "==", session["id"])
      .limit(1)
      .get();
    if (!existing.empty) {
      const firstDoc = existing.docs[0];
      if (firstDoc) return firstDoc.id;
    }

    const customerDetails = session["customer_details"] as Record<string, unknown> | undefined;
    const docRef = await bookingsRef.add({
      studentId: meta["studentId"] || "guest",
      authUid: meta["authUid"] || "guest",
      instructorId: meta["instructorId"],
      studioId: meta["studioId"],
      date: meta["date"],
      timeSlot: { startTime: meta["timeSlotStart"], endTime: meta["timeSlotEnd"] },
      status: "confirmed",
      paymentStatus: "paid",
      stripeSessionId: session["id"],
      notes: meta["notes"] || null,
      contactInfo: {
        email: meta["contactEmail"] || (customerDetails?.["email"] as string | null) || null,
        phone: meta["contactPhone"] || null,
      },
      amountPaid: parseFloat(meta["amountPaid"] ?? "0") || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }
}

export default new BookingsService();
