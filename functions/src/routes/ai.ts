import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import * as aiService from "../services/ai.service";
import * as insightsService from "../services/insights.service";
import * as insightsDataService from "../services/insights-data.service";
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

    const dashStats = await attendanceService.getDashboardStats(studioOwnerId, "month") as Record<string, unknown>;
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
      attendanceService.getDashboardStats(studioOwnerId, "month") as Promise<Record<string, unknown>>,
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

    const input = await insightsDataService.buildInstructorPerformanceInput(studioOwnerId);
    if (!input) {
      return sendJsonResponse(req, res, 200, {
        summary: "No instructor data is available yet. Add instructors and track attendance to see performance insights.",
        instructorInsights: [],
        generatedAt: new Date().toISOString(),
      });
    }

    const { summary, instructorInsights } = await aiService.generateInstructorPerformance(
      input as unknown as Parameters<typeof aiService.generateInstructorPerformance>[0]
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

    const input = await insightsDataService.buildClassDemandInput(studioOwnerId);
    if (!input) {
      return sendJsonResponse(req, res, 200, {
        summary: "No active classes found. Add classes to see demand analysis.",
        classes: [],
        generatedAt: new Date().toISOString(),
      });
    }

    const { summary, classes: classInsights } = await aiService.generateClassDemandAnalysis(
      input as unknown as Parameters<typeof aiService.generateClassDemandAnalysis>[0]
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

    const input = await insightsDataService.buildRevenueForecastInput(studioOwnerId);
    if (!input) {
      return sendJsonResponse(req, res, 200, {
        forecast: "No purchase history is available yet. Once students start purchasing packages, AI will be able to forecast revenue trends.",
        projectedRevenue: { low: 0, mid: 0, high: 0 },
        drivers: [],
        risks: ["No historical data available"],
        generatedAt: new Date().toISOString(),
      });
    }

    const { forecast, projectedRevenue, drivers, risks } = await aiService.generateRevenueForecast(input) as {
      forecast: string; projectedRevenue: Record<string, number>; drivers: string[]; risks: string[];
    };

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

    const input = await insightsDataService.buildScheduleHealthInput(studioOwnerId);

    const { summary, strengths, gaps, recommendations } = await aiService.generateScheduleHealth(input) as {
      summary: string; strengths: string[]; gaps: string[]; recommendations: string[];
    };

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

    const input = await insightsDataService.buildStudentLTVInput(studioOwnerId);
    if (!input) {
      return sendJsonResponse(req, res, 200, {
        students: [], avgLTV: 0, summary: "No student data available yet.",
        insights: [], generatedAt: new Date().toISOString(),
      });
    }

    const { summary, insights } = await aiService.generateStudentLTVInsights({
      studioName: input.studioName, topStudents: input.topStudents, avgLTV: input.avgLTV, totalStudents: input.totalStudents,
    }) as { summary: string; insights: string[] };

    sendJsonResponse(req, res, 200, {
      students: input.allEntries,
      avgLTV: input.avgLTV,
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

    const input = await insightsDataService.buildPromoTriggerInput(studioOwnerId);
    if (!input) {
      return sendJsonResponse(req, res, 200, {
        triggers: [],
        message: "No underperforming classes detected. All classes have healthy fill rates.",
        generatedAt: new Date().toISOString(),
      });
    }

    const { triggers } = await aiService.generatePromoTriggerSuggestions(input) as {
      triggers: Array<{ classId: string; suggestion: string; urgency: "high" | "medium" | "low" }>;
    };

    // Merge trigger suggestions back with class metadata
    const enriched = triggers.map((t) => {
      const cls = input.underperformingClasses.find((c) => c.classId === t.classId);
      return { ...t, ...(cls || {}) };
    });

    sendJsonResponse(req, res, 200, { triggers: enriched, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error generating promo triggers:", error);
    handleError(req, res, error);
  }
});

// POST /booking-message
app.post("/booking-message", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { studentName, instructorName, date, startTime, endTime, notes } = (req.body || {}) as {
      studentName?: unknown;
      instructorName?: unknown;
      date?: unknown;
      startTime?: unknown;
      endTime?: unknown;
      notes?: unknown;
    };
    if (!studentName || typeof studentName !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "studentName is required");
    }
    if (!instructorName || typeof instructorName !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "instructorName is required");
    }
    if (!date || typeof date !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "date is required");
    }
    if (!startTime || typeof startTime !== "string" || !endTime || typeof endTime !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "startTime and endTime are required");
    }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();
    const studioDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    const { message } = await aiService.generateBookingConfirmationMessage({
      studioName,
      studentName: String(studentName).slice(0, 100),
      instructorName: String(instructorName).slice(0, 100),
      date: String(date).slice(0, 50),
      startTime: String(startTime).slice(0, 20),
      endTime: String(endTime).slice(0, 20),
      notes: notes ? String(notes).slice(0, 500) : undefined,
    }) as { message: string };

    sendJsonResponse(req, res, 200, { message });
  } catch (error) {
    console.error("Error generating booking message:", error);
    handleError(req, res, error);
  }
});

// POST /suggest-automations
app.post("/suggest-automations", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const db = getFirestore();

    // Fetch studio name
    const studioDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioName = studioDoc.exists ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string || "Your Studio") : "Your Studio";

    // Fetch existing automation rules
    const rulesSnap = await db.collection("campaignRules")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    const existingRules = rulesSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        name: String(data["name"] || ""),
        triggerType: String(data["triggerType"] || ""),
        actionType: String(data["actionType"] || ""),
      };
    });

    // Fetch engagement data for context
    const engagementData = (await insightsService.getEngagementData(studioOwnerId)) as unknown as {
      atRisk: Array<{ daysSinceAttendance: number | null; credits: number; neverAttended?: boolean }>;
      mostActive: unknown[];
      stats: { totalStudents: number; atRiskCount: number; studentsWithCredits: number };
    };
    const { atRisk, stats } = engagementData;

    const neverAttended = atRisk?.filter((s) => s.daysSinceAttendance == null || s.neverAttended).length ?? 0;
    const daysList = atRisk
      ?.map((s) => s.daysSinceAttendance)
      .filter((d): d is number => d != null);
    const avgDays = daysList && daysList.length > 0
      ? daysList.reduce((a, b) => a + b, 0) / daysList.length
      : null;

    const { suggestions, summary } = await aiService.generateAutomationSuggestions({
      studioName,
      existingRules,
      atRiskStudentCount: stats?.atRiskCount ?? 0,
      totalStudents: stats?.totalStudents ?? 0,
      studentsWithCredits: stats?.studentsWithCredits ?? 0,
      studentsNeverAttended: neverAttended,
      avgDaysSinceAttendance: avgDays,
    }) as { suggestions: import("../services/ai.service").AutomationSuggestion[]; summary: string };

    sendJsonResponse(req, res, 200, { suggestions, summary, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error suggesting automations:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const ai = functions.https.onRequest(app);
