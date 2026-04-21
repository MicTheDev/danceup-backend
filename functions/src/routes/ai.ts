import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import * as aiService from "../services/ai.service";
import * as insightsService from "../services/insights.service";
import studentsService from "../services/students.service";
import attendanceService from "../services/attendance.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

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
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);

app.post("/generate-description", async (req, res) => {
  try {
    try { await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { type, context } = (req.body || {}) as { type?: string; context?: unknown };
    const validTypes = ["class", "workshop", "event", "package"];
    if (!type || !validTypes.includes(type)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "type must be one of: class, workshop, event, package");
    }
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "context must be a non-empty object");
    }

    const { description } = await aiService.generateDescription(type as "class" | "workshop" | "event" | "package", context as Record<string, unknown>) as { description: string };
    sendJsonResponse(req, res, 200, { description });
  } catch (error) {
    console.error("Error generating description:", error);
    handleError(req, res, error);
  }
});

app.get("/studio-insights", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const { studioName, dashboardStats, topClasses } = await insightsService.getInsightsData(studioOwnerId) as {
      studioName: string;
      dashboardStats: unknown;
      topClasses: unknown[];
    };
    const { insights, highlights } = await aiService.generateStudioInsights({
      studioName,
      dashboardStats: dashboardStats as Record<string, unknown>,
      topClasses: topClasses as { name: string; totalAttendance: number }[],
    }) as { insights: string; highlights: string[] };

    sendJsonResponse(req, res, 200, { insights, highlights, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating studio insights:", error);
    handleError(req, res, error);
  }
});

app.get("/engagement-summary", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const { atRisk, mostActive, stats } = await insightsService.getEngagementData(studioOwnerId) as {
      atRisk: unknown[];
      mostActive: unknown[];
      stats: unknown;
    };
    const { summary } = await aiService.generateEngagementSummary({ stats: stats as Record<string, unknown> }) as { summary: string };

    sendJsonResponse(req, res, 200, { summary, atRisk, mostActive, stats, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating engagement summary:", error);
    handleError(req, res, error);
  }
});

app.post("/scheduling-suggestions", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { request } = (req.body || {}) as { request?: string };
    if (!request || typeof request !== "string" || !request.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "request must be a non-empty string");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const [classesSnap, studioDoc] = await Promise.all([
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const existingClasses: string[] = [];
    classesSnap.forEach((doc) => {
      const c = doc.data() as Record<string, unknown>;
      existingClasses.push(
        `  - ${c["name"]} | ${c["danceGenre"] || ""} | ${c["level"] || ""} | ${c["dayOfWeek"]} ${c["startTime"]}–${c["endTime"]}${c["room"] ? ` | Room: ${c["room"]}` : ""} | Capacity: ${c["maxCapacity"] || 20}`,
      );
    });
    const existingSchedule = existingClasses.join("\n");

    const dashStats = await attendanceService.getDashboardStats(studioOwnerId) as Record<string, unknown>;
    const pulseLines = ((dashStats["attendancePulse"] as Array<Record<string, unknown>>) || []).map(
      (p) => `  ${p["day"]}: ${p["checkIns"]} check-ins / ${p["fillRate"]}% fill`,
    );
    const attendancePulse = pulseLines.join("\n");

    const { suggestions } = await aiService.generateSchedulingSuggestions({
      studioName,
      existingSchedule,
      attendancePulse,
      request: request.trim().slice(0, 500),
    }) as { suggestions: unknown[] };

    sendJsonResponse(req, res, 200, { suggestions });
  } catch (error) {
    console.error("Error generating scheduling suggestions:", error);
    handleError(req, res, error);
  }
});

app.post("/review-response", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { rating, comment, entityType, entityName } = (req.body || {}) as {
      rating?: unknown;
      comment?: unknown;
      entityType?: string;
      entityName?: string;
    };
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

    const db = getFirestore();
    const studioDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const { suggestedResponse } = await aiService.generateReviewResponse({
      studioName,
      rating,
      comment: comment ? String(comment).slice(0, 1000) : "",
      entityType,
      entityName: entityName ? String(entityName).slice(0, 200) : studioName,
    }) as { suggestedResponse: string };

    sendJsonResponse(req, res, 200, { suggestedResponse });
  } catch (error) {
    console.error("Error generating review response:", error);
    handleError(req, res, error);
  }
});

