const admin = require("firebase-admin");
const authService = require("./auth.service");
const creditTrackingService = require("./credit-tracking.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling attendance analytics operations
 */
class AttendanceService {
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
   * Get student document ID from Firebase Auth UID
   * Checks students collection for matching authUid
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string | null>} Student document ID or null if not found
   */
  async getStudentIdByAuthUid(authUid) {
    const db = getFirestore();
    const studentsRef = db.collection("students");
    const snapshot = await studentsRef
        .where("authUid", "==", authUid)
        .limit(1)
        .get();

    if (snapshot.empty) {
      return null;
    }

    return snapshot.docs[0].id;
  }

  /**
   * Get all attendance records for a specific student
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of attendance records
   */
  async getAttendanceRecordsByStudent(studentId, studioOwnerId) {
    const db = getFirestore();
    
    // Verify student belongs to this studio owner
    const studentRef = db.collection("students").doc(studentId);
    const studentDoc = await studentRef.get();
    if (!studentDoc.exists) {
      throw new Error("Student not found");
    }
    const studentData = studentDoc.data();
    if (studentData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }
    
    // Get attendance records for this student
    const attendanceRef = db.collection("attendance");
    const query = attendanceRef
        .where("studentId", "==", studentId)
        .where("studioOwnerId", "==", studioOwnerId)
        .orderBy("classInstanceDate", "desc");
    
    const snapshot = await query.get();
    
    const records = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      
      // Convert Firestore Timestamps to ISO strings for JSON serialization
      const record = {
        id: doc.id,
        ...data,
      };
      
      // Convert Timestamp fields to ISO strings
      if (data.classInstanceDate && data.classInstanceDate.toDate) {
        record.classInstanceDate = data.classInstanceDate.toDate().toISOString();
      }
      if (data.checkedInAt && data.checkedInAt.toDate) {
        record.checkedInAt = data.checkedInAt.toDate().toISOString();
      }
      if (data.createdAt && data.createdAt.toDate) {
        record.createdAt = data.createdAt.toDate().toISOString();
      }
      if (data.removedAt && data.removedAt.toDate) {
        record.removedAt = data.removedAt.toDate().toISOString();
      }
      
      records.push(record);
    });

    // Note: We return all records including removed ones
    // The frontend can filter based on isRemoved flag if needed
    return records;
  }

  /**
   * Get all attendance records for a studio owner, optionally filtered by date range
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {Date} startDate - Optional start date filter
   * @param {Date} endDate - Optional end date filter
   * @returns {Promise<Array>} Array of attendance records
   */
  async getAttendanceRecords(studioOwnerId, startDate = null, endDate = null) {
    const db = getFirestore();
    const attendanceRef = db.collection("attendance");
    
    console.log(`[AttendanceService] getAttendanceRecords - studioOwnerId: ${studioOwnerId}, startDate: ${startDate}, endDate: ${endDate}`);
    
    try {
      let query = attendanceRef.where("studioOwnerId", "==", studioOwnerId);
      
      console.log("[AttendanceService] Executing Firestore query...");
      const snapshot = await query.get();
      console.log(`[AttendanceService] Query completed. Found ${snapshot.size} documents`);
      
      const records = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        const instanceDate = data.classInstanceDate?.toDate();
        
        // Filter by date range if provided
        if (startDate && instanceDate && instanceDate < startDate) {
          return;
        }
        if (endDate && instanceDate && instanceDate > endDate) {
          return;
        }
        
        records.push({
          id: doc.id,
          ...data,
        });
      });

      console.log(`[AttendanceService] Returning ${records.length} filtered records`);
      return records;
    } catch (error) {
      console.error("[AttendanceService] Error in getAttendanceRecords:", error);
      throw error;
    }
  }

  /**
   * Get attendance statistics for a specific class
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {string} classId - Class ID to filter by
   * @param {Date} startDate - Optional start date filter
   * @param {Date} endDate - Optional end date filter
   * @returns {Promise<Object>} Class attendance stats with weekly and monthly data for the specific class
   */
  async getClassSpecificAttendanceStats(studioOwnerId, classId, startDate = null, endDate = null) {
    try {
      const records = await this.getAttendanceRecords(studioOwnerId, startDate, endDate);
      
      // Filter for the specific class
      const classRecords = records.filter((r) => r.classId === classId);
      
      if (classRecords.length === 0) {
        return {
          weekly: [],
          monthly: [],
          total: 0,
        };
      }

      const weeklyMap = new Map();
      const monthlyMap = new Map();

      classRecords.forEach((record) => {
        const instanceDate = record.classInstanceDate?.toDate();
        if (!instanceDate) return;

        // Weekly aggregation
        const weekKey = this.getWeekKey(instanceDate);
        weeklyMap.set(weekKey, (weeklyMap.get(weekKey) || 0) + 1);

        // Monthly aggregation
        const monthKey = this.getMonthKey(instanceDate);
        monthlyMap.set(monthKey, (monthlyMap.get(monthKey) || 0) + 1);
      });

      // Convert maps to sorted arrays
      const weekly = Array.from(weeklyMap.entries())
          .map(([period, count]) => ({period, count}))
          .sort((a, b) => a.period.localeCompare(b.period));

      const monthly = Array.from(monthlyMap.entries())
          .map(([period, count]) => ({period, count}))
          .sort((a, b) => a.period.localeCompare(b.period));

      return {
        weekly,
        monthly,
        total: classRecords.length,
      };
    } catch (error) {
      console.error("Error getting class-specific attendance stats:", error);
      throw error;
    }
  }

  /**
   * Get class attendance statistics
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {Date} startDate - Optional start date filter
   * @param {Date} endDate - Optional end date filter
   * @returns {Promise<Object>} Class attendance stats with weekly, monthly, and per-class data
   */
  async getClassAttendanceStats(studioOwnerId, startDate = null, endDate = null) {
    try {
      const records = await this.getAttendanceRecords(studioOwnerId, startDate, endDate);
      
      // Filter for class attendance only
      const classRecords = records.filter((r) => r.classId);
      
      if (classRecords.length === 0) {
        return {
          weekly: [],
          monthly: [],
          byClass: [],
          total: 0,
        };
      }

      const weeklyMap = new Map();
      const monthlyMap = new Map();
      const classMap = new Map();

      classRecords.forEach((record) => {
        const instanceDate = record.classInstanceDate?.toDate();
        if (!instanceDate) return;

        // Weekly aggregation
        const weekKey = this.getWeekKey(instanceDate);
        weeklyMap.set(weekKey, (weeklyMap.get(weekKey) || 0) + 1);

        // Monthly aggregation
        const monthKey = this.getMonthKey(instanceDate);
        monthlyMap.set(monthKey, (monthlyMap.get(monthKey) || 0) + 1);

        // Per-class aggregation
        const classId = record.classId;
        if (classId) {
          const current = classMap.get(classId) || {count: 0, classId};
          classMap.set(classId, {...current, count: current.count + 1});
        }
      });

      // Convert maps to sorted arrays
      const weekly = Array.from(weeklyMap.entries())
          .map(([period, count]) => ({period, count}))
          .sort((a, b) => a.period.localeCompare(b.period));

      const monthly = Array.from(monthlyMap.entries())
          .map(([period, count]) => ({period, count}))
          .sort((a, b) => a.period.localeCompare(b.period));

      const byClass = Array.from(classMap.entries())
          .map(([classId, data]) => ({
            classId,
            className: "", // Will be populated by fetching class names
            totalAttendance: data.count,
          }))
          .sort((a, b) => b.totalAttendance - a.totalAttendance);

      // Get class names
      const db = getFirestore();
      const classIds = Array.from(classMap.keys());
      if (classIds.length > 0) {
        const classesRef = db.collection("classes");
        const classDocs = await Promise.all(
            classIds.map((id) => classesRef.doc(id).get()),
        );
        
        classDocs.forEach((doc) => {
          if (doc.exists) {
            const classData = doc.data();
            const classStat = byClass.find((c) => c.classId === doc.id);
            if (classStat) {
              classStat.className = classData.name || "Unknown Class";
            }
          }
        });
      }

      return {
        weekly,
        monthly,
        byClass,
        total: classRecords.length,
      };
    } catch (error) {
      console.error("Error getting class attendance stats:", error);
      throw error;
    }
  }

  /**
   * Get workshop attendance statistics
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {Date} startDate - Optional start date filter
   * @param {Date} endDate - Optional end date filter
   * @returns {Promise<Object>} Workshop attendance stats with total and per-workshop data
   */
  async getWorkshopAttendanceStats(studioOwnerId, startDate = null, endDate = null) {
    try {
      const records = await this.getAttendanceRecords(studioOwnerId, startDate, endDate);
      
      // Filter for workshop attendance only
      const workshopRecords = records.filter((r) => r.workshopId);
      
      if (workshopRecords.length === 0) {
        return {
          total: 0,
          byWorkshop: [],
        };
      }

      const workshopMap = new Map();

      workshopRecords.forEach((record) => {
        const workshopId = record.workshopId;
        if (workshopId) {
          const current = workshopMap.get(workshopId) || {count: 0, workshopId};
          workshopMap.set(workshopId, {...current, count: current.count + 1});
        }
      });

      const byWorkshop = Array.from(workshopMap.entries())
          .map(([workshopId, data]) => ({
            workshopId,
            workshopName: "", // Will be populated by fetching workshop names
            totalAttendance: data.count,
          }))
          .sort((a, b) => b.totalAttendance - a.totalAttendance);

      // Get workshop names
      const db = getFirestore();
      const workshopIds = Array.from(workshopMap.keys());
      if (workshopIds.length > 0) {
        const workshopsRef = db.collection("workshops");
        const workshopDocs = await Promise.all(
            workshopIds.map((id) => workshopsRef.doc(id).get()),
        );
        
        workshopDocs.forEach((doc) => {
          if (doc.exists) {
            const workshopData = doc.data();
            const workshopStat = byWorkshop.find((w) => w.workshopId === doc.id);
            if (workshopStat) {
              workshopStat.workshopName = workshopData.name || "Unknown Workshop";
            }
          }
        });
      }

      return {
        total: workshopRecords.length,
        byWorkshop,
      };
    } catch (error) {
      console.error("Error getting workshop attendance stats:", error);
      throw error;
    }
  }

  /**
   * Get event attendance statistics
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {Date} startDate - Optional start date filter
   * @param {Date} endDate - Optional end date filter
   * @returns {Promise<Object>} Event attendance stats with weekly and monthly data
   */
  async getEventAttendanceStats(studioOwnerId, startDate = null, endDate = null) {
    try {
      const records = await this.getAttendanceRecords(studioOwnerId, startDate, endDate);
      
      // Filter for event attendance only
      const eventRecords = records.filter((r) => r.eventId);
      
      if (eventRecords.length === 0) {
        return {
          weekly: [],
          monthly: [],
          total: 0,
        };
      }

      const weeklyMap = new Map();
      const monthlyMap = new Map();

      eventRecords.forEach((record) => {
        const instanceDate = record.classInstanceDate?.toDate();
        if (!instanceDate) return;

        // Weekly aggregation
        const weekKey = this.getWeekKey(instanceDate);
        weeklyMap.set(weekKey, (weeklyMap.get(weekKey) || 0) + 1);

        // Monthly aggregation
        const monthKey = this.getMonthKey(instanceDate);
        monthlyMap.set(monthKey, (monthlyMap.get(monthKey) || 0) + 1);
      });

      const weekly = Array.from(weeklyMap.entries())
          .map(([period, count]) => ({period, count}))
          .sort((a, b) => a.period.localeCompare(b.period));

      const monthly = Array.from(monthlyMap.entries())
          .map(([period, count]) => ({period, count}))
          .sort((a, b) => a.period.localeCompare(b.period));

      return {
        weekly,
        monthly,
        total: eventRecords.length,
      };
    } catch (error) {
      console.error("Error getting event attendance stats:", error);
      throw error;
    }
  }

  /**
   * Get week key in format YYYY-W## (e.g., "2024-W01")
   * @param {Date} date - Date to get week key for
   * @returns {string} Week key
   */
  getWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    const year = d.getUTCFullYear();
    return `${year}-W${weekNum.toString().padStart(2, "0")}`;
  }

  /**
   * Get month key in format YYYY-MM (e.g., "2024-01")
   * @param {Date} date - Date to get month key for
   * @returns {string} Month key
   */
  getMonthKey(date) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    return `${year}-${month}`;
  }

  /**
   * Check if a student is already checked in for a specific class instance
   * @param {string} studentId - Student document ID
   * @param {string} classId - Optional class ID
   * @param {string} workshopId - Optional workshop ID
   * @param {string} eventId - Optional event ID
   * @param {admin.firestore.Timestamp} classInstanceDate - Class instance date
   * @returns {Promise<Object | null>} Existing attendance record or null
   */
  async checkDuplicateCheckIn(studentId, classId, workshopId, eventId, classInstanceDate) {
    const db = getFirestore();
    const attendanceRef = db.collection("attendance");

    // Normalize classInstanceDate to start of day for comparison
    const instanceDate = classInstanceDate.toDate();
    const startOfDay = new Date(instanceDate.getFullYear(), instanceDate.getMonth(), instanceDate.getDate());
    const startOfDayTimestamp = admin.firestore.Timestamp.fromDate(startOfDay);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    const endOfDayTimestamp = admin.firestore.Timestamp.fromDate(endOfDay);

    // Build query based on which ID is provided
    let query = attendanceRef
        .where("studentId", "==", studentId)
        .where("classInstanceDate", ">=", startOfDayTimestamp)
        .where("classInstanceDate", "<", endOfDayTimestamp);

    if (classId) {
      query = query.where("classId", "==", classId);
    } else if (workshopId) {
      query = query.where("workshopId", "==", workshopId);
    } else if (eventId) {
      query = query.where("eventId", "==", eventId);
    }

    const snapshot = await query.get();

    // Check for non-removed attendance records
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (!data.isRemoved) {
        return {
          id: doc.id,
          ...data,
        };
      }
    }

    return null;
  }

  /**
   * Create an attendance record
   * @param {Object} attendanceData - Attendance data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created attendance document ID
   */
  async createAttendanceRecord(attendanceData, studioOwnerId) {
    const db = getFirestore();

    // Validate required fields
    if (!attendanceData.studentId) {
      throw new Error("studentId is required");
    }

    // Validate that exactly one of classId, workshopId, or eventId is provided
    const idCount = [attendanceData.classId, attendanceData.workshopId, attendanceData.eventId]
        .filter(Boolean).length;
    if (idCount !== 1) {
      throw new Error("Exactly one of classId, workshopId, or eventId must be provided");
    }

    // Validate classInstanceDate
    if (!attendanceData.classInstanceDate) {
      throw new Error("classInstanceDate is required");
    }

    // Convert classInstanceDate to Firestore Timestamp if it's a string or Date
    let classInstanceTimestamp;
    if (attendanceData.classInstanceDate instanceof admin.firestore.Timestamp) {
      classInstanceTimestamp = attendanceData.classInstanceDate;
    } else if (attendanceData.classInstanceDate instanceof Date) {
      classInstanceTimestamp = admin.firestore.Timestamp.fromDate(attendanceData.classInstanceDate);
    } else if (typeof attendanceData.classInstanceDate === "string") {
      const date = new Date(attendanceData.classInstanceDate);
      if (isNaN(date.getTime())) {
        throw new Error("Invalid classInstanceDate format");
      }
      classInstanceTimestamp = admin.firestore.Timestamp.fromDate(date);
    } else {
      throw new Error("classInstanceDate must be a Date, Timestamp, or ISO date string");
    }

    // Validate checkedInBy
    if (!attendanceData.checkedInBy || !["studio", "student"].includes(attendanceData.checkedInBy)) {
      throw new Error("checkedInBy must be 'studio' or 'student'");
    }

    // Verify student belongs to studio owner
    const studentRef = db.collection("students").doc(attendanceData.studentId);
    const studentDoc = await studentRef.get();
    if (!studentDoc.exists) {
      throw new Error("Student not found");
    }
    const studentData = studentDoc.data();
    if (studentData.studioOwnerId !== studioOwnerId) {
      throw new Error("Student does not belong to this studio owner");
    }

    // Check for duplicate check-in
    const existingCheckIn = await this.checkDuplicateCheckIn(
        attendanceData.studentId,
        attendanceData.classId,
        attendanceData.workshopId,
        attendanceData.eventId,
        classInstanceTimestamp
    );

    if (existingCheckIn) {
      throw new Error("Student is already checked in for this class instance");
    }

    // Check if student has available credits
    const availableCredits = await creditTrackingService.getAvailableCredits(
        attendanceData.studentId,
        studioOwnerId
    );

    if (availableCredits < 1) {
      throw new Error("Insufficient credits");
    }

    // Decrement credit (FIFO - oldest first)
    let creditUsedId;
    try {
      creditUsedId = await creditTrackingService.useCredit(
          attendanceData.studentId,
          studioOwnerId
      );
    } catch (error) {
      throw new Error(`Failed to use credit: ${error.message}`);
    }

    // Set checkedInById - default to studioOwnerId if checkedInBy is 'studio' and not provided
    const checkedInById = attendanceData.checkedInById || 
        (attendanceData.checkedInBy === "studio" ? studioOwnerId : attendanceData.studentId);

    // Set checkedInAt - use provided timestamp or current time
    const checkedInAt = attendanceData.checkedInAt || admin.firestore.FieldValue.serverTimestamp();

    // Build attendance document
    const attendanceDoc = {
      studentId: attendanceData.studentId,
      classInstanceDate: classInstanceTimestamp,
      checkedInBy: attendanceData.checkedInBy,
      checkedInById: checkedInById,
      checkedInAt: checkedInAt,
      studioOwnerId: studioOwnerId,
      creditUsedId: creditUsedId,
      isRemoved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Add the appropriate ID field (classId, workshopId, or eventId)
    if (attendanceData.classId) {
      attendanceDoc.classId = attendanceData.classId;
    } else if (attendanceData.workshopId) {
      attendanceDoc.workshopId = attendanceData.workshopId;
    } else if (attendanceData.eventId) {
      attendanceDoc.eventId = attendanceData.eventId;
    }

    // Create the document
    const attendanceRef = db.collection("attendance");
    const docRef = await attendanceRef.add(attendanceDoc);

    return docRef.id;
  }

  /**
   * Remove an attendance record (studio owner only)
   * This restores the credit and marks the attendance as removed
   * @param {string} attendanceId - Attendance document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async removeAttendanceRecord(attendanceId, studioOwnerId) {
    const db = getFirestore();
    const attendanceRef = db.collection("attendance");
    const attendanceDoc = await attendanceRef.doc(attendanceId).get();

    if (!attendanceDoc.exists) {
      throw new Error("Attendance record not found");
    }

    const attendanceData = attendanceDoc.data();

    // Verify attendance belongs to this studio owner
    if (attendanceData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Attendance record does not belong to this studio owner");
    }

    // Check if already removed
    if (attendanceData.isRemoved) {
      throw new Error("Attendance record is already removed");
    }

    // Restore the credit
    if (attendanceData.creditUsedId) {
      try {
        await creditTrackingService.restoreCredit(
            attendanceData.studentId,
            studioOwnerId,
            attendanceData.creditUsedId
        );
      } catch (error) {
        throw new Error(`Failed to restore credit: ${error.message}`);
      }
    }

    // Mark attendance as removed
    await attendanceRef.doc(attendanceId).update({
      isRemoved: true,
      removedAt: admin.firestore.FieldValue.serverTimestamp(),
      removedBy: studioOwnerId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

module.exports = new AttendanceService();



