import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import authService from "../services/auth.service";
import storageService from "../services/storage.service";
import { getStripeClient } from "../services/stripe.service";
import { verifyToken } from "../utils/auth";
import { validateUpdateProfilePayload } from "../utils/validation";
import { getFirestore } from "../utils/firestore";
import { geocodeAddress } from "../utils/geocoding";
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

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "This account does not have studio owner access");
    }

    const userData = userDoc.data() as Record<string, unknown>;

    sendJsonResponse(req, res, 200, {
      id: userDoc.id,
      firstName: userData["firstName"],
      lastName: userData["lastName"],
      studioName: userData["studioName"],
      studioAddressLine1: userData["studioAddressLine1"],
      studioAddressLine2: userData["studioAddressLine2"] || null,
      city: userData["city"],
      state: userData["state"],
      zip: userData["zip"],
      studioImageUrl: userData["studioImageUrl"] || null,
      facebook: userData["facebook"] || null,
      instagram: userData["instagram"] || null,
      tiktok: userData["tiktok"] || null,
      youtube: userData["youtube"] || null,
      email: userData["email"],
      membership: userData["membership"],
      stripeAccountId: userData["stripeAccountId"] || null,
      stripeAccountStatus: userData["stripeAccountStatus"] || null,
      stripeSetupCompleted: userData["stripeSetupCompleted"] || false,
      stripeSubscriptionId: userData["stripeSubscriptionId"] || null,
      stripeSubscriptionStatus: userData["stripeSubscriptionStatus"] || null,
      subscriptionActive: userData["subscriptionActive"] !== false,
      deletionStatus: userData["deletionStatus"] || null,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    handleError(req, res, error);
  }
});

app.put("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const validation = validateUpdateProfilePayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid profile data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "This account does not have studio owner access");
    }

    const {
      firstName, lastName, studioName, studioAddressLine1, studioAddressLine2,
      city, state, zip, facebook, instagram, tiktok, youtube, studioImageFile,
    } = req.body as Record<string, string | undefined>;

    const existingData = userDoc.data() as Record<string, unknown>;
    let studioImageUrl: string | null = null;
    const oldStudioImageUrl = (existingData["studioImageUrl"] as string) || null;

    if (studioImageFile && typeof studioImageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(studioImageFile);
        const mimeType = storageService.getMimeTypeFromBase64(studioImageFile);
        const fileName = `studio-image-${user.uid}.${mimeType.split("/")[1]}`;
        studioImageUrl = await storageService.uploadStudioImage(fileBuffer, fileName, mimeType);

        if (oldStudioImageUrl && oldStudioImageUrl !== studioImageUrl) {
          try { await storageService.deleteFile(oldStudioImageUrl); } catch (deleteError) {
            console.error("Error deleting old studio image:", deleteError);
          }
        }
      } catch (imageError) {
        console.error("Error uploading studio image:", imageError);
        return sendErrorResponse(req, res, 400, "Image Upload Failed", (imageError as Error).message || "Failed to upload studio image");
      }
    }

    const updateData: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (firstName !== undefined) updateData["firstName"] = firstName.trim();
    if (lastName !== undefined) updateData["lastName"] = lastName.trim();
    if (studioName !== undefined) updateData["studioName"] = studioName.trim();
    if (studioAddressLine1 !== undefined) updateData["studioAddressLine1"] = studioAddressLine1.trim();
    if (studioAddressLine2 !== undefined) updateData["studioAddressLine2"] = studioAddressLine2 ? studioAddressLine2.trim() : null;
    if (city !== undefined) updateData["city"] = city.trim();
    if (state !== undefined) updateData["state"] = state.trim().toUpperCase();
    if (zip !== undefined) updateData["zip"] = zip.trim();
    if (facebook !== undefined) updateData["facebook"] = facebook ? facebook.trim() : null;
    if (instagram !== undefined) updateData["instagram"] = instagram ? instagram.trim() : null;
    if (tiktok !== undefined) updateData["tiktok"] = tiktok ? tiktok.trim() : null;
    if (youtube !== undefined) updateData["youtube"] = youtube ? youtube.trim() : null;
    if (studioImageUrl !== null) updateData["studioImageUrl"] = studioImageUrl;

    const addressChanged = studioAddressLine1 !== undefined || city !== undefined ||
      state !== undefined || zip !== undefined;
    if (addressChanged) {
      const resolvedAddress = (updateData["studioAddressLine1"] as string) || (existingData["studioAddressLine1"] as string) || "";
      const resolvedCity = (updateData["city"] as string) || (existingData["city"] as string) || "";
      const resolvedState = (updateData["state"] as string) || (existingData["state"] as string) || "";
      const resolvedZip = (updateData["zip"] as string) || (existingData["zip"] as string) || "";
      if (resolvedAddress && resolvedCity && resolvedState) {
        const coords = await geocodeAddress(resolvedAddress, resolvedCity, resolvedState, resolvedZip);
        if (coords) {
          updateData["lat"] = coords.lat;
          updateData["lng"] = coords.lng;
        }
      }
    }

    const db = getFirestore();
    await db.collection("users").doc(userDoc.id).update(updateData);

    const updatedDoc = await db.collection("users").doc(userDoc.id).get();
    const updatedData = updatedDoc.data() as Record<string, unknown>;

    sendJsonResponse(req, res, 200, {
      firstName: updatedData["firstName"],
      lastName: updatedData["lastName"],
      studioName: updatedData["studioName"],
      studioAddressLine1: updatedData["studioAddressLine1"],
      studioAddressLine2: updatedData["studioAddressLine2"] || null,
      city: updatedData["city"],
      state: updatedData["state"],
      zip: updatedData["zip"],
      studioImageUrl: updatedData["studioImageUrl"] || null,
      facebook: updatedData["facebook"] || null,
      instagram: updatedData["instagram"] || null,
      tiktok: updatedData["tiktok"] || null,
      youtube: updatedData["youtube"] || null,
      email: updatedData["email"],
      membership: updatedData["membership"],
    });
  } catch (error) {
    console.error("Update profile error:", error);
    handleError(req, res, error);
  }
});

