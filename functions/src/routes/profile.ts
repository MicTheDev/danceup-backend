import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import authService from "../services/auth.service";
import storageService from "../services/storage.service";
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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const profile = functions.https.onRequest(app);