app.get("/package-recommendations", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const [packagesSnap, purchasesSnap, studioDoc, dashStats] = await Promise.all([
      db.collection("packages").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("users").doc(studioOwnerId).get(),
      attendanceService.getDashboardStats(studioOwnerId) as Promise<Record<string, unknown>>,
    ]);

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const packages: Array<{ id: string; name: string; price: number; credits: number; isActive: boolean }> = [];
    packagesSnap.forEach((doc) => {
      const p = doc.data() as Record<string, unknown>;
      packages.push({
        id: doc.id,
        name: p["name"] as string,
        price: p["price"] as number,
        credits: p["credits"] as number,
        isActive: p["isActive"] as boolean,
      });
    });

    const packagesContext = packages.map(
      (p) => `  - [${p.id}] "${p.name}" | $${p.price} | ${p.credits} credits | ${p.isActive ? "Active" : "Inactive"}`,
    ).join("\n");

    const purchaseMap: Record<string, { count: number; revenue: number }> = {};
    purchasesSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d["status"] && d["status"] !== "completed") return;
      const createdAt = (d["createdAt"] as { toDate?: () => Date } | null)?.toDate ? (d["createdAt"] as { toDate: () => Date }).toDate() : null;
      if (!createdAt || createdAt < ninetyDaysAgo) return;
      const pid = (d["packageId"] as string) || "unknown";
      if (!purchaseMap[pid]) purchaseMap[pid] = { count: 0, revenue: 0 };
      purchaseMap[pid]!.count++;
      purchaseMap[pid]!.revenue += (d["price"] as number ?? d["amount"] as number ?? 0);
    });

    const purchaseContext = packages.map((p) => {
      const stats = purchaseMap[p.id] || { count: 0, revenue: 0 };
      return `  - "${p.name}": ${stats.count} purchase${stats.count !== 1 ? "s" : ""} | $${stats.revenue.toFixed(2)} revenue (last 90 days)`;
    }).join("\n");

    const pulseLines = ((dashStats["attendancePulse"] as Array<Record<string, unknown>>) || []).map(
      (p) => `  ${p["day"]}: ${p["checkIns"]} check-ins / ${p["fillRate"]}% fill`,
    );
    const classContext = pulseLines.join("\n");

    const { overallInsight, recommendations } = await aiService.generatePackageRecommendations({
      studioName, packagesContext, purchaseContext, classContext,
    }) as unknown as { overallInsight: string; recommendations: Array<Record<string, unknown>> };

    const enriched = recommendations.map((r) => {
      const pkg = packages.find((p) => p.id === r["packageId"]);
      return { ...r, currentPrice: pkg?.price ?? r["currentPrice"] ?? 0 };
    });

    sendJsonResponse(req, res, 200, { overallInsight, recommendations: enriched, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating package recommendations:", error);
    handleError(req, res, error);
  }
});

app.post("/re-engagement-email", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { studentId, studentName, daysSince, neverAttended, unusedCredits } = (req.body || {}) as {
      studentId?: string;
      studentName?: string;
      daysSince?: unknown;
      neverAttended?: unknown;
      unusedCredits?: unknown;
    };
    if (!studentName || typeof studentName !== "string" || !studentName.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "studentName is required");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    const [studioDoc, eventsSnap, workshopsSnap] = await Promise.all([
      db.collection("users").doc(studioOwnerId).get(),
      db.collection("events").where("studioOwnerId", "==", studioOwnerId).where("startTime", ">=", now).orderBy("startTime").limit(3).get(),
      db.collection("workshops").where("studioOwnerId", "==", studioOwnerId).where("startTime", ">=", now).orderBy("startTime").limit(3).get(),
    ]);

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const upcomingHighlights: string[] = [];
    eventsSnap.forEach((doc) => {
      const e = doc.data() as Record<string, unknown>;
      const ts = e["startTime"] as { toDate?: () => Date } | null;
      const dateStr = ts?.toDate ? ts.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      upcomingHighlights.push(`${e["name"]}${dateStr ? ` on ${dateStr}` : ""}`);
    });
    workshopsSnap.forEach((doc) => {
      const w = doc.data() as Record<string, unknown>;
      const ts = w["startTime"] as { toDate?: () => Date } | null;
      const dateStr = ts?.toDate ? ts.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      upcomingHighlights.push(`${w["name"]} workshop${dateStr ? ` on ${dateStr}` : ""}`);
    });

    let lastClasses: string[] = [];
    if (studentId) {
      const attendanceSnap = await db.collection("attendance")
        .where("studioOwnerId", "==", studioOwnerId)
        .where("studentId", "==", studentId)
        .orderBy("classInstanceDate", "desc")
        .limit(5)
        .get();

      const classIds = new Set<string>();
      attendanceSnap.forEach((doc) => {
        const d = doc.data() as Record<string, unknown>;
        if (d["classId"]) classIds.add(d["classId"] as string);
      });

      if (classIds.size > 0) {
        const classSnaps = await Promise.all([...classIds].slice(0, 10).map((id) => db.collection("classes").doc(id).get()));
        lastClasses = classSnaps
          .filter((s) => s.exists)
          .map((s) => (s.data() as Record<string, unknown>)["name"] as string)
          .filter(Boolean);
      }
    }

    const { subject, body } = await aiService.generateReEngagementEmail({
      studioName,
      studentName: studentName.trim(),
      daysSince: typeof daysSince === "number" ? daysSince : null,
      neverAttended: Boolean(neverAttended),
      unusedCredits: typeof unusedCredits === "number" ? unusedCredits : 0,
      lastClasses,
      upcomingHighlights: upcomingHighlights.slice(0, 3),
    }) as { subject: string; body: string };

    sendJsonResponse(req, res, 200, { subject, body });
  } catch (error) {
    console.error("Error generating re-engagement email:", error);
    handleError(req, res, error);
  }
});

