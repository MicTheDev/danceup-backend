const admin = require("firebase-admin");
const authService = require("./auth.service");
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
   * Get all attendance records for a studio owner, optionally filtered by date range
   * @param {string} studioOwnerId - Studio owner document ID
   * @param {Date} startDate - Optional start date filter
   * @param {Date} endDate - Optional end date filter
   * @returns {Promise<Array>} Array of attendance records
   */
  async getAttendanceRecords(studioOwnerId, startDate = null, endDate = null) {
    const db = getFirestore();
    const attendanceRef = db.collection("attendance");
    
    let query = attendanceRef.where("studioOwnerId", "==", studioOwnerId);
    
    const snapshot = await query.get();
    
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

    return records;
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
}

module.exports = new AttendanceService();


