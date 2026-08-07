import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response } from "express";
import cors from "cors";
import { verifyToken } from "../utils/auth";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";
import { getFirestore } from "../utils/firestore";
import { validateRequiredString, validateState } from "../utils/validation";
import { logAuditEvent } from "../services/audit.service";
import instructorsService from "../services/instructors.service";
import classesService from "../services/classes.service";
import workshopsService from "../services/workshops.service";
import eventsService from "../services/events.service";


const app = express();

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  next();
});

app.use(cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);

function deriveStatus(data: Record<string, unknown>): string {
  const ss = data["stripeSubscriptionStatus"] as string | undefined;
  if (ss === "active") return "active";
  if (ss === "trialing") return "trial";
  if (ss === "past_due") return "past_due";
  if (ss === "canceled" || ss === "unpaid" || ss === "incomplete_expired") return "churned";
  return "pending";
}

function derivePlan(membership: string | null | undefined): string {
  if (membership === "ultimate") return "studio";
  if (membership === "studio_owner") return "pro";
  if (membership === "individual_instructor" || membership === "event_organizer") return "starter";
  return "free";
}

function toIso(ts: unknown): string | null {
  if (!ts) return null;
  if (typeof ts === "object" && ts !== null && "toDate" in ts) {
    return (ts as admin.firestore.Timestamp).toDate().toISOString();
  }
  return null;
}

async function batchGetAuthUsers(uids: string[]): Promise<Map<string, string | null>> {
  const lastSignInMap = new Map<string, string | null>();
  const BATCH = 100;
  for (let i = 0; i < uids.length; i += BATCH) {
    const identifiers = uids.slice(i, i + BATCH).map((uid) => ({ uid }));
    const result = await admin.auth().getUsers(identifiers);
    for (const record of result.users) {
      const t = record.metadata.lastSignInTime;
      lastSignInMap.set(record.uid, t ? new Date(t).toISOString() : null);
    }
  }
  return lastSignInMap;
}

// GET /  — list all studio owners
app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const db = getFirestore();
    const snapshot = await db
      .collection("users")
      .where("roles", "array-contains", "studio_owner")
      .get();

    const uids = snapshot.docs.map((doc) => doc.id);
    let lastSignInMap = new Map<string, string | null>();
    try {
      lastSignInMap = await batchGetAuthUsers(uids);
    } catch (authErr) {
      console.warn("danceup-admin-studios: auth lookup failed, lastActiveAt will be null", authErr);
    }

    const studios = snapshot.docs.map((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const membership = (d["membership"] as string | null) ?? null;

      return {
        id: doc.id,
        studioName: (d["studioName"] as string) || "Unnamed Studio",
        firstName: (d["firstName"] as string) || "",
        lastName: (d["lastName"] as string) || "",
        email: (d["email"] as string) || "",
        city: (d["city"] as string) || "",
        state: (d["state"] as string) || "",
        zip: (d["zip"] as string) || "",
        studioAddressLine1: (d["studioAddressLine1"] as string) || "",
        studioImageUrl: (d["studioImageUrl"] as string | null) ?? null,
        membership,
        roles: (d["roles"] as string[]) || [],
        stripeCustomerId: (d["stripeCustomerId"] as string | null) ?? null,
        stripeSubscriptionId: (d["stripeSubscriptionId"] as string | null) ?? null,
        stripeSubscriptionStatus: (d["stripeSubscriptionStatus"] as string | null) ?? null,
        subscriptionActive: (d["subscriptionActive"] as boolean | null) ?? null,
        instagram: (d["instagram"] as string | null) ?? null,
        facebook: (d["facebook"] as string | null) ?? null,
        phone: (d["phone"] as string | null) ?? null,
        createdAt: toIso(d["createdAt"]),
        updatedAt: toIso(d["updatedAt"]),
        lastActiveAt: lastSignInMap.get(doc.id) ?? null,
        // Derived fields
        status: deriveStatus(d),
        plan: derivePlan(membership),
      };
    });

    sendJsonResponse(req, res, 200, studios);
  } catch (error) {
    console.error("danceup-admin-studios error:", error);
    handleError(req, res, error);
  }
});

