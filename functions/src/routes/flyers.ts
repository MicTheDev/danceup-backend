import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import studentsService from "../services/students.service";
import * as flyersService from "../services/flyers.service";
import * as flyerGen from "../services/flyer-generator.service";
import { getFirestore } from "../utils/firestore";
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

// ─── Content fetchers ─────────────────────────────────────────────────────────

interface RawClass {
  name?: string;
  danceGenre?: string;
  level?: string;
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  cost?: number;
  instructorIds?: string[];
  [key: string]: unknown;
}

interface RawEventOrWorkshop {
  name?: string;
  danceGenre?: string;
  type?: string;
  startTime?: string;
  endTime?: string;
  locationName?: string;
  city?: string;
  state?: string;
  priceTiers?: Array<{ name?: string; price?: number }>;
  description?: string;
  levels?: string[];
  [key: string]: unknown;
}

async function fetchClass(classId: string, studioOwnerId: string): Promise<RawClass | null> {
  const db = getFirestore();
  const doc = await db.collection("classes").doc(classId).get();
  if (!doc.exists) return null;
  const data = doc.data() as RawClass & { studioOwnerId?: string };
  if (data.studioOwnerId !== studioOwnerId) return null;
  return data;
}

async function fetchEvent(eventId: string, studioOwnerId: string): Promise<RawEventOrWorkshop | null> {
  const db = getFirestore();
  const doc = await db.collection("events").doc(eventId).get();
  if (!doc.exists) return null;
  const data = doc.data() as RawEventOrWorkshop & { studioOwnerId?: string };
  if (data.studioOwnerId !== studioOwnerId) return null;
  return data;
}

async function fetchWorkshop(workshopId: string, studioOwnerId: string): Promise<RawEventOrWorkshop | null> {
  const db = getFirestore();
  const doc = await db.collection("workshops").doc(workshopId).get();
  if (!doc.exists) return null;
  const data = doc.data() as RawEventOrWorkshop & { studioOwnerId?: string };
  if (data.studioOwnerId !== studioOwnerId) return null;
  return data;
}

async function fetchAllClasses(studioOwnerId: string): Promise<Array<flyerGen.ScheduleClass>> {
  const db = getFirestore();
  const snap = await db.collection("classes").where("studioOwnerId", "==", studioOwnerId).get();

  const rawClasses = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as RawClass) }))
    .filter((c) => !!c.dayOfWeek);

  // Collect unique instructor IDs across all classes
  const instructorIdSet = new Set<string>();
  for (const cls of rawClasses) {
    for (const id of (cls.instructorIds ?? [])) instructorIdSet.add(id);
  }

  // Fetch instructor docs and resolve photos
  interface InstructorInfo { name: string; photoBase64: string | null }
  const instructorMap = new Map<string, InstructorInfo>();
  if (instructorIdSet.size > 0) {
    await Promise.all([...instructorIdSet].map(async (instrId) => {
      try {
        const doc = await db.collection("instructors").doc(instrId).get();
        if (!doc.exists) return;
        const d = doc.data() as { firstName?: string; lastName?: string; imageUrl?: string | null };
        const name = [d.firstName, d.lastName].filter(Boolean).join(" ");
        const photoBase64 = d.imageUrl ? await fetchImageAsBase64(d.imageUrl) : null;
        instructorMap.set(instrId, { name, photoBase64 });
      } catch { /* skip */ }
    }));
  }

  return rawClasses.map((data) => {
    const instructors = (data.instructorIds ?? [])
      .map((id) => instructorMap.get(id))
      .filter((info): info is InstructorInfo => !!info)
      .map((info) => ({ name: info.name, photo: info.photoBase64 }));

    return {
      name: (data.name ?? "Class").trim(),
      dayOfWeek: data.dayOfWeek ?? "",
      startTime: data.startTime ?? "",
      endTime: data.endTime ?? "",
      cost: typeof data.cost === "number" ? data.cost : undefined,
      danceGenre: data.danceGenre,
      level: data.level,
      instructors: instructors.length > 0 ? instructors : undefined,
    };
  });
}

function formatEventDate(isoStr?: string): string {
  if (!isoStr) return "";
  try {
    return new Date(isoStr).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return isoStr;
  }
}

function formatEventTime(isoStr?: string): string {
  if (!isoStr) return "";
  try {
    return new Date(isoStr).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoStr;
  }
}

function formatPrice(tiers?: Array<{ price?: number }>): string {
  if (!tiers || tiers.length === 0) return "";
  const lowestPrice = tiers
    .map((t) => t.price ?? Infinity)
    .filter((p) => p < Infinity)
    .sort((a, b) => a - b)[0];
  return lowestPrice !== undefined ? `$${lowestPrice}` : "";
}

async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "image/png";
    const buffer = await response.arrayBuffer();
    return `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`;
  } catch {
    return null;
  }
}

// ─── POST /generate ──────────────────────────────────────────────────────────

