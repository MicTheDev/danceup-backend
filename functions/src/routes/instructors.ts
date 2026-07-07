import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import instructorsService from "../services/instructors.service";
import storageService from "../services/storage.service";
import { logAuditEvent } from "../services/audit.service";
import { verifyToken } from "../utils/auth";
import { validateCreateInstructorPayload, validateUpdateInstructorPayload } from "../utils/validation";
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

const isDevOrEmulator = process.env["NODE_ENV"] === "development" || process.env["FUNCTIONS_EMULATOR"] === "true";

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

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const instructors = await instructorsService.getInstructors(studioOwnerId);
    sendJsonResponse(req, res, 200, instructors);
  } catch (error) {
    console.error("Error getting instructors:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { photoFile, ...instructorData } = req.body as Record<string, unknown>;

    const validation = validateCreateInstructorPayload(instructorData);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid instructor data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    let photoUrl: string | null = null;
    if (photoFile && typeof photoFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(photoFile);
        const mimeType = storageService.getMimeTypeFromBase64(photoFile);
        const fileName = `instructor-${Date.now()}.${mimeType.split("/")[1]}`;
        photoUrl = await storageService.uploadInstructorPhoto(fileBuffer, fileName, mimeType);
      } catch (imageError) {
        console.error("Error uploading instructor photo:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", (imageError as Error).message || "Failed to upload instructor photo");
      }
    }

    const payload = photoUrl ? { ...instructorData, photoUrl } : instructorData;
    const instructorId = await instructorsService.createInstructor(payload, studioOwnerId);
    logAuditEvent(user.uid, studioOwnerId, "instructor_created", "instructor", instructorId);

    sendJsonResponse(req, res, 201, { id: instructorId, message: "Instructor created successfully" });
  } catch (error) {
    console.error("Error creating instructor:", error);
    handleError(req, res, error);
  }
});

app.get("/options", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const instructors = await instructorsService.getInstructors(studioOwnerId);
    const options = (instructors as Array<Record<string, unknown>>).map((instructor) => ({
      id: instructor["id"],
      name: `${instructor["firstName"] as string} ${instructor["lastName"] as string}`.trim(),
    }));

    sendJsonResponse(req, res, 200, options);
  } catch (error) {
    console.error("Error getting instructor options:", error);
    handleError(req, res, error);
  }
});

app.get("/public/:id", async (req, res) => {
  try {
    const instructorData = await instructorsService.getPublicInstructorById(req.params["id"] as string);
    if (!instructorData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    }
    sendJsonResponse(req, res, 200, instructorData);
  } catch (error) {
    console.error("Error getting public instructor:", error);
    handleError(req, res, error);
  }
});

type DaySlot = { startTime: string; endTime: string };

type DayConfig = {
  day: string;
  available: boolean;
  timeSlots?: DaySlot[];
  startTime?: string;
  endTime?: string;
};

function parseTimeToMinutes(time: string): number {
  const [hourStr, minuteStr] = time.split(":");
  const hour = parseInt(hourStr ?? "0", 10);
  const minute = parseInt(minuteStr ?? "0", 10);
  return hour * 60 + minute;
}

function formatMinutesAsTime(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Resolves "today"/"now" in the studio's local timezone (via lat/lng), matching the
// geo-tz-based timezone handling used by auto-checkin, instead of the server's local time.
function getStudioLocalDateParts(lat: number | undefined, lng: number | undefined): {
  year: number; month: number; day: number; minutes: number;
} {
  let zone: string | undefined;
  if (lat != null && lng != null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { find } = require("geo-tz") as { find: (lat: number, lng: number) => string[] };
      zone = find(lat, lng)[0];
    } catch {
      zone = undefined;
    }
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone ?? "UTC",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    minutes: (get("hour") % 24) * 60 + get("minute"),
  };
}

function getSlotsForDayConfig(dayConfig: DayConfig): DaySlot[] {
  if (dayConfig.timeSlots && dayConfig.timeSlots.length > 0) return dayConfig.timeSlots;
  // Legacy format: expand startTime–endTime range into 1-hour blocks
  if (dayConfig.startTime && dayConfig.endTime) {
    const startMinutes = parseTimeToMinutes(dayConfig.startTime);
    const endMinutes = parseTimeToMinutes(dayConfig.endTime);
    const slots: DaySlot[] = [];
    for (let m = startMinutes; m + 60 <= endMinutes; m += 60) {
      slots.push({
        startTime: formatMinutesAsTime(m),
        endTime: formatMinutesAsTime(m + 60),
      });
    }
    return slots;
  }
  return [];
}

