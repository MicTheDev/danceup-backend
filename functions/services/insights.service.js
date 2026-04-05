const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");
const attendanceService = require("./attendance.service");
const studentsService = require("./students.service");

/**
 * Gather all data needed for Studio Performance Insights AI generation.
 * @param {string} studioOwnerId
 * @returns {Promise<Object>}
 */
async function getInsightsData(studioOwnerId) {
  const db = getFirestore();
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  const [dashboardStats, classStats, studioDoc] = await Promise.all([
    attendanceService.getDashboardStats(studioOwnerId),
    attendanceService.getClassAttendanceStats(studioOwnerId, thirtyDaysAgo, now),
    db.collection("users").doc(studioOwnerId).get(),
  ]);

  const studioName = studioDoc.exists
    ? (studioDoc.data().studioName || "Your Studio")
    : "Your Studio";

  // Summarise top/bottom classes (limit to 8 for prompt size)
  const topClasses = (classStats.byClass || []).slice(0, 8).map((c) => ({
    name: c.className || "Unknown Class",
    totalAttendance: c.totalAttendance,
  }));

  return {studioName, dashboardStats, topClasses, classStats};
}

/**
 * Gather all data needed for Student Engagement Summary AI generation.
 * Also returns the raw at-risk and most-active lists for the frontend.
 * @param {string} studioOwnerId
 * @returns {Promise<Object>}
 */
async function getEngagementData(studioOwnerId) {
  const db = getFirestore();
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(now.getDate() - 90);
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);

  // Fetch students and recent attendance in parallel
  const [studentsSnap, attendanceSnap] = await Promise.all([
    db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
    db.collection("attendance")
        .where("studioOwnerId", "==", studioOwnerId)
        .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(ninetyDaysAgo))
        .get(),
  ]);

  // Build per-student attendance maps
  const lastAttendanceDate = {}; // studentId → Date
  const checkIns30Days = {}; // studentId → count

  attendanceSnap.docs.forEach((doc) => {
    const data = doc.data();
    if (data.isRemoved) return;
    const sid = data.studentId;
    const date = data.classInstanceDate?.toDate
      ? data.classInstanceDate.toDate()
      : new Date(data.classInstanceDate);

    if (!lastAttendanceDate[sid] || date > lastAttendanceDate[sid]) {
      lastAttendanceDate[sid] = date;
    }
    if (date >= thirtyDaysAgo) {
      checkIns30Days[sid] = (checkIns30Days[sid] || 0) + 1;
    }
  });

  const students = studentsSnap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      firstName: d.firstName || "",
      lastName: d.lastName || "",
      credits: d.credits ?? 0,
      createdAt: d.createdAt?.toDate ? d.createdAt.toDate() : new Date(d.createdAt || 0),
    };
  });

  const totalStudents = students.length;

  // At-risk: last attendance > 30 days ago OR never attended (and enrolled > 7 days)
  const atRisk = students
      .filter((s) => {
        const last = lastAttendanceDate[s.id];
        if (!last) return s.createdAt < sevenDaysAgo; // never attended + enrolled >7 days
        return last < thirtyDaysAgo;
      })
      .map((s) => {
        const last = lastAttendanceDate[s.id];
        return {
          id: s.id,
          firstName: s.firstName,
          lastName: s.lastName,
          credits: s.credits,
          lastAttendance: last ? last.toISOString() : null,
          daysSinceAttendance: last
            ? Math.floor((now - last) / (1000 * 60 * 60 * 24))
            : null,
          neverAttended: !last,
        };
      })
      .sort((a, b) => (b.daysSinceAttendance ?? 9999) - (a.daysSinceAttendance ?? 9999))
      .slice(0, 15);

  // Most active: top 5 by check-ins in last 30 days
  const mostActive = students
      .filter((s) => checkIns30Days[s.id] > 0)
      .sort((a, b) => (checkIns30Days[b.id] || 0) - (checkIns30Days[a.id] || 0))
      .slice(0, 5)
      .map((s) => ({
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        checkIns30Days: checkIns30Days[s.id] || 0,
      }));

  const activeThisMonth = new Set(
      Object.entries(checkIns30Days)
          .filter(([, count]) => count > 0)
          .map(([id]) => id),
  ).size;

  const totalCheckIns30Days = Object.values(checkIns30Days).reduce((a, b) => a + b, 0);
  const avgCheckIns = activeThisMonth > 0
    ? Math.round((totalCheckIns30Days / activeThisMonth) * 10) / 10
    : 0;

  const studentsWithCredits = students.filter((s) => s.credits > 0).length;
  const atRiskWithCredits = atRisk.filter((s) => s.credits > 0).length;

  const stats = {
    totalStudents,
    atRiskCount: atRisk.length,
    activeThisMonth,
    avgCheckInsPerActiveStudent: avgCheckIns,
    studentsWithCredits,
    atRiskWithCredits,
  };

  return {atRisk, mostActive, stats};
}

module.exports = {getInsightsData, getEngagementData};