app.get("/instructor-performance", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    const [instructorsSnap, classesSnap, attendanceSnap, reviewsSnap, studioDoc] = await Promise.all([
      db.collection("instructors").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
        .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
      db.collection("reviews").where("studioOwnerId", "==", studioOwnerId).where("entityType", "==", "instructor").get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const classMap: Record<string, { instructorIds: string[]; maxCapacity: number }> = {};
    classesSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      classMap[doc.id] = {
        instructorIds: (d["instructorIds"] as string[]) || [],
        maxCapacity: (d["maxCapacity"] as number) || 20,
      };
    });

    const instructorStats: Record<string, { checkIns: number; capacityTotal: number; sessionDates: Set<string> }> = {};
    attendanceSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d["isRemoved"]) return;
      const cls = classMap[d["classId"] as string];
      if (!cls || !cls.instructorIds || cls.instructorIds.length === 0) return;
      const ts = d["classInstanceDate"] as { toDate?: () => Date } | null;
      const dateKey = ts?.toDate ? ts.toDate().toISOString().split("T")[0] || "" : "";
      for (const iid of cls.instructorIds) {
        if (!instructorStats[iid]) instructorStats[iid] = { checkIns: 0, capacityTotal: 0, sessionDates: new Set() };
        instructorStats[iid]!.checkIns++;
        if (dateKey) instructorStats[iid]!.sessionDates.add(`${d["classId"] as string}_${dateKey}`);
      }
    });

    const reviewStats: Record<string, { total: number; count: number }> = {};
    reviewsSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const iid = d["entityId"] as string;
      if (!iid) return;
      if (!reviewStats[iid]) reviewStats[iid] = { total: 0, count: 0 };
      reviewStats[iid]!.total += (d["rating"] as number) || 0;
      reviewStats[iid]!.count++;
    });

    const classCountMap: Record<string, number> = {};
    classesSnap.forEach((doc) => {
      for (const iid of ((doc.data() as Record<string, unknown>)["instructorIds"] as string[] || [])) {
        classCountMap[iid] = (classCountMap[iid] || 0) + 1;
      }
    });

    const instructors: Array<Record<string, unknown>> = [];
    instructorsSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const iid = doc.id;
      const stats = instructorStats[iid] || { checkIns: 0, sessionDates: new Set<string>() };
      const sessions = stats.sessionDates ? stats.sessionDates.size : 0;
      const classCount = classCountMap[iid] || 0;
      const avgCapacity = classCount > 0
        ? classesSnap.docs
          .filter((c) => ((c.data() as Record<string, unknown>)["instructorIds"] as string[] || []).includes(iid))
          .reduce((sum, c) => sum + ((c.data() as Record<string, unknown>)["maxCapacity"] as number || 20), 0) / classCount
        : 20;
      const avgFillRate = sessions > 0
        ? Math.min(100, Math.round(((stats.checkIns / sessions) / avgCapacity) * 100))
        : 0;

      const revStats = reviewStats[iid];
      const avgRating = revStats && revStats.count > 0 ? Math.round((revStats.total / revStats.count) * 10) / 10 : null;

      instructors.push({
        name: `${d["firstName"] || ""} ${d["lastName"] || ""}`.trim() || "Unknown",
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

    const { summary, instructorInsights } = await aiService.generateInstructorPerformance(
      { studioName, instructors } as unknown as Parameters<typeof aiService.generateInstructorPerformance>[0]
    ) as { summary: string; instructorInsights: unknown[] };

    sendJsonResponse(req, res, 200, { summary, instructorInsights, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating instructor performance:", error);
    handleError(req, res, error);
  }
});

app.post("/student-progress-report", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { studentId } = (req.body || {}) as { studentId?: string };
    if (!studentId || typeof studentId !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "studentId is required");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
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

    const studentData = studentDoc.data() as Record<string, unknown>;
    if (!studentDoc.exists || studentData["studioOwnerId"] !== studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";
    const studentName = `${studentData["firstName"] || ""} ${studentData["lastName"] || ""}`.trim();
    const ts = studentData["createdAt"] as { toDate?: () => Date } | null;
    const memberSince = ts?.toDate
      ? ts.toDate().toLocaleDateString("en-US", { month: "long", year: "numeric" })
      : "Unknown";

    const classIds = new Set<string>();
    allAttendanceSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (!d["isRemoved"] && d["classId"]) classIds.add(d["classId"] as string);
    });

    const classSnaps = classIds.size > 0
      ? await Promise.all([...classIds].slice(0, 10).map((id) => db.collection("classes").doc(id).get()))
      : [];
    const classNames = classSnaps
      .filter((s) => s.exists)
      .map((s) => (s.data() as Record<string, unknown>)["name"] as string)
      .filter(Boolean);

    const { report } = await aiService.generateStudentProgressReport({
      studioName,
      studentName,
      totalCheckIns: allAttendanceSnap.size,
      checkIns30Days: recentAttendanceSnap.size,
      uniqueClasses: classIds.size,
      classNames,
      memberSince,
      credits: (studentData["credits"] as number) ?? 0,
    }) as { report: string };

    sendJsonResponse(req, res, 200, { report, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating student progress report:", error);
    handleError(req, res, error);
  }
});

