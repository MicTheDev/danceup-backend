import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import attendanceService from "../services/attendance.service";
import classesService from "../services/classes.service";
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
app.use(express.urlencoded({ extended: true }));

function parseDate(dateString: string | undefined): Date | null {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

async function notifyKioskSession(params: {
  kioskSessionId: string;
  attendanceId: string;
  studentId: string;
  classId: string;
  studioOwnerId: string;
}): Promise<void> {
  const db = getFirestore();
  const sessionRef = db.collection("kioskSessions").doc(params.kioskSessionId);
  const sessionDoc = await sessionRef.get();
  if (!sessionDoc.exists) return;

  const sessionData = sessionDoc.data() as Record<string, unknown>;
  if (!sessionData["active"] || sessionData["studioOwnerId"] !== params.studioOwnerId) return;

  // Fetch student and class names for the notification payload
  const [studentDoc, classDoc] = await Promise.all([
    db.collection("students").doc(params.studentId).get(),
    db.collection("classes").doc(params.classId).get(),
  ]);

  const student = studentDoc.data() as Record<string, unknown> | undefined;
  const cls = classDoc.data() as Record<string, unknown> | undefined;

  const firstName = (student?.["firstName"] as string) || "";
  const lastName = (student?.["lastName"] as string) || "";
  const initials = `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
  const className = (cls?.["name"] as string) || "Unknown class";

  const checkInEvent = {
    attendanceId: params.attendanceId,
    studentId: params.studentId,
    studentFirstName: firstName,
    studentLastName: lastName,
    studentInitials: initials,
    classId: params.classId,
    className,
    checkedInAt: new Date().toISOString(),
  };

  await sessionRef.update({
    lastCheckIn: checkInEvent,
    checkIns: admin.firestore.FieldValue.arrayUnion(checkInEvent),
  });
}

app.get("/lost-revenue", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const stats = await attendanceService.getLostRevenueStats(studioOwnerId);
    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting lost revenue stats:", error);
    handleError(req, res, error);
  }
});

app.get("/dashboard-stats", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const stats = await attendanceService.getDashboardStats(studioOwnerId);
    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting dashboard stats:", error);
    handleError(req, res, error);
  }
});

app.get("/classes", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const startDate = parseDate(req.query["startDate"] as string | undefined);
    const endDate = parseDate(req.query["endDate"] as string | undefined);
    const stats = await attendanceService.getClassAttendanceStats(studioOwnerId, startDate, endDate);
    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting class attendance stats:", error);
    handleError(req, res, error);
  }
});

app.get("/workshops", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const startDate = parseDate(req.query["startDate"] as string | undefined);
    const endDate = parseDate(req.query["endDate"] as string | undefined);
    const stats = await attendanceService.getWorkshopAttendanceStats(studioOwnerId, startDate, endDate);
    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting workshop attendance stats:", error);
    handleError(req, res, error);
  }
});

app.get("/events", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const startDate = parseDate(req.query["startDate"] as string | undefined);
    const endDate = parseDate(req.query["endDate"] as string | undefined);
    const stats = await attendanceService.getEventAttendanceStats(studioOwnerId, startDate, endDate);
    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting event attendance stats:", error);
    handleError(req, res, error);
  }
});

app.get("/students/:studentId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const studentId = req.params["studentId"] as string;
    const limitStr = req.query["limit"] as string | undefined;
    const after = (req.query["after"] as string) || null;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const result = await attendanceService.getAttendanceRecordsByStudent(studentId, studioOwnerId, { limit, after });

    sendJsonResponse(req, res, 200, {
      data: result.records,
      pagination: {
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        limit: result.records.length,
      },
    });
  } catch (error) {
    console.error("Error getting attendance records for student:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("does not belong") || msg?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", msg);
    }
    handleError(req, res, error);
  }
});

app.get("/classes/:classId/attendees", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const attendees = await attendanceService.getClassAttendees(studioOwnerId, req.params["classId"] as string);
    sendJsonResponse(req, res, 200, attendees);
  } catch (error) {
    console.error("Error getting class attendees:", error);
    handleError(req, res, error);
  }
});

app.get("/workshops/:workshopId/attendees", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const attendees = await attendanceService.getWorkshopAttendees(studioOwnerId, req.params["workshopId"] as string);
    sendJsonResponse(req, res, 200, attendees);
  } catch (error) {
    console.error("Error getting workshop attendees:", error);
    handleError(req, res, error);
  }
});

app.get("/events/:eventId/attendees", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const attendees = await attendanceService.getEventAttendees(studioOwnerId, req.params["eventId"] as string);
    sendJsonResponse(req, res, 200, attendees);
  } catch (error) {
    console.error("Error getting event attendees:", error);
    handleError(req, res, error);
  }
});

app.get("/classes/:classId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const startDate = parseDate(req.query["startDate"] as string | undefined);
    const endDate = parseDate(req.query["endDate"] as string | undefined);
    const stats = await attendanceService.getClassSpecificAttendanceStats(studioOwnerId, req.params["classId"] as string, startDate, endDate);
    sendJsonResponse(req, res, 200, stats);
  } catch (error) {
    console.error("Error getting class-specific attendance stats:", error);
    handleError(req, res, error);
  }
});

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const startDate = parseDate(req.query["startDate"] as string | undefined);
    const endDate = parseDate(req.query["endDate"] as string | undefined);

    const [classStats, workshopStats, eventStats] = await Promise.all([
      attendanceService.getClassAttendanceStats(studioOwnerId, startDate, endDate),
      attendanceService.getWorkshopAttendanceStats(studioOwnerId, startDate, endDate),
      attendanceService.getEventAttendanceStats(studioOwnerId, startDate, endDate),
    ]);

    sendJsonResponse(req, res, 200, { classes: classStats, workshops: workshopStats, events: eventStats });
  } catch (error) {
    console.error("Error getting attendance stats:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const body = req.body as Record<string, unknown>;

    if (!body["studentId"] && !body["studentAuthUid"]) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Either studentId or studentAuthUid is required");
    }

    if (!body["checkedInBy"] || !["studio", "student"].includes(body["checkedInBy"] as string)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "checkedInBy must be 'studio' or 'student'");
    }

    let studentId = body["studentId"] as string | undefined;
    if (!studentId && body["studentAuthUid"]) {
      const resolved = await attendanceService.getStudentIdByAuthUid(body["studentAuthUid"] as string);
      if (!resolved) {
        return sendErrorResponse(req, res, 404, "Not Found", "Student not found for the provided authUid");
      }
      studentId = resolved;
    }

    let studioOwnerId: string | null;
    if (body["checkedInBy"] === "student") {
      const db = getFirestore();
      const studentRef = db.collection("students").doc(studentId as string);
      const studentDoc = await studentRef.get();

      if (!studentDoc.exists) {
        return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
      }

      const studentData = studentDoc.data() as Record<string, unknown>;
      studioOwnerId = studentData["studioOwnerId"] as string;

      if (!studioOwnerId) {
        return sendErrorResponse(req, res, 400, "Validation Error", "Student record does not have a studio owner ID");
      }

      if (studentData["authUid"] !== user.uid) {
        return sendErrorResponse(req, res, 403, "Access Denied", "You can only check in as yourself");
      }
    } else {
      studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
      if (!studioOwnerId) {
        return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
      }
    }

    const idCount = [body["classId"], body["workshopId"], body["eventId"]].filter(Boolean).length;
    if (idCount !== 1) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Exactly one of classId, workshopId, or eventId must be provided");
    }

    if (!body["classInstanceDate"]) {
      return sendErrorResponse(req, res, 400, "Validation Error", "classInstanceDate is required");
    }

    const attendanceData = {
      studentId: studentId as string,
      classId: body["classId"] as string | null | undefined,
      workshopId: body["workshopId"] as string | null | undefined,
      eventId: body["eventId"] as string | null | undefined,
      classInstanceDate: body["classInstanceDate"] as string,
      checkedInBy: body["checkedInBy"] as "studio" | "student",
      checkedInById: body["checkedInById"] as string | undefined,
      checkedInAt: body["checkedInAt"] as admin.firestore.FieldValue | admin.firestore.Timestamp | undefined,
    };

    const attendanceId = await attendanceService.createAttendanceRecord(attendanceData, studioOwnerId as string);

    // Fire-and-forget: push check-in event to any paired kiosk watch session
    const kioskSessionId = body["kioskSessionId"] as string | undefined;
    if (kioskSessionId && body["classId"]) {
      notifyKioskSession({
        kioskSessionId,
        attendanceId,
        studentId: studentId as string,
        classId: body["classId"] as string,
        studioOwnerId: studioOwnerId as string,
      }).catch((err: Error) => console.error("[KioskSession] notify error:", err.message));
    }

    sendJsonResponse(req, res, 201, { id: attendanceId, message: "Attendance record created successfully" });
  } catch (error) {
    console.error("Error creating attendance record:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("does not belong") || msg?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", msg);
    }
    if (msg?.includes("required") || msg?.includes("must be")) {
      return sendErrorResponse(req, res, 400, "Validation Error", msg);
    }
    if (msg?.includes("already checked in")) return sendErrorResponse(req, res, 409, "Conflict", msg);
    if (msg?.includes("Insufficient credits") || msg?.includes("No available credits")) {
      return sendErrorResponse(req, res, 402, "Payment Required", msg);
    }
    handleError(req, res, error);
  }
});

app.delete("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await attendanceService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const recordData = await attendanceService.getAttendanceRecordById(req.params["id"] as string, studioOwnerId);
    await attendanceService.removeAttendanceRecord(req.params["id"] as string, studioOwnerId);

    if (recordData && recordData["classId"]) {
      classesService.notifyFirstWaiting(
        recordData["classId"] as string,
        recordData["classInstanceDate"] as string,
        studioOwnerId,
      ).catch((err: Error) => console.error("[Waitlist] notifyFirstWaiting error:", err.message));
    }

    sendJsonResponse(req, res, 200, { message: "Attendance record removed successfully", creditRestored: true });
  } catch (error) {
    console.error("Error removing attendance record:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("does not belong") || msg?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", msg);
    }
    if (msg?.includes("already removed")) return sendErrorResponse(req, res, 409, "Conflict", msg);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const attendance = functions.https.onRequest(app);
