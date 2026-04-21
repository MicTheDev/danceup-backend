import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import studiosService from "../services/studios.service";
import studioEnrollmentService from "../services/studio-enrollment.service";
import notificationsService from "../services/notifications.service";
import studentsService from "../services/students.service";
import packagesService from "../services/packages.service";
import classesService from "../services/classes.service";
import { verifyToken } from "../utils/auth";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  next();
});

app.use(cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

app.get("/public", async (req, res) => {
  try {
    const filters = {
      city: (req.query["city"] as string) || null,
      state: (req.query["state"] as string) || null,
      studioName: (req.query["studioName"] as string) || null,
    };
    const studios = await studiosService.getAllPublicStudios(filters);
    sendJsonResponse(req, res, 200, studios);
  } catch (error) {
    console.error("Error getting public studios:", error);
    handleError(req, res, error);
  }
});

app.get("/public/:id", async (req, res) => {
  try {
    const studioData = await studiosService.getPublicStudioById(req.params["id"] as string);
    if (!studioData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio not found");
    }
    sendJsonResponse(req, res, 200, studioData);
  } catch (error) {
    console.error("Error getting public studio:", error);
    handleError(req, res, error);
  }
});

app.get("/public/:id/packages", async (req, res) => {
  try {
    const packages = await packagesService.getPackages(req.params["id"] as string);
    const activePackages = packages.filter((pkg: Record<string, unknown>) => pkg["isActive"]);
    sendJsonResponse(req, res, 200, activePackages);
  } catch (error) {
    console.error("Error getting studio packages:", error);
    handleError(req, res, error);
  }
});

app.get("/public/:id/classes", async (req, res) => {
  try {
    const id = req.params["id"] as string;
    const classes = await classesService.getClasses(id);
    const activeClasses = classes.filter((cls: Record<string, unknown>) => cls["isActive"]);
    const studioData = await studiosService.getPublicStudioById(id);

    const enrichedClasses = activeClasses.map((cls: Record<string, unknown>) => ({
      ...cls,
      studio: studioData ? {
        id: (studioData as unknown as Record<string, unknown>)["id"],
        name: (studioData as unknown as Record<string, unknown>)["studioName"],
        city: (studioData as unknown as Record<string, unknown>)["city"],
        state: (studioData as unknown as Record<string, unknown>)["state"],
        addressLine1: (studioData as unknown as Record<string, unknown>)["studioAddressLine1"],
        addressLine2: (studioData as unknown as Record<string, unknown>)["studioAddressLine2"] || null,
        zip: (studioData as unknown as Record<string, unknown>)["zip"],
      } : null,
    }));

    sendJsonResponse(req, res, 200, enrichedClasses);
  } catch (error) {
    console.error("Error getting studio classes:", error);
    handleError(req, res, error);
  }
});

app.post("/:studioId/enroll", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioId = req.params["studioId"] as string;
    const studentId = await studioEnrollmentService.enrollStudent(studioId, user.uid);

    const studentData = await studentsService.getStudentById(studentId, studioId) as Record<string, unknown> | null;
    const firstName = (studentData?.["firstName"] as string) || "A student";
    const lastName = (studentData?.["lastName"] as string) || "";
    const studentName = `${firstName} ${lastName}`.trim();

    await notificationsService.createNotification(
      studioId,
      null,
      "student_enrollment",
      "New Student Enrollment",
      `${studentName} has joined your studio as a student`,
      studentId,
    );

    sendJsonResponse(req, res, 200, { message: "Successfully enrolled as student", studentId });
  } catch (error) {
    console.error("Error enrolling student:", error);
    const msg = (error as Error).message;
    if (msg?.includes("already enrolled")) {
      return sendErrorResponse(req, res, 400, "Bad Request", msg);
    }
    if (msg?.includes("profile not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", msg);
    }
    handleError(req, res, error);
  }
});

app.post("/:studioId/unenroll", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioId = req.params["studioId"] as string;
    await studioEnrollmentService.unenrollStudent(studioId, user.uid);

    sendJsonResponse(req, res, 200, { message: "Successfully unenrolled from studio" });
  } catch (error) {
    console.error("Error unenrolling student:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", msg);
    }
    handleError(req, res, error);
  }
});

app.get("/:studioId/enrollment-status", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioId = req.params["studioId"] as string;
    const isEnrolled = await studioEnrollmentService.checkEnrollmentStatus(studioId, user.uid);

    sendJsonResponse(req, res, 200, { isEnrolled });
  } catch (error) {
    console.error("Error checking enrollment status:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const studios = functions.https.onRequest(app);
