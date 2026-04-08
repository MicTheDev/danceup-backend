const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const aiService = require("./services/ai.service");
const insightsService = require("./services/insights.service");
const studentsService = require("./services/students.service");
const {verifyToken} = require("./utils/auth");
const {sendJsonResponse, sendErrorResponse, handleError, corsOptions, isAllowedOrigin} = require("./utils/http");

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

/**
 * POST /generate-description - Generate a description for a class, workshop, event, or package
 * Body: { type: 'class'|'workshop'|'event'|'package', context: { name, danceGenre, ... } }
 * Returns: { description: string }
 */
app.post("/generate-description", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {type, context} = req.body || {};
    const validTypes = ["class", "workshop", "event", "package"];
    if (!type || !validTypes.includes(type)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "type must be one of: class, workshop, event, package");
    }
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "context must be a non-empty object");
    }

    const {description} = await aiService.generateDescription(type, context);
    sendJsonResponse(req, res, 200, {description});
  } catch (error) {
    console.error("Error generating description:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /studio-insights - Generate AI performance insights for the studio
 * Returns: { insights: string, highlights: string[], generatedAt: string }
 */
app.get("/studio-insights", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const {studioName, dashboardStats, topClasses} = await insightsService.getInsightsData(studioOwnerId);
    const {insights, highlights} = await aiService.generateStudioInsights({studioName, dashboardStats, topClasses});

    sendJsonResponse(req, res, 200, {
      insights,
      highlights,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error generating studio insights:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /engagement-summary - Generate AI student engagement summary
 * Returns: { summary: string, atRisk: Array, mostActive: Array, stats: Object, generatedAt: string }
 */
app.get("/engagement-summary", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const {atRisk, mostActive, stats} = await insightsService.getEngagementData(studioOwnerId);
    const {summary} = await aiService.generateEngagementSummary({stats});

    sendJsonResponse(req, res, 200, {
      summary,
      atRisk,
      mostActive,
      stats,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error generating engagement summary:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /scheduling-suggestions - Suggest available class time slots
 * Body: { request: string }
 * Returns: { suggestions: [{dayOfWeek, startTime, endTime, room, reasoning}] }
 */
app.post("/scheduling-suggestions", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {request} = req.body || {};
    if (!request || typeof request !== "string" || !request.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "request must be a non-empty string");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();

    // Fetch active classes and studio name in parallel
    const [classesSnap, studioDoc] = await Promise.all([
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";

    // Build existing schedule text
    const existingClasses = [];
    classesSnap.forEach((doc) => {
      const c = doc.data();
      existingClasses.push(`  - ${c.name} | ${c.danceGenre || ""} | ${c.level || ""} | ${c.dayOfWeek} ${c.startTime}–${c.endTime}${c.room ? ` | Room: ${c.room}` : ""} | Capacity: ${c.maxCapacity || 20}`);
    });
    const existingSchedule = existingClasses.join("\n");

    // Build attendance pulse from dashboard stats
    const attendanceService = require("./services/attendance.service");
    const dashStats = await attendanceService.getDashboardStats(studioOwnerId);
    const pulseLines = (dashStats.attendancePulse || []).map((p) => `  ${p.day}: ${p.checkIns} check-ins / ${p.fillRate}% fill`);
    const attendancePulse = pulseLines.join("\n");

    const {suggestions} = await aiService.generateSchedulingSuggestions({
      studioName,
      existingSchedule,
      attendancePulse,
      request: request.trim().slice(0, 500),
    });

    sendJsonResponse(req, res, 200, {suggestions});
  } catch (error) {
    console.error("Error generating scheduling suggestions:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /review-response - Suggest a professional review response
 * Body: { rating: number, comment: string, entityType: string, entityName: string }
 * Returns: { suggestedResponse: string }
 */
app.post("/review-response", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {rating, comment, entityType, entityName} = req.body || {};
    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5) {
      return sendErrorResponse(req, res, 400, "Validation Error", "rating must be a number between 1 and 5");
    }
    if (!entityType || !["studio", "class", "instructor"].includes(entityType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "entityType must be studio, class, or instructor");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const studioDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";

    const {suggestedResponse} = await aiService.generateReviewResponse({
      studioName,
      rating,
      comment: comment ? String(comment).slice(0, 1000) : "",
      entityType,
      entityName: entityName ? String(entityName).slice(0, 200) : studioName,
    });

    sendJsonResponse(req, res, 200, {suggestedResponse});
  } catch (error) {
    console.error("Error generating review response:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /package-recommendations - AI pricing recommendations for packages
 * Returns: { overallInsight: string, recommendations: Array, generatedAt: string }
 */
app.get("/package-recommendations", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // Fetch packages, purchases, studio name, and class stats in parallel
    const [packagesSnap, purchasesSnap, studioDoc, dashStats] = await Promise.all([
      db.collection("packages").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("users").doc(studioOwnerId).get(),
      require("./services/attendance.service").getDashboardStats(studioOwnerId),
    ]);

    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";

    // Build packages context
    const packages = [];
    packagesSnap.forEach((doc) => {
      const p = doc.data();
      const billing = p.isRecurring ? ` | Recurring: ${p.billingFrequency || "monthly"}` : ` | One-time, expires ${p.expirationDays || 30} days`;
      packages.push({
        id: doc.id,
        name: p.name,
        price: p.price,
        credits: p.credits,
        isActive: p.isActive,
      });
    });

    const packagesContext = packages.map((p) =>
      `  - [${p.id}] "${p.name}" | $${p.price} | ${p.credits} credits | ${p.isActive ? "Active" : "Inactive"}`
    ).join("\n");

    // Aggregate purchases by packageId (last 90 days)
    const purchaseMap = {};
    purchasesSnap.forEach((doc) => {
      const d = doc.data();
      if (d.status && d.status !== "completed") return;
      const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
      if (!createdAt || createdAt < ninetyDaysAgo) return;
      const pid = d.packageId || "unknown";
      if (!purchaseMap[pid]) purchaseMap[pid] = {count: 0, revenue: 0};
      purchaseMap[pid].count++;
      purchaseMap[pid].revenue += d.price ?? d.amount ?? 0;
    });

    const purchaseContext = packages.map((p) => {
      const stats = purchaseMap[p.id] || {count: 0, revenue: 0};
      return `  - "${p.name}": ${stats.count} purchase${stats.count !== 1 ? "s" : ""} | $${stats.revenue.toFixed(2)} revenue (last 90 days)`;
    }).join("\n");

    // Class fill rates from attendance pulse
    const pulseLines = (dashStats.attendancePulse || []).map((p) => `  ${p.day}: ${p.checkIns} check-ins / ${p.fillRate}% fill`);
    const classContext = pulseLines.join("\n");

    const {overallInsight, recommendations} = await aiService.generatePackageRecommendations({
      studioName,
      packagesContext,
      purchaseContext,
      classContext,
    });

    // Enrich recommendations with package metadata where packageId matches
    const enriched = recommendations.map((r) => {
      const pkg = packages.find((p) => p.id === r.packageId);
      return {...r, currentPrice: pkg?.price ?? r.currentPrice ?? 0};
    });

    sendJsonResponse(req, res, 200, {
      overallInsight,
      recommendations: enriched,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error generating package recommendations:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /re-engagement-email - Generate a personalized re-engagement email for an at-risk student
 * Body: { studentId: string, studentName: string, daysSince: number|null, neverAttended: boolean, unusedCredits: number }
 * Returns: { subject: string, body: string }
 */
app.post("/re-engagement-email", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {studentId, studentName, daysSince, neverAttended, unusedCredits} = req.body || {};
    if (!studentName || typeof studentName !== "string" || !studentName.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "studentName is required");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    // Fetch studio name, upcoming events/workshops, and student's recent class names in parallel
    const [studioDoc, eventsSnap, workshopsSnap] = await Promise.all([
      db.collection("users").doc(studioOwnerId).get(),
      db.collection("events").where("studioOwnerId", "==", studioOwnerId)
          .where("startTime", ">=", now).orderBy("startTime").limit(3).get(),
      db.collection("workshops").where("studioOwnerId", "==", studioOwnerId)
          .where("startTime", ">=", now).orderBy("startTime").limit(3).get(),
    ]);

    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";

    // Upcoming highlights
    const upcomingHighlights = [];
    eventsSnap.forEach((doc) => {
      const e = doc.data();
      const dateStr = e.startTime?.toDate ? e.startTime.toDate().toLocaleDateString("en-US", {month: "short", day: "numeric"}) : "";
      upcomingHighlights.push(`${e.name}${dateStr ? ` on ${dateStr}` : ""}`);
    });
    workshopsSnap.forEach((doc) => {
      const w = doc.data();
      const dateStr = w.startTime?.toDate ? w.startTime.toDate().toLocaleDateString("en-US", {month: "short", day: "numeric"}) : "";
      upcomingHighlights.push(`${w.name} workshop${dateStr ? ` on ${dateStr}` : ""}`);
    });

    // Student's last classes (if studentId provided)
    let lastClasses = [];
    if (studentId) {
      const attendanceSnap = await db.collection("attendance")
          .where("studioOwnerId", "==", studioOwnerId)
          .where("studentId", "==", studentId)
          .orderBy("classInstanceDate", "desc")
          .limit(5)
          .get();

      const classIds = new Set();
      attendanceSnap.forEach((doc) => {
        const d = doc.data();
        if (d.classId) classIds.add(d.classId);
      });

      if (classIds.size > 0) {
        const classSnaps = await Promise.all([...classIds].map((id) => db.collection("classes").doc(id).get()));
        lastClasses = classSnaps.filter((s) => s.exists).map((s) => s.data().name).filter(Boolean);
      }
    }

    const {subject, body} = await aiService.generateReEngagementEmail({
      studioName,
      studentName: studentName.trim(),
      daysSince: typeof daysSince === "number" ? daysSince : null,
      neverAttended: Boolean(neverAttended),
      unusedCredits: typeof unusedCredits === "number" ? unusedCredits : 0,
      lastClasses,
      upcomingHighlights: upcomingHighlights.slice(0, 3),
    });

    sendJsonResponse(req, res, 200, {subject, body});
  } catch (error) {
    console.error("Error generating re-engagement email:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /instructor-performance - Generate AI performance summary for all instructors
 * Returns: { summary: string, instructorInsights: Array, generatedAt: string }
 */
app.get("/instructor-performance", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);
    const admin = require("firebase-admin");

    const [instructorsSnap, classesSnap, attendanceSnap, reviewsSnap, studioDoc] = await Promise.all([
      db.collection("instructors").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
          .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
      db.collection("reviews").where("studioOwnerId", "==", studioOwnerId).where("entityType", "==", "instructor").get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";

    // Build class → instructorIds map and capacity
    const classMap = {}; // classId → {instructorIds, maxCapacity}
    classesSnap.forEach((doc) => {
      const d = doc.data();
      classMap[doc.id] = {instructorIds: d.instructorIds || [], maxCapacity: d.maxCapacity || 20};
    });

    // Aggregate attendance per instructor
    const instructorStats = {}; // instructorId → {checkIns, sessions}
    attendanceSnap.forEach((doc) => {
      const d = doc.data();
      if (d.isRemoved) return;
      const cls = classMap[d.classId];
      if (!cls || !cls.instructorIds || cls.instructorIds.length === 0) return;
      const dateKey = d.classInstanceDate?.toDate ? d.classInstanceDate.toDate().toISOString().split("T")[0] : "";
      for (const iid of cls.instructorIds) {
        if (!instructorStats[iid]) instructorStats[iid] = {checkIns: 0, capacityTotal: 0, sessionDates: new Set()};
        instructorStats[iid].checkIns++;
        if (dateKey) instructorStats[iid].sessionDates.add(`${d.classId}_${dateKey}`);
      }
    });

    // Aggregate reviews per instructor
    const reviewStats = {}; // instructorId → {total, count}
    reviewsSnap.forEach((doc) => {
      const d = doc.data();
      const iid = d.entityId;
      if (!iid) return;
      if (!reviewStats[iid]) reviewStats[iid] = {total: 0, count: 0};
      reviewStats[iid].total += d.rating || 0;
      reviewStats[iid].count++;
    });

    // Build class count per instructor
    const classCountMap = {};
    classesSnap.forEach((doc) => {
      for (const iid of (doc.data().instructorIds || [])) {
        classCountMap[iid] = (classCountMap[iid] || 0) + 1;
      }
    });

    const instructors = [];
    instructorsSnap.forEach((doc) => {
      const d = doc.data();
      const iid = doc.id;
      const stats = instructorStats[iid] || {checkIns: 0, sessionDates: new Set()};
      const sessions = stats.sessionDates ? stats.sessionDates.size : 0;
      const classCount = classCountMap[iid] || 0;
      // Estimate fill rate: average check-ins per session vs avg capacity
      const avgCapacity = classCount > 0 ? (
        [...classesSnap.docs]
            .filter((c) => (c.data().instructorIds || []).includes(iid))
            .reduce((sum, c) => sum + (c.data().maxCapacity || 20), 0) / classCount
      ) : 20;
      const avgFillRate = sessions > 0
        ? Math.min(100, Math.round(((stats.checkIns / sessions) / avgCapacity) * 100))
        : 0;

      const revStats = reviewStats[iid];
      const avgRating = revStats && revStats.count > 0 ? Math.round((revStats.total / revStats.count) * 10) / 10 : null;

      instructors.push({
        name: `${d.firstName || ""} ${d.lastName || ""}`.trim() || "Unknown",
        classCount,
        totalCheckIns: stats.checkIns,
        avgFillRate,
        avgRating,
        reviewCount: revStats ? revStats.count : 0,
      });
    });

    if (instructors.length === 0) {
      return sendJsonResponse(req, res, 200, {
        summary: "No instructor data is available yet. Add instructors and track attendance to see performance insights.",
        instructorInsights: [],
        generatedAt: new Date().toISOString(),
      });
    }

    const {summary, instructorInsights} = await aiService.generateInstructorPerformance({studioName, instructors});

    sendJsonResponse(req, res, 200, {summary, instructorInsights, generatedAt: new Date().toISOString()});
  } catch (error) {
    console.error("Error generating instructor performance:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /student-progress-report - Generate a progress report for a specific student
 * Body: { studentId: string }
 * Returns: { report: string, generatedAt: string }
 */
app.post("/student-progress-report", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {studentId} = req.body || {};
    if (!studentId || typeof studentId !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "studentId is required");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const admin = require("firebase-admin");
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    const [studentDoc, studioDoc, allAttendanceSnap, recentAttendanceSnap] = await Promise.all([
      db.collection("students").doc(studentId).get(),
      db.collection("users").doc(studioOwnerId).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).where("studentId", "==", studentId).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).where("studentId", "==", studentId)
          .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
    ]);

    if (!studentDoc.exists || studentDoc.data().studioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    const studentData = studentDoc.data();
    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";
    const studentName = `${studentData.firstName || ""} ${studentData.lastName || ""}`.trim();
    const memberSince = studentData.createdAt?.toDate
      ? studentData.createdAt.toDate().toLocaleDateString("en-US", {month: "long", year: "numeric"})
      : "Unknown";

    // Unique classes
    const classIds = new Set();
    allAttendanceSnap.forEach((doc) => {
      const d = doc.data();
      if (!d.isRemoved && d.classId) classIds.add(d.classId);
    });

    const classSnaps = classIds.size > 0
      ? await Promise.all([...classIds].slice(0, 10).map((id) => db.collection("classes").doc(id).get()))
      : [];
    const classNames = classSnaps.filter((s) => s.exists).map((s) => s.data().name).filter(Boolean);

    const {report} = await aiService.generateStudentProgressReport({
      studioName,
      studentName,
      totalCheckIns: allAttendanceSnap.size,
      checkIns30Days: recentAttendanceSnap.size,
      uniqueClasses: classIds.size,
      classNames,
      memberSince,
      credits: studentData.credits ?? 0,
    });

    sendJsonResponse(req, res, 200, {report, generatedAt: new Date().toISOString()});
  } catch (error) {
    console.error("Error generating student progress report:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /class-demand-analysis - AI demand analysis for all active classes
 * Returns: { summary: string, classes: Array, generatedAt: string }
 */
app.get("/class-demand-analysis", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const admin = require("firebase-admin");
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    const [classesSnap, attendanceSnap, studioDoc] = await Promise.all([
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
          .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";

    // Aggregate check-ins per class
    const checkInsMap = {};
    attendanceSnap.forEach((doc) => {
      const d = doc.data();
      if (d.isRemoved) return;
      checkInsMap[d.classId] = (checkInsMap[d.classId] || 0) + 1;
    });

    // Estimate sessions per class in the last 30 days (weekly classes ≈ 4 sessions)
    const DAY_TO_SESSIONS = {Monday: 4, Tuesday: 4, Wednesday: 4, Thursday: 4, Friday: 4, Saturday: 4, Sunday: 4};

    const classes = [];
    classesSnap.forEach((doc) => {
      const c = doc.data();
      const checkIns = checkInsMap[doc.id] || 0;
      const sessions = DAY_TO_SESSIONS[c.dayOfWeek] || 4;
      const maxCapacity = c.maxCapacity || 20;
      const fillRate = Math.min(100, Math.round((checkIns / (sessions * maxCapacity)) * 100));

      classes.push({
        classId: doc.id,
        name: c.name,
        genre: c.danceGenre || "General",
        level: c.level || "All Levels",
        dayOfWeek: c.dayOfWeek || "TBD",
        startTime: c.startTime || "TBD",
        maxCapacity,
        fillRate,
        checkIns,
      });
    });

    if (classes.length === 0) {
      return sendJsonResponse(req, res, 200, {
        summary: "No active classes found. Add classes to see demand analysis.",
        classes: [],
        generatedAt: new Date().toISOString(),
      });
    }

    const {summary, classes: classInsights} = await aiService.generateClassDemandAnalysis({studioName, classes});

    sendJsonResponse(req, res, 200, {summary, classes: classInsights, generatedAt: new Date().toISOString()});
  } catch (error) {
    console.error("Error generating class demand analysis:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /promo-copy - Generate promotional copy for an event or workshop
 * Body: { entityId: string, entityType: 'event'|'workshop' }
 * Returns: { instagram: string, facebook: string, emailSubject: string, promoBlurb: string }
 */
app.post("/promo-copy", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {entityId, entityType} = req.body || {};
    if (!entityId || typeof entityId !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "entityId is required");
    }
    if (!["event", "workshop"].includes(entityType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "entityType must be event or workshop");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const collection = entityType === "event" ? "events" : "workshops";

    const [entityDoc, studioDoc] = await Promise.all([
      db.collection(collection).doc(entityId).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    if (!entityDoc.exists || entityDoc.data().studioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", `${entityType} not found`);
    }

    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";
    const entity = {id: entityDoc.id, ...entityDoc.data()};

    // Convert Firestore timestamps to ISO strings for the AI prompt
    if (entity.startTime?.toDate) entity.startTime = entity.startTime.toDate().toISOString();

    const {instagram, facebook, emailSubject, promoBlurb} = await aiService.generatePromoCopy({
      studioName,
      entity,
      entityType,
    });

    sendJsonResponse(req, res, 200, {instagram, facebook, emailSubject, promoBlurb});
  } catch (error) {
    console.error("Error generating promo copy:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /revenue-forecast - AI revenue forecast based on purchase history
 * Returns: { forecast: string, projectedRevenue: {low, mid, high}, drivers: string[], risks: string[], generatedAt: string }
 */
app.get("/revenue-forecast", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(now.getMonth() - 6);

    const [purchasesSnap, cashPurchasesSnap, packagesSnap, studioDoc] = await Promise.all([
      db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("cashPurchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("packages").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";

    // Aggregate monthly revenue (last 6 months) — Stripe purchases only (exclude legacy cash entries)
    const monthlyMap = {}; // "YYYY-MM" → { stripe, cash }
    purchasesSnap.forEach((doc) => {
      const d = doc.data();
      if (d.status && d.status !== "completed") return;
      if (d.paymentMethod === "cash") return; // now tracked in cashPurchases
      const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
      if (!createdAt || createdAt < sixMonthsAgo) return;
      const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) monthlyMap[key] = {stripe: 0, cash: 0};
      monthlyMap[key].stripe += (d.price ?? d.amount ?? 0);
    });

    // Aggregate cash purchases
    cashPurchasesSnap.forEach((doc) => {
      const d = doc.data();
      if (d.status && d.status !== "completed") return;
      const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
      if (!createdAt || createdAt < sixMonthsAgo) return;
      const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) monthlyMap[key] = {stripe: 0, cash: 0};
      monthlyMap[key].cash += (d.amount ?? 0);
    });

    // Build sorted monthly revenue array (stripe + cash combined)
    const monthlyRevenue = Object.entries(monthlyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, {stripe, cash}]) => {
          const [year, month] = key.split("-");
          const date = new Date(Number(year), Number(month) - 1, 1);
          return {
            month: date.toLocaleDateString("en-US", {month: "short", year: "numeric"}),
            revenue: stripe + cash,
            stripe,
            cash,
          };
        });

    // Count recurring subscriptions (packages that are recurring)
    let activeSubscriptions = 0;
    packagesSnap.forEach((doc) => {
      if (doc.data().isRecurring) activeSubscriptions++;
    });

    // Calculate average month-over-month growth
    let avgMonthlyGrowth = 0;
    if (monthlyRevenue.length >= 2) {
      const growthRates = [];
      for (let i = 1; i < monthlyRevenue.length; i++) {
        const prev = monthlyRevenue[i - 1].revenue;
        if (prev > 0) {
          growthRates.push(((monthlyRevenue[i].revenue - prev) / prev) * 100);
        }
      }
      if (growthRates.length > 0) {
        avgMonthlyGrowth = Math.round(growthRates.reduce((a, b) => a + b, 0) / growthRates.length * 10) / 10;
      }
    }

    if (monthlyRevenue.length === 0) {
      return sendJsonResponse(req, res, 200, {
        forecast: "No purchase history is available yet. Once students start purchasing packages, AI will be able to forecast revenue trends.",
        projectedRevenue: {low: 0, mid: 0, high: 0},
        drivers: [],
        risks: ["No historical data available"],
        generatedAt: new Date().toISOString(),
      });
    }

    const totalCash = monthlyRevenue.reduce((s, m) => s + m.cash, 0);
    const totalStripe = monthlyRevenue.reduce((s, m) => s + m.stripe, 0);
    const cashPercent = (totalStripe + totalCash) > 0
      ? Math.round((totalCash / (totalStripe + totalCash)) * 100)
      : 0;

    const {forecast, projectedRevenue, drivers, risks} = await aiService.generateRevenueForecast({
      studioName,
      monthlyRevenue,
      activeSubscriptions,
      avgMonthlyGrowth,
      cashPercent,
    });

    sendJsonResponse(req, res, 200, {forecast, projectedRevenue, drivers, risks, generatedAt: new Date().toISOString()});
  } catch (error) {
    console.error("Error generating revenue forecast:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /schedule-health - AI schedule health report for all active classes
 * Returns: { summary: string, strengths: string[], gaps: string[], recommendations: string[], generatedAt: string }
 */
app.get("/schedule-health", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = require("./utils/firestore").getFirestore();
    const admin = require("firebase-admin");
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    const [classesSnap, attendanceSnap, studioDoc] = await Promise.all([
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
          .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Your Studio") : "Your Studio";

    // Check-ins per class
    const checkInsMap = {};
    attendanceSnap.forEach((doc) => {
      const d = doc.data();
      if (d.isRemoved) return;
      checkInsMap[d.classId] = (checkInsMap[d.classId] || 0) + 1;
    });

    // Build schedule context
    const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const byDay = {};
    classesSnap.forEach((doc) => {
      const c = doc.data();
      const day = c.dayOfWeek || "Unscheduled";
      if (!byDay[day]) byDay[day] = [];
      const sessions = 4; // approximate sessions/month
      const maxCapacity = c.maxCapacity || 20;
      const checkIns = checkInsMap[doc.id] || 0;
      const fillRate = Math.min(100, Math.round((checkIns / (sessions * maxCapacity)) * 100));
      byDay[day].push(`${c.startTime || "?"} – ${c.endTime || "?"}: "${c.name}" (${c.danceGenre || "?"}, ${c.level || "All Levels"}) — fill rate ${fillRate}%`);
    });

    const scheduleLines = DAY_ORDER
        .filter((d) => byDay[d])
        .map((d) => `${d}:\n${byDay[d].map((l) => `  • ${l}`).join("\n")}`);

    if (scheduleLines.length === 0 && Object.keys(byDay).length > 0) {
      // unscheduled classes
      scheduleLines.push(`Unscheduled:\n${(byDay["Unscheduled"] || []).map((l) => `  • ${l}`).join("\n")}`);
    }

    const scheduleContext = scheduleLines.join("\n\n") || "No active classes scheduled.";

    // Coverage gap analysis
    const coveredDays = new Set(Object.keys(byDay));
    const missingDays = DAY_ORDER.filter((d) => !coveredDays.has(d));
    const genreSet = new Set();
    const levelSet = new Set();
    classesSnap.forEach((doc) => {
      const c = doc.data();
      if (c.danceGenre) genreSet.add(c.danceGenre);
      if (c.level) levelSet.add(c.level);
    });

    const coverageGaps = [
      missingDays.length > 0 ? `No classes on: ${missingDays.join(", ")}` : "All 7 days have at least one class.",
      `Genres offered: ${genreSet.size > 0 ? [...genreSet].join(", ") : "None"}`,
      `Levels offered: ${levelSet.size > 0 ? [...levelSet].join(", ") : "None"}`,
      !levelSet.has("Beginner") && !levelSet.has("beginner") ? "⚠️ No beginner-level classes detected — potential barrier to new students." : "",
    ].filter(Boolean).join("\n");

    const {summary, strengths, gaps, recommendations} = await aiService.generateScheduleHealth({
      studioName,
      scheduleContext,
      coverageGaps,
    });

    sendJsonResponse(req, res, 200, {summary, strengths, gaps, recommendations, generatedAt: new Date().toISOString()});
  } catch (error) {
    console.error("Error generating schedule health:", error);
    handleError(req, res, error);
  }
});

app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

exports.ai = functions.https.onRequest(app);