app.post("/generate", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const type = body["type"] as string | undefined;
    const contentId = body["contentId"] as string | undefined;
    const rawScheme = body["colorScheme"] as { colors?: unknown; style?: unknown } | undefined;
    const colorScheme = rawScheme && Array.isArray(rawScheme.colors) && rawScheme.colors.length > 0
      ? {
          colors: (rawScheme.colors as string[]).slice(0, 3),
          style: rawScheme.style === "solid" ? "solid" as const : "gradient" as const,
        }
      : undefined;

    const rawLogo = body["logoPlacement"] as { position?: unknown; align?: unknown } | undefined;
    const validPositions = ["top", "bottom"];
    const validAligns = ["left", "center", "right"];
    const logoPlacement = rawLogo
      && validPositions.includes(rawLogo.position as string)
      && validAligns.includes(rawLogo.align as string)
      ? {
          position: rawLogo.position as "top" | "bottom",
          align: rawLogo.align as "left" | "center" | "right",
        }
      : undefined;

    const validTypes = ["event", "class", "workshop", "schedule"];
    if (!type || !validTypes.includes(type)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "type must be one of: event, class, workshop, schedule");
    }

    // Fetch studio name and logo
    const db = getFirestore();
    const userDoc = await db.collection("users").doc(studioOwnerId).get();
    const userData = userDoc.data() as Record<string, unknown> | undefined;
    const studioName = userData?.["studioName"] as string | undefined ?? "My Studio";
    const studioImageUrl = userData?.["studioImageUrl"] as string | undefined;
    const logoBase64 = logoPlacement && studioImageUrl
      ? await fetchImageAsBase64(studioImageUrl)
      : null;

    if (type === "schedule") {
      const classes = await fetchAllClasses(studioOwnerId);
      if (classes.length === 0) {
        return sendErrorResponse(req, res, 400, "No Content", "No classes found for this studio. Add classes first.");
      }
      const genres = [...new Set(classes.map((c) => c.danceGenre).filter(Boolean))].join(", ");
      const copy = await flyerGen.generateFlyerCopy({
        type: "schedule",
        name: "Weekly Schedule",
        studioName,
        danceGenre: genres || undefined,
      });
      const weekLabel = body["weekLabel"] as string | undefined;
      const svgContent = flyerGen.buildScheduleFlyer({
        studioName,
        danceGenre: genres || undefined,
        weekLabel,
        classes,
        colorScheme,
        logoBase64: logoBase64 ?? undefined,
        logoPlacement,
        copy,
      });
      const height = 1350 + Math.max(0, classes.length - 8) * 44;
      return sendJsonResponse(req, res, 200, {
        type: "schedule",
        contentName: "Weekly Schedule",
        svgContent,
        flyerHeight: height,
        copy,
      });
    }

    // Single content item types
    if (!contentId || typeof contentId !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "contentId is required for event, class, and workshop flyers");
    }

    if (type === "class") {
      const data = await fetchClass(contentId, studioOwnerId);
      if (!data) return sendErrorResponse(req, res, 404, "Not Found", "Class not found");

      const timeStr = data.startTime && data.endTime
        ? `${data.startTime} – ${data.endTime}`
        : (data.startTime ?? "");

      const copy = await flyerGen.generateFlyerCopy({
        type: "class",
        name: data.name ?? "Dance Class",
        studioName,
        danceGenre: data.danceGenre,
        level: data.level,
        dateStr: data.dayOfWeek ?? "",
        price: data.cost != null ? `$${data.cost}` : undefined,
      });

      const svgContent = flyerGen.buildClassFlyer({
        studioName,
        name: data.name ?? "Dance Class",
        danceGenre: data.danceGenre,
        level: data.level,
        dayOfWeek: data.dayOfWeek,
        timeStr: timeStr || undefined,
        price: data.cost != null ? `$${data.cost} per class` : undefined,
        colorScheme,
        logoBase64: logoBase64 ?? undefined,
        logoPlacement,
        copy,
      });

      return sendJsonResponse(req, res, 200, {
        type: "class",
        contentName: data.name ?? "Dance Class",
        svgContent,
        flyerHeight: 1350,
        copy,
      });
    }

    if (type === "event") {
      const data = await fetchEvent(contentId, studioOwnerId);
      if (!data) return sendErrorResponse(req, res, 404, "Not Found", "Event not found");

      const danceGenre = Array.isArray(data.danceGenre) ? (data.danceGenre as string[]).join(", ") : data.danceGenre;
      const dateStr = formatEventDate(data.startTime);
      const timeStr = data.startTime && data.endTime
        ? `${formatEventTime(data.startTime)} – ${formatEventTime(data.endTime)}`
        : formatEventTime(data.startTime);
      const location = [data.locationName, data.city, data.state].filter(Boolean).join(", ");
      const price = formatPrice(data.priceTiers);

      const copy = await flyerGen.generateFlyerCopy({
        type: "event",
        name: data.name ?? "Event",
        studioName,
        danceGenre,
        dateStr,
        price: price || undefined,
        location: location || undefined,
        description: data.description,
      });

      const svgContent = flyerGen.buildEventOrWorkshopFlyer({
        studioName,
        name: data.name ?? "Event",
        danceGenre,
        dateStr: dateStr || undefined,
        timeStr: timeStr || undefined,
        location: location || undefined,
        price: price || undefined,
        description: data.description,
        colorScheme,
        logoBase64: logoBase64 ?? undefined,
        logoPlacement,
        copy,
      });

      return sendJsonResponse(req, res, 200, {
        type: "event",
        contentName: data.name ?? "Event",
        svgContent,
        flyerHeight: 1350,
        copy,
      });
    }

    if (type === "workshop") {
      const data = await fetchWorkshop(contentId, studioOwnerId);
      if (!data) return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");

      const danceGenre = Array.isArray(data.danceGenre) ? (data.danceGenre as string[]).join(", ") : data.danceGenre;
      const dateStr = formatEventDate(data.startTime);
      const timeStr = data.startTime && data.endTime
        ? `${formatEventTime(data.startTime)} – ${formatEventTime(data.endTime)}`
        : formatEventTime(data.startTime);
      const location = [data.locationName, data.city, data.state].filter(Boolean).join(", ");
      const price = formatPrice(data.priceTiers);
      const level = Array.isArray(data.levels) ? data.levels.join(", ") : "";

      const copy = await flyerGen.generateFlyerCopy({
        type: "workshop",
        name: data.name ?? "Workshop",
        studioName,
        danceGenre,
        level: level || undefined,
        dateStr,
        price: price || undefined,
        location: location || undefined,
        description: data.description,
      });

      const svgContent = flyerGen.buildEventOrWorkshopFlyer({
        studioName,
        name: data.name ?? "Workshop",
        danceGenre,
        dateStr: dateStr || undefined,
        timeStr: timeStr || undefined,
        location: location || undefined,
        price: price || undefined,
        description: data.description,
        colorScheme,
        logoBase64: logoBase64 ?? undefined,
        logoPlacement,
        copy,
      });

      return sendJsonResponse(req, res, 200, {
        type: "workshop",
        contentName: data.name ?? "Workshop",
        svgContent,
        flyerHeight: 1350,
        copy,
      });
    }

    return sendErrorResponse(req, res, 400, "Validation Error", "Unhandled flyer type");
  } catch (error) {
    console.error("Error generating flyer:", error);
    handleError(req, res, error);
  }
});

