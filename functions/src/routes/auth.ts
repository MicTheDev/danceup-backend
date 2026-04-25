import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import authService from "../services/auth.service";
import storageService from "../services/storage.service";
import { sendStudioOwnerWelcomeEmail } from "../services/sendgrid.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { getFirebaseApiKey } from "../utils/firebase-api-key";
import {
  validateRegistrationPayload,
  validateLoginPayload,
  validateForgotPasswordPayload,
  validateResetPasswordPayload,
  validateChangeEmailPayload,
  validateMembership,
} from "../utils/validation";
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
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use(cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too Many Requests", message: "Too many login attempts. Please try again in 15 minutes." },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too Many Requests", message: "Too many registration attempts. Please try again in an hour." },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too Many Requests", message: "Too many password reset attempts. Please try again in 15 minutes." },
});

app.post("/register", registerLimiter, async (req, res) => {
  try {
    const validation = validateRegistrationPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid registration data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const {
      email, password, firstName, lastName, studioName,
      studioAddressLine1, studioAddressLine2, city, state, zip, membership,
      facebook, instagram, tiktok, youtube, studioImageFile,
    } = req.body as Record<string, string | undefined>;

    let userRecord: admin.auth.UserRecord | undefined;
    let studioImageUrl: string | null = null;

    try {
      userRecord = await authService.createUser(email as string, password as string);

      if (studioImageFile && typeof studioImageFile === "string") {
        try {
          const fileBuffer = storageService.base64ToBuffer(studioImageFile);
          const mimeType = storageService.getMimeTypeFromBase64(studioImageFile);
          const fileName = `studio-image-${userRecord.uid}.${mimeType.split("/")[1]}`;
          studioImageUrl = await storageService.uploadStudioImage(fileBuffer, fileName, mimeType);
        } catch (imageError) {
          console.error("Error uploading studio image:", imageError);
        }
      }

      const userData: Record<string, unknown> = {
        email: userRecord.email,
        firstName: (firstName as string).trim(),
        lastName: (lastName as string).trim(),
        studioName: (studioName as string).trim(),
        studioAddressLine1: (studioAddressLine1 as string).trim(),
        studioAddressLine2: studioAddressLine2 ? studioAddressLine2.trim() : null,
        city: (city as string).trim(),
        state: (state as string).trim().toUpperCase(),
        zip: (zip as string).trim(),
        roles: ["student", "studio_owner"],
        studioImageUrl,
        facebook: facebook ? facebook.trim() : null,
        instagram: instagram ? instagram.trim() : null,
        tiktok: tiktok ? tiktok.trim() : null,
        youtube: youtube ? youtube.trim() : null,
      };

      if (membership !== undefined && membership !== null) {
        userData["membership"] = membership;
      }

      const studioOwnerId = await authService.createUserDocument(userRecord.uid, userData);
      const customToken = await authService.createCustomToken(userRecord.uid);

      sendJsonResponse(req, res, 201, {
        customToken,
        user: { uid: userRecord.uid, email: userRecord.email, studioOwnerId },
      });

      sendStudioOwnerWelcomeEmail(userRecord.email as string, firstName as string, studioName as string).catch((err) => {
        console.error("Failed to send studio owner welcome email:", err);
      });
    } catch (error) {
      if (userRecord) {
        await authService.deleteUser(userRecord.uid);
        if (studioImageUrl) {
          await storageService.deleteFile(studioImageUrl);
        }
      }
      throw error;
    }
  } catch (error) {
    console.error("Registration error:", error);
    handleError(req, res, {
      status: 400,
      error: "Registration Failed",
      message: (error as Error).message || "Failed to register user",
    });
  }
});

app.post("/login", loginLimiter, async (req, res) => {
  try {
    const validation = validateLoginPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid login data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const { email, password } = req.body as { email: string; password: string };

    let apiKey: string;
    try {
      apiKey = await getFirebaseApiKey();
    } catch (error) {
      console.error("FIREBASE_WEB_API_KEY not configured:", (error as Error).message);
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    try {
      await authService.verifyPassword(email, password, apiKey);
    } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid email or password");
    }

    let userRecord: admin.auth.UserRecord;
    try {
      userRecord = await authService.getUserByEmail(email);
    } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid email or password");
    }

    const userDoc = await authService.getUserDocumentByAuthUid(userRecord.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "User profile not found");
    }

    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "This account does not have studio owner access");
    }

    const customToken = await authService.createCustomToken(userRecord.uid);

    sendJsonResponse(req, res, 200, {
      customToken,
      user: { uid: userRecord.uid, email: userRecord.email, studioOwnerId: userDoc.id },
    });
  } catch (error) {
    console.error("Login error:", error);
    handleError(req, res, error);
  }
});

