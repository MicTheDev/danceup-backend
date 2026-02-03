const admin = require("firebase-admin");
const authService = require("./auth.service");
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
}

module.exports = new BookingsService();