// POST /request-deletion — begin 90-day pending deletion window
app.post("/request-deletion", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");
    }

    const userData = userDoc.data() as Record<string, unknown>;

    // Cancel Stripe subscription at period end so they aren't charged again
    if (userData["stripeSubscriptionId"]) {
      try {
        const stripe = await getStripeClient();
        await stripe.subscriptions.update(userData["stripeSubscriptionId"] as string, {
          cancel_at_period_end: true,
        });
      } catch (stripeError) {
        console.error("Error cancelling Stripe subscription during deletion request:", stripeError);
      }
    }

    const db = getFirestore();
    await db.collection("users").doc(userDoc.id).update({
      deletionStatus: "pending",
      deletionRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {
      message: "Account deletion scheduled. Your account and all associated data will be permanently deleted after 90 days.",
      deletionWindowDays: 90,
    });
  } catch (error) {
    console.error("Studio owner request-deletion error:", error);
    handleError(req, res, error);
  }
});

// DELETE /cancel-deletion — cancel a pending deletion within the 90-day window
app.delete("/cancel-deletion", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");
    }

    const userData = userDoc.data() as Record<string, unknown>;
    if (userData["deletionStatus"] !== "pending") {
      return sendErrorResponse(req, res, 400, "Bad Request", "No pending deletion to cancel");
    }

    const db = getFirestore();
    await db.collection("users").doc(userDoc.id).update({
      deletionStatus: admin.firestore.FieldValue.delete(),
      deletionRequestedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { message: "Account deletion cancelled." });
  } catch (error) {
    console.error("Studio owner cancel-deletion error:", error);
    handleError(req, res, error);
  }
});

// GET /export-data — download all studio data as JSON
app.get("/export-data", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner access required");
    }

    const db = getFirestore();
    const studioOwnerId = userDoc.id;
    const userData = userDoc.data() as Record<string, unknown>;

    const [classesSnap, workshopsSnap, eventsSnap, packagesSnap, studentsSnap, instructorsSnap, attendanceSnap, purchasesSnap] =
      await Promise.all([
        db.collection("classes").where("studioOwnerId", "==", studioOwnerId).get(),
        db.collection("workshops").where("studioOwnerId", "==", studioOwnerId).get(),
        db.collection("events").where("studioOwnerId", "==", studioOwnerId).get(),
        db.collection("packages").where("studioOwnerId", "==", studioOwnerId).get(),
        db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
        db.collection("instructors").where("studioOwnerId", "==", studioOwnerId).get(),
        db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).get(),
        db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
      ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      profile: { id: studioOwnerId, ...userData },
      classes: classesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      workshops: workshopsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      events: eventsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      packages: packagesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      students: studentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      instructors: instructorsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      attendance: attendanceSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      purchases: purchasesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    };

    sendJsonResponse(req, res, 200, exportData);
  } catch (error) {
    console.error("Studio owner export-data error:", error);
    handleError(req, res, error);
  }
});

// PATCH /fcm-token — update FCM push token for the authenticated studio owner
app.patch("/fcm-token", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { fcmToken } = req.body as { fcmToken?: unknown };
    if (!fcmToken || typeof fcmToken !== "string" || fcmToken.trim().length === 0 || fcmToken.length > 500) {
      return sendErrorResponse(req, res, 400, "Validation Error", "fcmToken must be a non-empty string ≤ 500 characters");
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");

    const db = getFirestore();
    await db.collection("users").doc(userDoc.id).update({
      fcmToken: fcmToken.trim(),
      fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { ok: true });
  } catch (error) {
    console.error("PATCH /fcm-token error:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const profile = functions.https.onRequest(app);
