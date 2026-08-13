import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import instructorLinkingService from "../services/instructor-linking.service";
import studentsService from "../services/students.service";
import classesService from "../services/classes.service";
import bookingsService from "../services/bookings.service";
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

if (!admin.apps.length) {
  admin.initializeApp();
}

const app = express();

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

/** Every route here needs the caller resolved to (studioOwnerId, instructorId) — this is the ACL, not a Firestore rule. */
async function requireInstructorLink(req: Request, res: Response): Promise<{ uid: string; studioOwnerId: string; instructorId: string } | null> {
  let user;
  try {
    user = await verifyToken(req);
  } catch (authError) {
    handleError(req, res, authError);
    return null;
  }

  const requestedStudioOwnerId = req.query["studioOwnerId"] as string | undefined;
  const link = await instructorLinkingService.resolveLink(user.uid, requestedStudioOwnerId);
  if (!link) {
    sendErrorResponse(
      req, res, 403, "Access Denied",
      requestedStudioOwnerId
        ? "You are not linked as an instructor at this studio"
        : "You are not linked as an instructor at any studio, or teach at more than one and must specify studioOwnerId",
    );
    return null;
  }

  return { uid: user.uid, ...link };
}

async function enrichBookingsWithStudentNames(
  bookings: Array<Record<string, unknown> & { id: string }>,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  const db = getFirestore();
  return Promise.all(bookings.map(async (booking) => {
    const studentId = booking["studentId"] as string | undefined;
    if (!studentId) return { ...booking, studentName: null };
    try {
      const profileDoc = await db.collection("usersStudentProfiles").doc(studentId).get();
      const source = profileDoc.exists ? profileDoc.data() : (await db.collection("students").doc(studentId).get()).data();
      const studentName = source
        ? `${(source as Record<string, unknown>)["firstName"] ?? ""} ${(source as Record<string, unknown>)["lastName"] ?? ""}`.trim()
        : null;
      return { ...booking, studentName: studentName || null };
    } catch {
      return { ...booking, studentName: null };
    }
  }));
}

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** GET /me — every studio this account is linked as an instructor at. */
app.get("/me", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const links = await instructorLinkingService.getInstructorLinksForAuthUid(user.uid);
    const db = getFirestore();
    const instructorLinks = await Promise.all(
      Object.entries(links).map(async ([studioOwnerId, link]) => {
        let studioName = "Studio";
        try {
          const studioDoc = await db.collection("users").doc(studioOwnerId).get();
          if (studioDoc.exists) {
            studioName = ((studioDoc.data() as Record<string, unknown>)["studioName"] as string) || studioName;
          }
        } catch { /* fall back to default label */ }
        return { studioOwnerId, instructorId: link.instructorId, studioName };
      }),
    );

    sendJsonResponse(req, res, 200, { instructorLinks });
  } catch (error) {
    console.error("Error getting instructor links:", error);
    handleError(req, res, error);
  }
});

/** GET /schedule?studioOwnerId= — this instructor's own teaching schedule: their classes + their upcoming bookings. */
app.get("/schedule", async (req, res) => {
  try {
    const link = await requireInstructorLink(req, res);
    if (!link) return;

    const allClasses = await classesService.getClasses(link.studioOwnerId);
    const myClasses = allClasses.filter((cls) => {
      const instructorIds = (cls["instructorIds"] as string[] | undefined) ?? [];
      return cls["isActive"] && instructorIds.includes(link.instructorId);
    });

    const bookings = await bookingsService.getBookingsByInstructor(link.instructorId, todayPlusDays(0), todayPlusDays(30));
    const enrichedBookings = await enrichBookingsWithStudentNames(bookings);

    sendJsonResponse(req, res, 200, {
      studioOwnerId: link.studioOwnerId,
      instructorId: link.instructorId,
      classes: myClasses,
      bookings: enrichedBookings,
    });
  } catch (error) {
    console.error("Error getting instructor schedule:", error);
    handleError(req, res, error);
  }
});

/** GET /privates?studioOwnerId= — this instructor's full private-lesson booking list (not just the near-term schedule slice). */
app.get("/privates", async (req, res) => {
  try {
    const link = await requireInstructorLink(req, res);
    if (!link) return;

    const bookings = await bookingsService.getBookingsByInstructor(link.instructorId, todayPlusDays(-180), todayPlusDays(180));
    const enrichedBookings = await enrichBookingsWithStudentNames(bookings);

    sendJsonResponse(req, res, 200, { bookings: enrichedBookings });
  } catch (error) {
    console.error("Error getting instructor privates:", error);
    handleError(req, res, error);
  }
});

/** GET /students?studioOwnerId= — read-only, the full studio roster (not filtered to this instructor's own students). */
app.get("/students", async (req, res) => {
  try {
    const link = await requireInstructorLink(req, res);
    if (!link) return;

    const result = await studentsService.getStudents(link.studioOwnerId, { limit: 200 });
    sendJsonResponse(req, res, 200, result.students);
  } catch (error) {
    console.error("Error getting studio students for instructor:", error);
    handleError(req, res, error);
  }
});

/** GET /teams?studioOwnerId= — read-only, all performance teams at the studio. */
app.get("/teams", async (req, res) => {
  try {
    const link = await requireInstructorLink(req, res);
    if (!link) return;

    const db = getFirestore();
    const snapshot = await db.collection("performanceTeams")
      .where("studioOwnerId", "==", link.studioOwnerId)
      .orderBy("createdAt", "desc")
      .get();

    const teams = snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        name: data["name"],
        description: data["description"] || null,
        imageUrl: data["imageUrl"] || null,
        memberIds: data["memberIds"] || [],
        memberCount: ((data["memberIds"] as unknown[]) || []).length,
        practiceSchedule: data["practiceSchedule"] || [],
      };
    });

    sendJsonResponse(req, res, 200, teams);
  } catch (error) {
    console.error("Error getting studio teams for instructor:", error);
    handleError(req, res, error);
  }
});

/** GET /classes?studioOwnerId= — read-only, every class at the studio (not just this instructor's own — see /schedule for that). */
app.get("/classes", async (req, res) => {
  try {
    const link = await requireInstructorLink(req, res);
    if (!link) return;

    const classes = await classesService.getClasses(link.studioOwnerId);
    sendJsonResponse(req, res, 200, classes.filter((cls) => cls["isActive"]));
  } catch (error) {
    console.error("Error getting studio classes for instructor:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const usersinstructor = functions.https.onRequest(app);
