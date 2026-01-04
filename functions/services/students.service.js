const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling student management operations
 */
class StudentsService {
  /**
   * Get studio owner ID from Firebase Auth UID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string | null>} Studio owner document ID
   */
  async getStudioOwnerId(authUid) {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) {
      return null;
    }
    return userDoc.id;
  }

  /**
   * Get all students for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of students
   */
  async getStudents(studioOwnerId) {
    const db = getFirestore();
    const studentsRef = db.collection("students");
    const snapshot = await studentsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const students = [];
    snapshot.forEach((doc) => {
      students.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return students;
  }

  /**
   * Get a single student by ID
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object | null>} Student data or null if not found
   */
  async getStudentById(studentId, studioOwnerId) {
    const db = getFirestore();
    const studentRef = db.collection("students").doc(studentId);
    const doc = await studentRef.get();

    if (!doc.exists) {
      return null;
    }

    const studentData = doc.data();
    if (studentData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }

    return {
      id: doc.id,
      ...studentData,
    };
  }

  /**
   * Create a new student
   * @param {Object} studentData - Student data (may include authUid)
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created student document ID
   */
  async createStudent(studentData, studioOwnerId) {
    const db = getFirestore();
    const studentDataWithMetadata = {
      ...studentData,
      studioOwnerId,
      credits: studentData.credits || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // authUid is included if provided in studentData
    const docRef = await db.collection("students").add(studentDataWithMetadata);
    return docRef.id;
  }

  /**
   * Update an existing student
   * @param {string} studentId - Student document ID
   * @param {Object} studentData - Updated student data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateStudent(studentId, studentData, studioOwnerId) {
    const db = getFirestore();
    const studentRef = db.collection("students").doc(studentId);
    const doc = await studentRef.get();

    if (!doc.exists) {
      throw new Error("Student not found");
    }

    const existingData = doc.data();
    if (existingData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }

    const updateData = {
      ...studentData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await studentRef.update(updateData);
  }

  /**
   * Delete a student
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteStudent(studentId, studioOwnerId) {
    const db = getFirestore();
    const studentRef = db.collection("students").doc(studentId);
    const doc = await studentRef.get();

    if (!doc.exists) {
      throw new Error("Student not found");
    }

    const studentData = doc.data();
    if (studentData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }

    await studentRef.delete();
  }

  /**
   * Get enrolled studios for a student
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<Array<string>>} Array of studio owner IDs
   */
  async getEnrolledStudios(authUid) {
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) {
      return [];
    }

    const studentData = studentProfileDoc.data();
    return studentData.studioIds || [];
  }

  /**
   * Calculate next occurrence of a recurring class
   * @param {string} dayOfWeek - Day of week (Monday, Tuesday, etc.)
   * @param {string} startTime - Start time in HH:mm format
   * @param {Date} fromDate - Date to calculate from (default: today)
   * @returns {Date} Next occurrence datetime
   */
  calculateNextClassInstance(dayOfWeek, startTime, fromDate = new Date()) {
    const dayMap = {
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
      Sunday: 0,
    };

    const targetDay = dayMap[dayOfWeek];
    if (targetDay === undefined) {
      throw new Error(`Invalid day of week: ${dayOfWeek}`);
    }

    const [hours, minutes] = startTime.split(":").map(Number);
    const currentDay = fromDate.getDay();
    let daysUntilNext = targetDay - currentDay;

    // If the target day has passed this week, get next week's occurrence
    if (daysUntilNext < 0 || (daysUntilNext === 0 && this.isTimePassedToday(fromDate, hours, minutes))) {
      daysUntilNext += 7;
    }

    const nextDate = new Date(fromDate);
    nextDate.setDate(fromDate.getDate() + daysUntilNext);
    nextDate.setHours(hours, minutes, 0, 0);

    return nextDate;
  }

  /**
   * Calculate previous occurrences of a recurring class
   * @param {string} dayOfWeek - Day of week
   * @param {string} startTime - Start time in HH:mm format
   * @param {Date} fromDate - Date to calculate from (default: today)
   * @param {number} daysBack - Number of days to look back (default: 30)
   * @returns {Array<Date>} Array of previous occurrence datetimes
   */
  calculatePastClassInstances(dayOfWeek, startTime, fromDate = new Date(), daysBack = 30) {
    const dayMap = {
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
      Sunday: 0,
    };

    const targetDay = dayMap[dayOfWeek];
    if (targetDay === undefined) {
      throw new Error(`Invalid day of week: ${dayOfWeek}`);
    }

    const [hours, minutes] = startTime.split(":").map(Number);
    const instances = [];
    const endDate = new Date(fromDate);
    endDate.setDate(fromDate.getDate() - daysBack);

    // Start from yesterday and work backwards
    let checkDate = new Date(fromDate);
    checkDate.setDate(fromDate.getDate() - 1);
    checkDate.setHours(23, 59, 59, 999); // End of day

    while (checkDate >= endDate) {
      if (checkDate.getDay() === targetDay) {
        const instanceDate = new Date(checkDate);
        instanceDate.setHours(hours, minutes, 0, 0);
        instances.push(instanceDate);
      }
      checkDate.setDate(checkDate.getDate() - 1);
    }

    return instances.reverse(); // Return in chronological order (oldest first)
  }

  /**
   * Check if a time has passed today
   * @param {Date} date - Date to check
   * @param {number} hours - Hours
   * @param {number} minutes - Minutes
   * @returns {boolean} True if time has passed
   */
  isTimePassedToday(date, hours, minutes) {
    const now = new Date();
    const checkTime = new Date(now);
    checkTime.setHours(hours, minutes, 0, 0);
    return now > checkTime;
  }
}

module.exports = new StudentsService();