app.get("/class-demand-analysis", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    const [classesSnap, attendanceSnap, studioDoc] = await Promise.all([
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
        .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const checkInsMap: Record<string, number> = {};
    attendanceSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d["isRemoved"]) return;
      const cid = d["classId"] as string;
      checkInsMap[cid] = (checkInsMap[cid] || 0) + 1;
    });

    const DAY_TO_SESSIONS: Record<string, number> = { Monday: 4, Tuesday: 4, Wednesday: 4, Thursday: 4, Friday: 4, Saturday: 4, Sunday: 4 };

    const classes: Array<Record<string, unknown>> = [];
    classesSnap.forEach((doc) => {
      const c = doc.data() as Record<string, unknown>;
      const checkIns = checkInsMap[doc.id] || 0;
      const sessions = DAY_TO_SESSIONS[c["dayOfWeek"] as string] || 4;
      const maxCapacity = (c["maxCapacity"] as number) || 20;
      const fillRate = Math.min(100, Math.round((checkIns / (sessions * maxCapacity)) * 100));
      classes.push({
        classId: doc.id,
        name: c["name"],
        genre: c["danceGenre"] || "General",
        level: c["level"] || "All Levels",
        dayOfWeek: c["dayOfWeek"] || "TBD",
        startTime: c["startTime"] || "TBD",
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

    const { summary, classes: classInsights } = await aiService.generateClassDemandAnalysis(
      { studioName, classes } as unknown as Parameters<typeof aiService.generateClassDemandAnalysis>[0]
    ) as { summary: string; classes: unknown[] };

    sendJsonResponse(req, res, 200, { summary, classes: classInsights, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating class demand analysis:", error);
    handleError(req, res, error);
  }
});

app.post("/promo-copy", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { entityId, entityType } = (req.body || {}) as { entityId?: string; entityType?: string };
    if (!entityId || typeof entityId !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "entityId is required");
    }
    if (!["event", "workshop"].includes(entityType || "")) {
      return sendErrorResponse(req, res, 400, "Validation Error", "entityType must be event or workshop");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const collection = entityType === "event" ? "events" : "workshops";

    const [entityDoc, studioDoc] = await Promise.all([
      db.collection(collection).doc(entityId).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const entityData = entityDoc.data() as Record<string, unknown>;
    if (!entityDoc.exists || entityData["studioOwnerId"] !== studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", `${entityType as string} not found`);
    }

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";
    const entity: Record<string, unknown> = { id: entityDoc.id, ...entityData };

    const ts = entity["startTime"] as { toDate?: () => Date } | null;
    if (ts?.toDate) entity["startTime"] = ts.toDate().toISOString();

    const { instagram, facebook, emailSubject, promoBlurb } = await aiService.generatePromoCopy(
      { studioName, entity, entityType: entityType as string } as unknown as Parameters<typeof aiService.generatePromoCopy>[0]
    ) as { instagram: string; facebook: string; emailSubject: string; promoBlurb: string };

    sendJsonResponse(req, res, 200, { instagram, facebook, emailSubject, promoBlurb });
  } catch (error) {
    console.error("Error generating promo copy:", error);
    handleError(req, res, error);
  }
});

app.get("/revenue-forecast", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(now.getMonth() - 6);

    const [purchasesSnap, cashPurchasesSnap, packagesSnap, studioDoc] = await Promise.all([
      db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("cashPurchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("packages").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const monthlyMap: Record<string, { stripe: number; cash: number }> = {};
    purchasesSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d["status"] && d["status"] !== "completed") return;
      if (d["paymentMethod"] === "cash") return;
      const ts = d["createdAt"] as { toDate?: () => Date } | null;
      const createdAt = ts?.toDate ? ts.toDate() : null;
      if (!createdAt || createdAt < sixMonthsAgo) return;
      const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) monthlyMap[key] = { stripe: 0, cash: 0 };
      monthlyMap[key]!.stripe += ((d["price"] as number) ?? (d["amount"] as number) ?? 0);
    });

    cashPurchasesSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d["status"] && d["status"] !== "completed") return;
      const ts = d["createdAt"] as { toDate?: () => Date } | null;
      const createdAt = ts?.toDate ? ts.toDate() : null;
      if (!createdAt || createdAt < sixMonthsAgo) return;
      const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) monthlyMap[key] = { stripe: 0, cash: 0 };
      monthlyMap[key]!.cash += ((d["amount"] as number) ?? 0);
    });

    const monthlyRevenue = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { stripe, cash }]) => {
        const [year, month] = key.split("-");
        const date = new Date(Number(year), Number(month) - 1, 1);
        return {
          month: date.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
          revenue: stripe + cash,
          stripe,
          cash,
        };
      });

    let activeSubscriptions = 0;
    packagesSnap.forEach((doc) => {
      if ((doc.data() as Record<string, unknown>)["isRecurring"]) activeSubscriptions++;
    });

    let avgMonthlyGrowth = 0;
    if (monthlyRevenue.length >= 2) {
      const growthRates: number[] = [];
      for (let i = 1; i < monthlyRevenue.length; i++) {
        const prev = monthlyRevenue[i - 1]?.revenue ?? 0;
        const curr = monthlyRevenue[i]?.revenue ?? 0;
        if (prev > 0) growthRates.push(((curr - prev) / prev) * 100);
      }
      if (growthRates.length > 0) {
        avgMonthlyGrowth = Math.round(growthRates.reduce((a, b) => a + b, 0) / growthRates.length * 10) / 10;
      }
    }

    if (monthlyRevenue.length === 0) {
      return sendJsonResponse(req, res, 200, {
        forecast: "No purchase history is available yet. Once students start purchasing packages, AI will be able to forecast revenue trends.",
        projectedRevenue: { low: 0, mid: 0, high: 0 },
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

    const { forecast, projectedRevenue, drivers, risks } = await aiService.generateRevenueForecast({
      studioName, monthlyRevenue, activeSubscriptions, avgMonthlyGrowth, cashPercent,
    }) as { forecast: string; projectedRevenue: Record<string, number>; drivers: string[]; risks: string[] };

    sendJsonResponse(req, res, 200, { forecast, projectedRevenue, drivers, risks, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating revenue forecast:", error);
    handleError(req, res, error);
  }
});

app.get("/schedule-health", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    const [classesSnap, attendanceSnap, studioDoc] = await Promise.all([
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
        .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const checkInsMap: Record<string, number> = {};
    attendanceSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d["isRemoved"]) return;
      const cid = d["classId"] as string;
      checkInsMap[cid] = (checkInsMap[cid] || 0) + 1;
    });

    const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const byDay: Record<string, string[]> = {};
    classesSnap.forEach((doc) => {
      const c = doc.data() as Record<string, unknown>;
      const day = (c["dayOfWeek"] as string) || "Unscheduled";
      if (!byDay[day]) byDay[day] = [];
      const sessions = 4;
      const maxCapacity = (c["maxCapacity"] as number) || 20;
      const checkIns = checkInsMap[doc.id] || 0;
      const fillRate = Math.min(100, Math.round((checkIns / (sessions * maxCapacity)) * 100));
      byDay[day]!.push(`${c["startTime"] || "?"} – ${c["endTime"] || "?"}: "${c["name"]}" (${c["danceGenre"] || "?"}, ${c["level"] || "All Levels"}) — fill rate ${fillRate}%`);
    });

    const scheduleLines = DAY_ORDER
      .filter((d) => byDay[d])
      .map((d) => `${d}:\n${(byDay[d] as string[]).map((l) => `  • ${l}`).join("\n")}`);

    if (scheduleLines.length === 0 && Object.keys(byDay).length > 0) {
      scheduleLines.push(`Unscheduled:\n${(byDay["Unscheduled"] || []).map((l) => `  • ${l}`).join("\n")}`);
    }
    const scheduleContext = scheduleLines.join("\n\n") || "No active classes scheduled.";

    const coveredDays = new Set(Object.keys(byDay));
    const missingDays = DAY_ORDER.filter((d) => !coveredDays.has(d));
    const genreSet = new Set<string>();
    const levelSet = new Set<string>();
    classesSnap.forEach((doc) => {
      const c = doc.data() as Record<string, unknown>;
      if (c["danceGenre"]) genreSet.add(c["danceGenre"] as string);
      if (c["level"]) levelSet.add(c["level"] as string);
    });

    const coverageGaps = [
      missingDays.length > 0 ? `No classes on: ${missingDays.join(", ")}` : "All 7 days have at least one class.",
      `Genres offered: ${genreSet.size > 0 ? [...genreSet].join(", ") : "None"}`,
      `Levels offered: ${levelSet.size > 0 ? [...levelSet].join(", ") : "None"}`,
      !levelSet.has("Beginner") && !levelSet.has("beginner") ? "No beginner-level classes detected — potential barrier to new students." : "",
    ].filter(Boolean).join("\n");

    const { summary, strengths, gaps, recommendations } = await aiService.generateScheduleHealth({
      studioName, scheduleContext, coverageGaps,
    }) as { summary: string; strengths: string[]; gaps: string[]; recommendations: string[] };

    sendJsonResponse(req, res, 200, { summary, strengths, gaps, recommendations, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating schedule health:", error);
    handleError(req, res, error);
  }
});

app.get("/churn-scores", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [studentsSnap, attendanceSnap] = await Promise.all([
      db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).where("isRemoved", "==", false).get(),
    ]);

    // Build per-student attendance maps: lastDate, recent30 count, prior30 count
    const lastDateMap = new Map<string, Date>();
    const recent30Map = new Map<string, number>();
    const prior30Map = new Map<string, number>();

    attendanceSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const sid = d["studentId"] as string | undefined;
      if (!sid) return;
      const ts = d["classInstanceDate"] as { toDate?: () => Date } | null;
      const date = ts?.toDate ? ts.toDate() : null;
      if (!date) return;

      const existing = lastDateMap.get(sid);
      if (!existing || date > existing) lastDateMap.set(sid, date);

      if (date >= thirtyDaysAgo) {
        recent30Map.set(sid, (recent30Map.get(sid) || 0) + 1);
      } else if (date >= sixtyDaysAgo) {
        prior30Map.set(sid, (prior30Map.get(sid) || 0) + 1);
      }
    });

    const scores: Array<{
      studentId: string;
      name: string;
      churnScore: number;
      lastAttendedAt: string | null;
      daysSinceLast: number | null;
      credits: number;
      factors: string[];
    }> = [];

    studentsSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const sid = doc.id;
      const name = `${d["firstName"] || ""} ${d["lastName"] || ""}`.trim() || "Unknown";
      const credits = (d["credits"] as number) ?? 0;
      const lastDate = lastDateMap.get(sid) ?? null;
      const recent30 = recent30Map.get(sid) ?? 0;
      const prior30 = prior30Map.get(sid) ?? 0;
      const neverAttended = !lastDate;

      const daysSinceLast = lastDate
        ? Math.floor((now.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000))
        : null;

      // Deterministic score
      let score: number;
      const factors: string[] = [];

      if (neverAttended) {
        score = 10;
        factors.push("Never attended a class");
      } else if (daysSinceLast! >= 90) {
        score = 9;
        factors.push(`Last attended ${daysSinceLast} days ago`);
      } else if (daysSinceLast! >= 60) {
        score = 8;
        factors.push(`Last attended ${daysSinceLast} days ago`);
      } else if (daysSinceLast! >= 30) {
        score = 6;
        factors.push(`Last attended ${daysSinceLast} days ago`);
      } else if (daysSinceLast! >= 14) {
        score = 4;
        factors.push(`Last attended ${daysSinceLast} days ago`);
      } else if (daysSinceLast! >= 7) {
        score = 2;
        factors.push(`Last attended ${daysSinceLast} days ago`);
      } else {
        score = 1;
        factors.push("Recently active");
      }

      // Modifiers
      if (credits > 0) {
        factors.push(`${credits} unused credit${credits !== 1 ? "s" : ""}`);
        if (score > 1) score -= 1; // unused credits = some re-engagement leverage
      }
      const declining = prior30 > 0 && recent30 < prior30;
      if (declining && score < 10) {
        score += 1;
        factors.push("Attendance frequency declining");
      }

      scores.push({
        studentId: sid,
        name,
        churnScore: Math.min(10, Math.max(1, score)),
        lastAttendedAt: lastDate ? lastDate.toISOString() : null,
        daysSinceLast,
        credits,
        factors,
      });
    });

    scores.sort((a, b) => b.churnScore - a.churnScore);

    const highRisk = scores.filter((s) => s.churnScore >= 7).length;
    const mediumRisk = scores.filter((s) => s.churnScore >= 4 && s.churnScore < 7).length;
    const lowRisk = scores.filter((s) => s.churnScore < 4).length;

    sendJsonResponse(req, res, 200, {
      students: scores,
      summary: { highRisk, mediumRisk, lowRisk, total: scores.length },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error generating churn scores:", error);
    handleError(req, res, error);
  }
});