// POST /placeholder — create a minimal studio profile that isn't a real signed-up
// customer yet, so admin-created classes/workshops/events have something real to
// point at (and can be publicly listed) before the studio actually exists.
app.post("/placeholder", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const body = req.body as Record<string, unknown>;
    const errors: Array<{ field: string; message: string }> = [];

    const nameV = validateRequiredString(body["studioName"], "Studio name");
    if (!nameV.valid) errors.push({ field: "studioName", message: nameV.message ?? "" });

    const cityV = validateRequiredString(body["city"], "City");
    if (!cityV.valid) errors.push({ field: "city", message: cityV.message ?? "" });

    const stateV = validateState(body["state"]);
    if (!stateV.valid) errors.push({ field: "state", message: stateV.message ?? "" });

    if (errors.length > 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid placeholder studio data", { errors });
    }

    const db = getFirestore();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const docRef = await db.collection("users").add({
      isPlaceholderStudio: true,
      studioName: (body["studioName"] as string).trim(),
      city: (body["city"] as string).trim(),
      state: (body["state"] as string).trim().toUpperCase(),
      roles: [],
      membership: null,
      classrooms: [],
      createdByAdminUid: user.uid,
      createdAt: now,
      updatedAt: now,
    });

    logAuditEvent(user.uid, docRef.id, "placeholder_studio_created", "studio", docRef.id, {
      studioName: (body["studioName"] as string).trim(),
    });

    sendJsonResponse(req, res, 201, { id: docRef.id, message: "Placeholder studio created successfully" });
  } catch (error) {
    console.error("danceup-admin-studios placeholder create error:", error);
    handleError(req, res, error);
  }
});

// GET /directory — lightweight picker data source: every real studio owner plus
// every placeholder studio. Deliberately separate from GET / (which returns the
// full Studios-page dataset with billing fields) to keep this cheap and stable.
app.get("/directory", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const db = getFirestore();
    const [realSnapshot, placeholderSnapshot] = await Promise.all([
      db.collection("users").where("roles", "array-contains", "studio_owner").get(),
      db.collection("users").where("isPlaceholderStudio", "==", true).get(),
    ]);

    const toEntry = (doc: FirebaseFirestore.QueryDocumentSnapshot, isPlaceholder: boolean) => {
      const d = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        studioName: (d["studioName"] as string) || "Unnamed Studio",
        city: (d["city"] as string) || "",
        state: (d["state"] as string) || "",
        isPlaceholder,
      };
    };

    const directory = [
      ...realSnapshot.docs.map((doc) => toEntry(doc, false)),
      ...placeholderSnapshot.docs.map((doc) => toEntry(doc, true)),
    ];

    sendJsonResponse(req, res, 200, directory);
  } catch (error) {
    console.error("danceup-admin-studios directory error:", error);
    handleError(req, res, error);
  }
});

// GET /:id — full detail for one studio, real or placeholder.
app.get("/:id", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const db = getFirestore();
    const doc = await db.collection("users").doc(req.params["id"] as string).get();
    if (!doc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio not found");
    }

    const d = doc.data() as Record<string, unknown>;
    sendJsonResponse(req, res, 200, {
      id: doc.id,
      studioName: (d["studioName"] as string) || "Unnamed Studio",
      city: (d["city"] as string) || "",
      state: (d["state"] as string) || "",
      isPlaceholderStudio: (d["isPlaceholderStudio"] as boolean) || false,
      classrooms: (d["classrooms"] as unknown[]) || [],
    });
  } catch (error) {
    console.error("danceup-admin-studios detail error:", error);
    handleError(req, res, error);
  }
});

// GET /:id/instructors — instructor options for a given studio, for the admin
// class-form's instructor picker (mirrors GET /instructors/options, parameterized
// instead of derived from the caller's own token).
app.get("/:id/instructors", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const db = getFirestore();
    const snapshot = await db
      .collection("instructors")
      .where("studioOwnerId", "==", req.params["id"] as string)
      .get();

    const options = snapshot.docs.map((doc) => {
      const d = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        name: `${(d["firstName"] as string) || ""} ${(d["lastName"] as string) || ""}`.trim(),
      };
    });

    sendJsonResponse(req, res, 200, options);
  } catch (error) {
    console.error("danceup-admin-studios instructors error:", error);
    handleError(req, res, error);
  }
});