app.get("/me", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userData = userDoc.data() as Record<string, unknown>;

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studioOwnerId: userDoc.id,
      profile: {
        firstName: userData["firstName"],
        lastName: userData["lastName"],
        studioName: userData["studioName"],
        studioAddressLine1: userData["studioAddressLine1"],
        studioAddressLine2: userData["studioAddressLine2"] || null,
        city: userData["city"],
        state: userData["state"],
        zip: userData["zip"],
        studioImageUrl: userData["studioImageUrl"] || null,
        membership: userData["membership"],
        facebook: userData["facebook"] || null,
        instagram: userData["instagram"] || null,
        tiktok: userData["tiktok"] || null,
        youtube: userData["youtube"] || null,
        roles: userData["roles"] || [],
      },
    });
  } catch (error) {
    console.error("Get user profile error:", error);
    handleError(req, res, error);
  }
});

app.post("/logout", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    // Revoke all refresh tokens so stolen tokens cannot be used after logout
    await admin.auth().revokeRefreshTokens(user.uid);
    sendJsonResponse(req, res, 200, { message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    handleError(req, res, error);
  }
});

app.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  try {
    const validation = validateForgotPasswordPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid request data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const { email } = req.body as { email: string };
    const actionCodeSettings = {
      url: process.env["PASSWORD_RESET_URL"] || `${req.headers.origin || "https://your-app.com"}/reset-password`,
      handleCodeInApp: false,
    };

    try {
      await authService.sendPasswordResetEmail(email, actionCodeSettings);
    } catch (emailError) {
      const msg = (emailError as Error).message || "";
      if (!msg.includes("user-not-found") && !msg.includes("No user found")) {
        throw emailError;
      }
    }

    sendJsonResponse(req, res, 200, {
      message: "If an account with that email exists, a password reset link has been sent.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    handleError(req, res, error);
  }
});

app.post("/reset-password", async (req, res) => {
  try {
    const validation = validateResetPasswordPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid request data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const { oobCode, newPassword } = req.body as { oobCode: string; newPassword: string };
    await authService.verifyPasswordResetCode(oobCode, newPassword);

    sendJsonResponse(req, res, 200, { message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset password error:", error);
    const message = (error as Error).message || "Failed to reset password";
    if (message.includes("expired") || message.includes("invalid")) {
      return sendErrorResponse(req, res, 400, "Invalid Code", "This password reset link has expired or is invalid");
    }
    handleError(req, res, error);
  }
});

app.post("/change-email", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const validation = validateChangeEmailPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid request data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const { currentPassword, newEmail } = req.body as { currentPassword: string; newEmail: string };

    let apiKey: string;
    try {
      apiKey = await getFirebaseApiKey();
    } catch (error) {
      console.error("FIREBASE_WEB_API_KEY not configured:", (error as Error).message);
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    try {
      await authService.verifyPasswordForReauth(user.email, currentPassword, apiKey);
    } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Incorrect password");
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    await authService.updateUserEmail(user.uid, newEmail);

    const db = getFirestore();
    await db.collection("users").doc(userDoc.id).update({
      email: newEmail.trim().toLowerCase(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { message: "Email address updated successfully", email: newEmail });
  } catch (error) {
    console.error("Change email error:", error);
    const message = (error as Error).message || "Failed to update email address";
    if (message.includes("email-already-exists") || message.includes("already in use")) {
      return sendErrorResponse(req, res, 409, "Conflict", "This email address is already in use");
    }
    if (message.includes("invalid-email")) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid email address");
    }
    handleError(req, res, error);
  }
});

app.patch("/update-membership", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const { membership } = req.body as { membership?: string };

    if (!membership) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Membership is required");
    }

    const membershipValidation = validateMembership(membership);
    if (!membershipValidation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", (membershipValidation as { valid: false; message: string }).message);
    }

    const db = getFirestore();
    const userQuery = await db.collection("users").where("authUid", "==", user.uid).limit(1).get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userDoc = userQuery.docs[0];
    if (!userDoc) return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    const userData = userDoc.data() as Record<string, unknown>;

    if (userData["stripeSubscriptionId"] && userData["stripeSubscriptionStatus"] === "active") {
      return sendErrorResponse(
        req, res, 403, "Forbidden",
        "Your membership is managed through your Stripe subscription. Please use the billing portal to make changes.",
      );
    }

    await userDoc.ref.update({
      membership,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { message: "Membership updated successfully", membership });
  } catch (error) {
    console.error("Update membership error:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const auth = functions.https.onRequest(app);