app.get("/public/:id/available-slots", async (req, res) => {
  try {
    const instructorId = req.params["id"] as string;
    const { year: yearStr, month: monthStr } = req.query as { year?: string; month?: string };

    if (!yearStr || !monthStr) {
      return sendErrorResponse(req, res, 400, "Validation Error", "year and month query parameters are required");
    }

    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10); // 1-12
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid year or month");
    }

    const instructor = await instructorsService.getPublicInstructorById(instructorId);
    if (!instructor) return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    if (isDevOrEmulator) {
      console.log(`[available-slots] instructorId=${instructorId} availableForPrivates=${instructor.availability?.availableForPrivates} availabilityType=${typeof instructor.availability?.availability} availabilityLength=${Array.isArray(instructor.availability?.availability) ? (instructor.availability!.availability as unknown[]).length : "N/A"}`);
    }
    if (!instructor.availability?.availableForPrivates) return sendJsonResponse(req, res, 200, {});

    const rawAvailabilityConfig = instructor.availability.availability;
    const availabilityConfig = Array.isArray(rawAvailabilityConfig) ? rawAvailabilityConfig as DayConfig[] : undefined;
    if (!availabilityConfig || availabilityConfig.length === 0) {
      if (isDevOrEmulator) {
        console.log(`[available-slots] Early exit: availabilityConfig=${JSON.stringify(availabilityConfig)}`);
      }
      return sendJsonResponse(req, res, 200, {});
    }
    if (isDevOrEmulator) {
      console.log(`[available-slots] Processing ${availabilityConfig.length} day configs for ${year}-${month}`);
    }

    // Build date range strings
    const pad = (n: number) => String(n).padStart(2, "0");
    const lastDay = new Date(year, month, 0).getDate();
    const startDate = `${year}-${pad(month)}-01`;
    const endDate = `${year}-${pad(month)}-${pad(lastDay)}`;

    const db = getFirestore();

    // Resolve the studio's timezone via its lat/lng so "today"/past-time filtering
    // reflects the studio's local time, not the server's.
    let studioLat: number | undefined;
    let studioLng: number | undefined;
    if (instructor.studioOwnerId) {
      const studioDoc = await db.collection("users").doc(instructor.studioOwnerId).get();
      if (studioDoc.exists) {
        const sd = studioDoc.data() as Record<string, unknown>;
        studioLat = sd["lat"] as number | undefined;
        studioLng = sd["lng"] as number | undefined;
      }
    }
    const studioToday = getStudioLocalDateParts(studioLat, studioLng);

    // Fetch existing confirmed/pending bookings for this instructor this month
    const snapshot = await db.collection("privateLessonBookings")
      .where("instructorId", "==", instructorId)
      .where("date", ">=", startDate)
      .where("date", "<=", endDate)
      .where("status", "in", ["pending", "confirmed"])
      .get();

    // Keyed by startTime only, matching the booking conflict check in bookingsService
    // (createBooking/isTimeSlotAvailable both key conflicts on timeSlot.startTime alone).
    const bookedByDate = new Map<string, Set<string>>();
    snapshot.docs.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const date = d["date"];
      const ts = d["timeSlot"] as Record<string, unknown> | undefined;
      const startTime = ts?.["startTime"];
      if (typeof date !== "string" || typeof startTime !== "string") return;
      if (!bookedByDate.has(date)) bookedByDate.set(date, new Set());
      bookedByDate.get(date)!.add(startTime);
    });

    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    const result: Record<string, DaySlot[]> = {};
    for (let day = 1; day <= lastDay; day++) {
      const isPastDate = year < studioToday.year ||
        (year === studioToday.year && month < studioToday.month) ||
        (year === studioToday.year && month === studioToday.month && day < studioToday.day);
      if (isPastDate) continue;

      const dateStr = `${year}-${pad(month)}-${pad(day)}`;
      const dayName = dayNames[new Date(year, month - 1, day).getDay()];
      const dayConfig = availabilityConfig.find((a) => typeof a.day === "string" && a.day.toLowerCase() === dayName && a.available);
      if (!dayConfig) continue;

      const allSlots = getSlotsForDayConfig(dayConfig);
      if (allSlots.length === 0) continue;

      const booked = bookedByDate.get(dateStr) ?? new Set<string>();
      let open = allSlots.filter((s) => !booked.has(s.startTime));
      const isToday = year === studioToday.year && month === studioToday.month && day === studioToday.day;
      if (isToday) {
        open = open.filter((s) => parseTimeToMinutes(s.startTime) > studioToday.minutes);
      }
      if (open.length > 0) result[dateStr] = open;
    }

    if (isDevOrEmulator) {
      console.log(`[available-slots] Result keys: ${Object.keys(result).join(", ") || "(none)"}`);
    }
    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    console.error("Error getting available slots:", error);
    handleError(req, res, error);
  }
});

app.get("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const instructorData = await instructorsService.getInstructorById(req.params["id"] as string, studioOwnerId);
    if (!instructorData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    }

    sendJsonResponse(req, res, 200, instructorData);
  } catch (error) {
    console.error("Error getting instructor:", error);
    if ((error as Error).message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", (error as Error).message);
    }
    handleError(req, res, error);
  }
});

app.put("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { photoFile, ...instructorData } = req.body as Record<string, unknown>;

    const validation = validateUpdateInstructorPayload(instructorData);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid instructor data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    let photoUrl: string | undefined;
    if (photoFile && typeof photoFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(photoFile);
        const mimeType = storageService.getMimeTypeFromBase64(photoFile);
        const fileName = `instructor-${Date.now()}.${mimeType.split("/")[1]}`;
        photoUrl = await storageService.uploadInstructorPhoto(fileBuffer, fileName, mimeType);
      } catch (imageError) {
        console.error("Error uploading instructor photo:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", (imageError as Error).message || "Failed to upload instructor photo");
      }
    }

    const instructorId = req.params["id"] as string;
    const payload = photoUrl !== undefined ? { ...instructorData, photoUrl } : instructorData;
    await instructorsService.updateInstructor(instructorId, payload, studioOwnerId);
    logAuditEvent(user.uid, studioOwnerId, "instructor_updated", "instructor", instructorId);

    sendJsonResponse(req, res, 200, { message: "Instructor updated successfully" });
  } catch (error) {
    console.error("Error updating instructor:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.delete("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const instructorId = req.params["id"] as string;
    await instructorsService.deleteInstructor(instructorId, studioOwnerId);
    logAuditEvent(user.uid, studioOwnerId, "instructor_deleted", "instructor", instructorId);
    sendJsonResponse(req, res, 200, { message: "Instructor deleted successfully" });
  } catch (error) {
    console.error("Error deleting instructor:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const instructors = functions.https.onRequest(app);