app.get("/student-ltv", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const [studentsSnap, purchasesSnap, cashPurchasesSnap, studioDoc] = await Promise.all([
      db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("cashPurchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists
      ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio")
      : "Your Studio";

    // Build student name + join date map
    const studentMeta = new Map<string, { name: string; joinedAt: Date | null }>();
    studentsSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const ts = d["createdAt"] as { toDate?: () => Date } | null;
      studentMeta.set(doc.id, {
        name: `${d["firstName"] || ""} ${d["lastName"] || ""}`.trim() || "Unknown",
        joinedAt: ts?.toDate ? ts.toDate() : null,
      });
    });

    // Aggregate spend per student
    const spendMap = new Map<string, { total: number; firstPurchase: Date | null }>();
    const processDoc = (d: Record<string, unknown>) => {
      if (d["status"] && d["status"] !== "completed") return;
      const sid = d["studentId"] as string | undefined;
      if (!sid || !studentMeta.has(sid)) return;
      const ts = d["createdAt"] as { toDate?: () => Date } | null;
      const purchaseDate = ts?.toDate ? ts.toDate() : null;
      const amount = (d["price"] as number) ?? (d["amount"] as number) ?? 0;
      if (!spendMap.has(sid)) spendMap.set(sid, { total: 0, firstPurchase: null });
      const entry = spendMap.get(sid)!;
      entry.total += amount;
      if (purchaseDate && (!entry.firstPurchase || purchaseDate < entry.firstPurchase)) {
        entry.firstPurchase = purchaseDate;
      }
    };
    purchasesSnap.forEach((doc) => processDoc(doc.data() as Record<string, unknown>));
    cashPurchasesSnap.forEach((doc) => processDoc(doc.data() as Record<string, unknown>));

    const now = new Date();
    const ltvEntries: Array<{
      studentId: string;
      name: string;
      totalSpent: number;
      monthsAsCustomer: number;
      avgMonthlySpend: number;
      projected12Month: number;
    }> = [];

    studentMeta.forEach((meta, sid) => {
      const spend = spendMap.get(sid);
      const totalSpent = spend?.total ?? 0;
      const firstDate = spend?.firstPurchase ?? meta.joinedAt ?? null;
      const monthsAsCustomer = firstDate
        ? Math.max(1, Math.round((now.getTime() - firstDate.getTime()) / (30 * 24 * 60 * 60 * 1000)))
        : 1;
      const avgMonthlySpend = totalSpent / monthsAsCustomer;
      const projected12Month = avgMonthlySpend * 12;
      ltvEntries.push({ studentId: sid, name: meta.name, totalSpent, monthsAsCustomer, avgMonthlySpend, projected12Month });
    });

    ltvEntries.sort((a, b) => b.totalSpent - a.totalSpent);

    const totalStudents = ltvEntries.length;
    const avgLTV = totalStudents > 0
      ? ltvEntries.reduce((sum, e) => sum + e.totalSpent, 0) / totalStudents
      : 0;

    if (totalStudents === 0) {
      return sendJsonResponse(req, res, 200, {
        students: [], avgLTV: 0, summary: "No student data available yet.",
        insights: [], generatedAt: new Date().toISOString(),
      });
    }

    const { summary, insights } = await aiService.generateStudentLTVInsights({
      studioName, topStudents: ltvEntries.slice(0, 10), avgLTV, totalStudents,
    }) as { summary: string; insights: string[] };

    sendJsonResponse(req, res, 200, {
      students: ltvEntries,
      avgLTV,
      summary,
      insights,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error generating student LTV:", error);
    handleError(req, res, error);
  }
});

app.get("/promo-triggers", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const now = new Date();
    const twentyEightDaysAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

    const [classesSnap, attendanceSnap, studioDoc] = await Promise.all([
      db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
      db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).where("isRemoved", "==", false).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    const studioName = studioDoc.exists
      ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio")
      : "Your Studio";

    // Week boundaries (W1=most recent)
    const weekBoundaries = [0, 1, 2, 3, 4].map((i) => new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000));

    // Count check-ins per class per week
    const weeklyMap = new Map<string, number[]>(); // classId -> [w1, w2, w3, w4]
    classesSnap.forEach((doc) => weeklyMap.set(doc.id, [0, 0, 0, 0]));

    attendanceSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const cid = d["classId"] as string | undefined;
      if (!cid || !weeklyMap.has(cid)) return;
      const ts = d["classInstanceDate"] as { toDate?: () => Date } | null;
      const date = ts?.toDate ? ts.toDate() : null;
      if (!date || date < twentyEightDaysAgo) return;
      const weekCounts = weeklyMap.get(cid);
      if (weekCounts) {
        for (let w = 0; w < 4; w++) {
          if (date < weekBoundaries[w]! && date >= weekBoundaries[w + 1]!) {
            weekCounts[w] = (weekCounts[w] ?? 0) + 1;
            break;
          }
        }
      }
    });

    const underperforming: Array<{
      classId: string;
      name: string;
      genre: string;
      dayOfWeek: string;
      startTime: string;
      maxCapacity: number;
      weeklyFillRates: number[];
      avgFillRate: number;
    }> = [];

    classesSnap.forEach((doc) => {
      const c = doc.data() as Record<string, unknown>;
      const maxCapacity = (c["maxCapacity"] as number) || 20;
      const weekly = weeklyMap.get(doc.id) || [0, 0, 0, 0];
      // 1 session per week
      const weeklyFillRates = weekly.map((count) => Math.min(100, Math.round((count / maxCapacity) * 100)));
      const weeksBelow40 = weeklyFillRates.filter((r) => r < 40).length;
      if (weeksBelow40 >= 2) {
        const avgFillRate = Math.round(weeklyFillRates.reduce((a, b) => a + b, 0) / weeklyFillRates.length);
        underperforming.push({
          classId: doc.id,
          name: c["name"] as string,
          genre: (c["danceGenre"] as string) || "General",
          dayOfWeek: (c["dayOfWeek"] as string) || "TBD",
          startTime: (c["startTime"] as string) || "TBD",
          maxCapacity,
          weeklyFillRates,
          avgFillRate,
        });
      }
    });

    if (underperforming.length === 0) {
      return sendJsonResponse(req, res, 200, {
        triggers: [],
        message: "No underperforming classes detected. All classes have healthy fill rates.",
        generatedAt: new Date().toISOString(),
      });
    }

    const { triggers } = await aiService.generatePromoTriggerSuggestions({ studioName, underperformingClasses: underperforming }) as {
      triggers: Array<{ classId: string; suggestion: string; urgency: "high" | "medium" | "low" }>;
    };

    // Merge trigger suggestions back with class metadata
    const enriched = triggers.map((t) => {
      const cls = underperforming.find((c) => c.classId === t.classId);
      return { ...t, ...(cls || {}) };
    });

    sendJsonResponse(req, res, 200, { triggers: enriched, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating promo triggers:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const ai = functions.https.onRequest(app);