// ─── POST /save ───────────────────────────────────────────────────────────────

app.post("/save", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const type = body["type"] as string | undefined;
    const contentName = body["contentName"] as string | undefined;
    const svgContent = body["svgContent"] as string | undefined;
    const flyerHeight = body["flyerHeight"] as number | undefined;

    const validTypes = ["event", "class", "workshop", "schedule"];
    if (!type || !validTypes.includes(type)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "type is required");
    }
    if (!contentName || typeof contentName !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "contentName is required");
    }
    if (!svgContent || typeof svgContent !== "string" || !svgContent.startsWith("<svg")) {
      return sendErrorResponse(req, res, 400, "Validation Error", "svgContent is required and must be valid SVG");
    }

    const flyer = await flyersService.saveFlyer(studioOwnerId, {
      type: type as flyersService.FlyerDocument["type"],
      contentName: contentName.trim().slice(0, 120),
      svgContent,
      flyerHeight: typeof flyerHeight === "number" ? flyerHeight : 1350,
    });

    sendJsonResponse(req, res, 201, { flyerId: flyer.id, createdAt: flyer.createdAt });
  } catch (error) {
    console.error("Error saving flyer:", error);
    handleError(req, res, error);
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const flyers = await flyersService.listFlyers(studioOwnerId);
    // Return lightweight list (omit heavy svgContent for the list view)
    const list = flyers.map(({ svgContent: _, ...rest }) => rest);
    sendJsonResponse(req, res, 200, list);
  } catch (error) {
    console.error("Error listing flyers:", error);
    handleError(req, res, error);
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

app.get("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const flyer = await flyersService.getFlyerById(req.params["id"] as string, studioOwnerId);
    if (!flyer) return sendErrorResponse(req, res, 404, "Not Found", "Flyer not found");

    sendJsonResponse(req, res, 200, flyer);
  } catch (error) {
    console.error("Error fetching flyer:", error);
    handleError(req, res, error);
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

app.delete("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await studentsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const deleted = await flyersService.deleteFlyer(req.params["id"] as string, studioOwnerId);
    if (!deleted) return sendErrorResponse(req, res, 404, "Not Found", "Flyer not found");

    sendJsonResponse(req, res, 200, { deleted: true });
  } catch (error) {
    console.error("Error deleting flyer:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const flyers = functions.https.onRequest(app);