// POST /:id/instructors — quick-add an instructor for a studio directly from the
// admin class form, for studios (especially freshly-created placeholders) that
// don't have any instructors yet. Deliberately minimal — just a name, unlike the
// studio-owner-facing POST /instructors which requires first/last name plus
// optional contact fields.
app.post("/:id/instructors", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const nameV = validateRequiredString((req.body as Record<string, unknown>)["name"], "Name");
    if (!nameV.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", nameV.message ?? "Name is required");
    }

    const studioOwnerId = req.params["id"] as string;
    const studioDoc = await getFirestore().collection("users").doc(studioOwnerId).get();
    if (!studioDoc.exists) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Studio not found");
    }

    const name = ((req.body as Record<string, unknown>)["name"] as string).trim();
    const instructorId = await instructorsService.createInstructor(
      { firstName: name, lastName: "" },
      studioOwnerId,
    );
    logAuditEvent(user.uid, studioOwnerId, "instructor_created", "instructor", instructorId, { quickAdd: true });

    sendJsonResponse(req, res, 201, { id: instructorId, name });
  } catch (error) {
    console.error("danceup-admin-studios instructor create error:", error);
    handleError(req, res, error);
  }
});

// POST /:id/reassign-all — reassign every class/workshop/event currently owned
// by studio :id (typically a placeholder) to a different studio in one shot.
// Serves the "studio signs up, transfer their advertised listings" workflow,
// which in practice may be several listings at once rather than one at a time.
app.post("/:id/reassign-all", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const fromStudioOwnerId = req.params["id"] as string;
    const toStudioOwnerId = (req.body as Record<string, unknown>)["toStudioOwnerId"] as string | undefined;
    const targetV = validateRequiredString(toStudioOwnerId, "Target studio");
    if (!targetV.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", targetV.message ?? "Target studio is required");
    }
    if (toStudioOwnerId === fromStudioOwnerId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Target studio must be different from the current studio");
    }

    const db = getFirestore();
    const [fromDoc, toDoc] = await Promise.all([
      db.collection("users").doc(fromStudioOwnerId).get(),
      db.collection("users").doc(toStudioOwnerId as string).get(),
    ]);
    if (!fromDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Source studio not found");
    if (!toDoc.exists) return sendErrorResponse(req, res, 400, "Validation Error", "Target studio not found");

    const [classes, workshops, events] = await Promise.all([
      classesService.getAllClassesForAdmin(fromStudioOwnerId),
      workshopsService.getAllWorkshopsForAdmin(fromStudioOwnerId),
      eventsService.getAllEventsForAdmin(fromStudioOwnerId),
    ]);

    for (const c of classes) {
      await classesService.reassignClass(c["id"] as string, toStudioOwnerId as string, user.uid);
      logAuditEvent(user.uid, toStudioOwnerId as string, "class_reassigned", "class", c["id"] as string, {
        fromStudioOwnerId, toStudioOwnerId, bulk: true,
      });
    }
    for (const w of workshops) {
      await workshopsService.reassignWorkshop(w["id"] as string, toStudioOwnerId as string, user.uid);
      logAuditEvent(user.uid, toStudioOwnerId as string, "workshop_reassigned", "workshop", w["id"] as string, {
        fromStudioOwnerId, toStudioOwnerId, bulk: true,
      });
    }
    for (const e of events) {
      await eventsService.reassignEvent(e["id"] as string, toStudioOwnerId as string, user.uid);
      logAuditEvent(user.uid, toStudioOwnerId as string, "event_reassigned", "event", e["id"] as string, {
        fromStudioOwnerId, toStudioOwnerId, bulk: true,
      });
    }

    sendJsonResponse(req, res, 200, {
      message: "Listings reassigned successfully",
      counts: { classes: classes.length, workshops: workshops.length, events: events.length },
    });
  } catch (error) {
    console.error("danceup-admin-studios reassign-all error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminStudios = functions.https.onRequest(app);
