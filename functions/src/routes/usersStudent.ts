import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
// force-rebuild: fixes corrupted Cloud Run image reference (2026-07-21)
import cors from "cors";
import authService from "../services/auth.service";
import storageService from "../services/storage.service";
import studioEnrollmentService from "../services/studio-enrollment.service";
import instructorLinkingService from "../services/instructor-linking.service";
import creditTrackingService from "../services/credit-tracking.service";
import studentsService from "../services/students.service";
import classesService from "../services/classes.service";
import attendanceService from "../services/attendance.service";
import studiosService from "../services/studios.service";
import workshopsService from "../services/workshops.service";
import eventsService from "../services/events.service";
import {
  createCustomer,
  createSetupIntent,
  listPaymentMethods,
  detachPaymentMethod,
  updatePaymentMethod,
  setDefaultPaymentMethod,
  getStripePublishableKey,
  getStripeClient,
} from "../services/stripe.service";
import { sendWelcomeEmail, sendPasswordResetEmail, sendGraduationCodeEmail } from "../services/sendgrid.service";
import { completeSocialSignIn } from "../services/social-auth.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { getFirebaseApiKey } from "../utils/firebase-api-key";
import { verifyGoogleIdToken, verifyAppleIdToken } from "../utils/social-token-verify";
import {
  validateStudentRegistrationPayload,
  validateLoginPayload,
  validateForgotPasswordPayload,
  validateResetPasswordPayload,
  validateChangeEmailPayload,
} from "../utils/validation";
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

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  return res.status(204).send("");
});

app.use(cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

app.post("/register", async (req, res) => {
  try {
    const validation = validateStudentRegistrationPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid registration data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const {
      email, password, firstName, lastName, city, state, zip, phone,
      danceGenres, subscribeToNewsletter, avatarFile,
    } = req.body as {
      email: string; password: string; firstName: string; lastName: string;
      city: string; state: string; zip: string; phone?: string;
      danceGenres?: string[]; subscribeToNewsletter?: boolean; avatarFile?: string;
    };

    let userRecord: { uid: string; email: string } | null = null;
    let avatarUrl: string | null = null;

    try {
      userRecord = await authService.createUser(email, password) as { uid: string; email: string };

      if (avatarFile && typeof avatarFile === "string") {
        try {
          const fileBuffer = storageService.base64ToBuffer(avatarFile);
          const mimeType = storageService.getMimeTypeFromBase64(avatarFile);
          const ext = (mimeType as string).split("/")[1];
          const fileName = `avatar-${userRecord.uid}.${ext}`;
          avatarUrl = await storageService.uploadStudentAvatar(fileBuffer, fileName, mimeType, userRecord.uid) as string;
        } catch (imageError) {
          console.error("Error uploading avatar:", imageError);
        }
      }

      const userData = {
        email: userRecord.email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        city: city.trim(),
        state: state.trim().toUpperCase(),
        zip: zip.trim(),
        phone: phone ? phone.trim() : null,
        danceGenres: Array.isArray(danceGenres) ? danceGenres : [],
        subscribeToNewsletter: subscribeToNewsletter || false,
        photoURL: avatarUrl,
      };

      const studentProfileId = await authService.createStudentProfileDocument(userRecord.uid, userData) as string;

      try {
        await studioEnrollmentService.claimPlaceholderStudentsForAuthUid(userRecord.uid, userRecord.email);
      } catch (claimError) {
        console.error("Error claiming placeholder student rows during registration:", claimError);
      }

      try {
        await instructorLinkingService.claimPlaceholderInstructorsForAuthUid(userRecord.uid, userRecord.email);
      } catch (claimError) {
        console.error("Error claiming placeholder instructor rows during registration:", claimError);
      }

      try {
        const stripeCustomer = await createCustomer(email, {
          uid: userRecord.uid,
          studentProfileId,
          name: `${firstName.trim()} ${lastName.trim()}`,
        }) as { id: string; email: string };
        const db = getFirestore();
        await db.collection("usersStudentProfiles").doc(studentProfileId).update({
          stripeCustomerId: stripeCustomer.id,
          stripeEmail: stripeCustomer.email,
        });
      } catch (stripeError) {
        console.error("Error creating Stripe customer during registration:", stripeError);
      }

      try {
        await sendWelcomeEmail(userRecord.email, firstName);
      } catch (emailError) {
        console.error("Error sending welcome email:", emailError);
      }

      const customToken = await authService.createCustomToken(userRecord.uid) as string;

      let apiKey: string;
      try {
        apiKey = await getFirebaseApiKey() as string;
      } catch (error) {
        console.error("FIREBASE_WEB_API_KEY not configured:", (error as Error).message);
        return sendJsonResponse(req, res, 201, {
          customToken,
          user: { uid: userRecord.uid, email: userRecord.email, studentProfileId, autoCheckInClassIds: [] },
        });
      }

      const tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey) as {
        idToken: string; refreshToken: string; expiresIn: string;
      };

      sendJsonResponse(req, res, 201, {
        idToken: tokenResponse.idToken,
        refreshToken: tokenResponse.refreshToken,
        expiresIn: tokenResponse.expiresIn,
        user: { uid: userRecord.uid, email: userRecord.email, studentProfileId, autoCheckInClassIds: [] },
      });
    } catch (error) {
      if (userRecord) {
        await authService.deleteUser(userRecord.uid);
        if (avatarUrl) await storageService.deleteFile(avatarUrl);
      }
      throw error;
    }
  } catch (error) {
    console.error("Student registration error:", error);
    handleError(req, res, { status: 400, error: "Registration Failed", message: (error as Error).message || "Failed to register student" });
  }
});

app.post("/google-signin", async (req, res) => {
  try {
    const { idToken: googleIdToken } = req.body as { idToken?: string };
    if (!googleIdToken) {
      return sendErrorResponse(req, res, 400, "Validation Error", "idToken is required");
    }

    let verified;
    try {
      verified = await verifyGoogleIdToken(googleIdToken);
    } catch (err) {
      console.error("Google ID token verification failed:", err);
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired Google ID token");
    }

    const result = await completeSocialSignIn({ ...verified, provider: "google" });
    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    console.error("Google sign-in error:", error);
    handleError(req, res, error);
  }
});

app.post("/apple-signin", async (req, res) => {
  try {
    const { idToken: appleIdToken, firstName, lastName } = req.body as {
      idToken?: string; firstName?: string; lastName?: string;
    };
    if (!appleIdToken) {
      return sendErrorResponse(req, res, 400, "Validation Error", "idToken is required");
    }

    let verified;
    try {
      // firstName/lastName only ever arrive from the client on the user's
      // very first Apple authorization — Apple never sends a name in the
      // token itself, and never resends it on later sign-ins.
      verified = await verifyAppleIdToken(appleIdToken, { firstName, lastName });
    } catch (err) {
      console.error("Apple ID token verification failed:", err);
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired Apple ID token");
    }

    const result = await completeSocialSignIn({ ...verified, provider: "apple" });
    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    console.error("Apple sign-in error:", error);
    handleError(req, res, error);
  }
});

app.post("/login", async (req, res) => {
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
      apiKey = await getFirebaseApiKey() as string;
    } catch (error) {
      console.error("FIREBASE_WEB_API_KEY not configured:", (error as Error).message);
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    try {
      await authService.verifyPassword(email, password, apiKey);
    } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid email or password");
    }

    let userRecord: { uid: string; email: string };
    try {
      userRecord = await authService.getUserByEmail(email) as { uid: string; email: string };
    } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "User not found");
    }

    let studentDoc: { id: string; data: () => Record<string, unknown> } | null;
    try {
      studentDoc = await authService.getStudentProfileByAuthUid(userRecord.uid) as
        { id: string; data: () => Record<string, unknown> } | null;
    } catch (error) {
      console.error("Student login — Firestore profile lookup failed:", (error as Error).message, error);
      return sendErrorResponse(req, res, 500, "Internal Server Error", "An unexpected error occurred");
    }
    if (!studentDoc) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Student profile not found");
    }
    const studentData = studentDoc.data();

    try {
      await instructorLinkingService.claimPlaceholderInstructorsForAuthUid(userRecord.uid, userRecord.email);
    } catch (claimError) {
      console.error("Error claiming placeholder instructor rows during login:", claimError);
    }

    let tokenResponse: { idToken: string; refreshToken: string; expiresIn: string };
    try {
      const customToken = await authService.createCustomToken(userRecord.uid);
      tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey) as {
        idToken: string; refreshToken: string; expiresIn: string;
      };
    } catch (error) {
      console.error("Student login — token creation failed:", (error as Error).message, error);
      return sendErrorResponse(req, res, 500, "Internal Server Error", "An unexpected error occurred");
    }

    sendJsonResponse(req, res, 200, {
      idToken: tokenResponse.idToken,
      refreshToken: tokenResponse.refreshToken,
      expiresIn: tokenResponse.expiresIn,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        studentProfileId: studentDoc.id,
        autoCheckInClassIds: (studentData["autoCheckInClassIds"] as string[]) || [],
      },
    });
  } catch (error) {
    console.error("Student login error:", error);
    handleError(req, res, error);
  }
});

app.get("/me", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string; data: () => Record<string, unknown> } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const studentData = studentDoc.data() as Record<string, unknown>;
    const studiosBase = studioEnrollmentService.ensureStudiosStructure(studentData) as Record<string, unknown>;

    // Which studios are browsable/relevant stays family-wide (the parent
    // profile's own studios map) — only the credit BALANCE per studio is
    // scoped to whichever profile the caller is asking about.
    const dependentId = typeof req.query["dependentId"] === "string" ? req.query["dependentId"] as string : undefined;
    const studiosWithLiveCredits: Record<string, { credits: number }> = {};
    for (const studioId of Object.keys(studiosBase)) {
      const credits = await creditTrackingService.getLiveCreditsForAuthUser(user.uid, studioId, dependentId) as number;
      studiosWithLiveCredits[studioId] = { credits };
    }

    const instructorLinksRaw = (studentData["instructorLinks"] as Record<string, { instructorId: string }>) ?? {};
    const instructorLinks = await Promise.all(
      Object.entries(instructorLinksRaw).map(async ([studioOwnerId, link]) => {
        let studioName = "Studio";
        try {
          const studioDoc = await getFirestore().collection("users").doc(studioOwnerId).get();
          if (studioDoc.exists) {
            studioName = ((studioDoc.data() as Record<string, unknown>)["studioName"] as string) || studioName;
          }
        } catch { /* fall back to default label */ }
        return { studioOwnerId, instructorId: link.instructorId, studioName };
      }),
    );

    const dependentsSnapshot = await getFirestore()
      .collection("usersStudentProfiles").doc(studentDoc.id).collection("dependents").get();
    const dependents = dependentsSnapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        firstName: data["firstName"] || "",
        lastName: data["lastName"] || "",
        photoURL: data["photoURL"] || null,
        graduatedAt: data["graduatedAt"] || null,
        graduationPending: !!data["graduationClaimCode"],
        graduationClaimCodeExpiresAt: data["graduationClaimCodeExpiresAt"] || null,
      };
    });

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studentProfileId: studentDoc.id,
      autoCheckInClassIds: (studentData["autoCheckInClassIds"] as string[]) || [],
      instructorLinks,
      dependents,
      profile: {
        firstName: studentData["firstName"],
        lastName: studentData["lastName"],
        city: studentData["city"],
        state: studentData["state"],
        zip: studentData["zip"],
        phone: studentData["phone"] || null,
        danceGenres: (studentData["danceGenres"] as string[]) || (studentData["danceGenre"] ? [studentData["danceGenre"]] : []),
        subscribeToNewsletter: studentData["subscribeToNewsletter"] || false,
        photoURL: studentData["photoURL"] || null,
        role: studentData["role"] || "student",
        studios: studiosWithLiveCredits,
        studioIds: Object.keys(studiosWithLiveCredits),
        deletionStatus: studentData["deletionStatus"] || null,
      },
    });
  } catch (error) {
    console.error("Get student profile error:", error);
    handleError(req, res, error);
  }
});

app.put("/me", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const { firstName, lastName, city, state, zip, phone, danceGenres, subscribeToNewsletter, avatarFile } = req.body as {
      firstName?: string; lastName?: string; city?: string; state?: string; zip?: string;
      phone?: string; danceGenres?: string[]; subscribeToNewsletter?: boolean; avatarFile?: string;
    };

    const updateData: Record<string, unknown> = {
      firstName: firstName?.trim(),
      lastName: lastName?.trim(),
      city: city?.trim(),
      state: state?.trim().toUpperCase(),
      zip: zip?.trim(),
      phone: phone ? phone.trim() : null,
      danceGenres: Array.isArray(danceGenres) ? danceGenres : [],
      subscribeToNewsletter: subscribeToNewsletter || false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (avatarFile && typeof avatarFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(avatarFile);
        const mimeType = storageService.getMimeTypeFromBase64(avatarFile);
        const ext = (mimeType as string).split("/")[1];
        const fileName = `avatar-${user.uid}.${ext}`;
        const avatarUrl = await storageService.uploadStudentAvatar(fileBuffer, fileName, mimeType, user.uid) as string;
        updateData["photoURL"] = avatarUrl;
      } catch (imageError) {
        console.error("Error uploading avatar:", imageError);
      }
    }

    const db = getFirestore();
    await db.collection("usersStudentProfiles").doc(studentDoc.id).update(updateData);

    if (phone !== undefined) {
      try {
        const studentsSnapshot = await db.collection("students").where("authUid", "==", user.uid).get();
        const batch = db.batch();
        studentsSnapshot.forEach((doc) => {
          batch.update(doc.ref, { phone: phone ? phone.trim() : null });
        });
        if (!studentsSnapshot.empty) await batch.commit();
      } catch (syncError) {
        console.error("Error syncing phone to students collection:", syncError);
      }
    }

    const updatedDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string; data: () => Record<string, unknown> };
    const updatedData = updatedDoc.data() as Record<string, unknown>;

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studentProfileId: updatedDoc.id,
      profile: {
        firstName: updatedData["firstName"],
        lastName: updatedData["lastName"],
        city: updatedData["city"],
        state: updatedData["state"],
        zip: updatedData["zip"],
        phone: updatedData["phone"] || null,
        danceGenres: (updatedData["danceGenres"] as string[]) || (updatedData["danceGenre"] ? [updatedData["danceGenre"]] : []),
        subscribeToNewsletter: updatedData["subscribeToNewsletter"] || false,
        photoURL: updatedData["photoURL"] || null,
        role: updatedData["role"] || "student",
      },
    });
  } catch (error) {
    console.error("Update student profile error:", error);
    handleError(req, res, error);
  }
});

app.delete("/me/avatar", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string; data: () => Record<string, unknown> } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const studentData = studentDoc.data() as Record<string, unknown>;
    const photoURL = studentData["photoURL"] as string | null;

    if (photoURL) {
      try {
        await storageService.deleteFile(photoURL);
      } catch (storageError) {
        console.error("Error deleting avatar from storage:", storageError);
      }
    }

    const db = getFirestore();
    await db.collection("usersStudentProfiles").doc(studentDoc.id).update({
      photoURL: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const updatedDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string; data: () => Record<string, unknown> };
    const updatedData = updatedDoc.data() as Record<string, unknown>;

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studentProfileId: updatedDoc.id,
      profile: {
        firstName: updatedData["firstName"],
        lastName: updatedData["lastName"],
        city: updatedData["city"],
        state: updatedData["state"],
        zip: updatedData["zip"],
        danceGenres: (updatedData["danceGenres"] as string[]) || (updatedData["danceGenre"] ? [updatedData["danceGenre"]] : []),
        subscribeToNewsletter: updatedData["subscribeToNewsletter"] || false,
        photoURL: null,
        role: updatedData["role"] || "student",
      },
    });
  } catch (error) {
    console.error("Delete student avatar error:", error);
    handleError(req, res, error);
  }
});

// ─── Family accounts: dependent profiles ───────────────────────────────────
// A dependent is a parent-managed dancer profile with no login of its own —
// every students/purchases/privateLessonBookings row created on its behalf
// still carries the PARENT's authUid (see dependentId on those collections).

function generateClaimCode(): string {
  // Excludes 0/O/1/I/L — this code gets read aloud or typed by a kid, so
  // ambiguous characters are worth avoiding even at a small cost to entropy.
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(10);
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += alphabet[bytes[i]! % alphabet.length];
  }
  return code;
}

app.get("/dependents", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");

    const snapshot = await getFirestore()
      .collection("usersStudentProfiles").doc(studentDoc.id).collection("dependents").get();
    const dependents = snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        firstName: data["firstName"] || "",
        lastName: data["lastName"] || "",
        photoURL: data["photoURL"] || null,
        graduatedAt: data["graduatedAt"] || null,
        graduationPending: !!data["graduationClaimCode"],
        graduationClaimCodeExpiresAt: data["graduationClaimCodeExpiresAt"] || null,
      };
    });
    sendJsonResponse(req, res, 200, dependents);
  } catch (error) {
    console.error("List dependents error:", error);
    handleError(req, res, error);
  }
});

app.post("/dependents", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { firstName, lastName } = req.body as { firstName?: string; lastName?: string };
    if (!firstName?.trim() || !lastName?.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "firstName and lastName are required");
    }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");

    const db = getFirestore();
    const dependentRef = db.collection("usersStudentProfiles").doc(studentDoc.id).collection("dependents").doc();
    await dependentRef.set({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      photoURL: null,
      graduatedAt: null,
      graduatedToAuthUid: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 201, { id: dependentRef.id, firstName: firstName.trim(), lastName: lastName.trim(), photoURL: null, graduatedAt: null });
  } catch (error) {
    console.error("Create dependent error:", error);
    handleError(req, res, error);
  }
});

app.patch("/dependents/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const dependentId = req.params["id"] as string;
    const { firstName, lastName, photoURL } = req.body as { firstName?: string; lastName?: string; photoURL?: string | null };

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");

    const db = getFirestore();
    const dependentRef = db.collection("usersStudentProfiles").doc(studentDoc.id).collection("dependents").doc(dependentId);
    const dependentDoc = await dependentRef.get();
    if (!dependentDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Dependent not found");

    const updateData: Record<string, unknown> = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (firstName?.trim()) updateData["firstName"] = firstName.trim();
    if (lastName?.trim()) updateData["lastName"] = lastName.trim();
    if (photoURL !== undefined) updateData["photoURL"] = photoURL || null;
    await dependentRef.update(updateData);

    // Keep the name on any existing roster rows in sync, matching how /me PUT
    // already syncs the account holder's own phone number to their rows.
    if (updateData["firstName"] || updateData["lastName"]) {
      const rosterRows = await db.collection("students")
        .where("authUid", "==", user.uid).where("dependentId", "==", dependentId).get();
      if (!rosterRows.empty) {
        const batch = db.batch();
        rosterRows.forEach((doc) => {
          batch.update(doc.ref, {
            ...(updateData["firstName"] ? { firstName: updateData["firstName"] } : {}),
            ...(updateData["lastName"] ? { lastName: updateData["lastName"] } : {}),
          });
        });
        await batch.commit();
      }
    }

    sendJsonResponse(req, res, 200, { id: dependentId });
  } catch (error) {
    console.error("Update dependent error:", error);
    handleError(req, res, error);
  }
});

app.delete("/dependents/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const dependentId = req.params["id"] as string;
    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");

    const db = getFirestore();
    const dependentRef = db.collection("usersStudentProfiles").doc(studentDoc.id).collection("dependents").doc(dependentId);
    const dependentDoc = await dependentRef.get();
    if (!dependentDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Dependent not found");

    const [rosterRows, purchaseRows, bookingRows] = await Promise.all([
      db.collection("students").where("authUid", "==", user.uid).where("dependentId", "==", dependentId).limit(1).get(),
      db.collection("purchases").where("authUid", "==", user.uid).where("dependentId", "==", dependentId).limit(1).get(),
      db.collection("privateLessonBookings").where("authUid", "==", user.uid).where("dependentId", "==", dependentId).limit(1).get(),
    ]);
    if (!rosterRows.empty || !purchaseRows.empty || !bookingRows.empty) {
      return sendErrorResponse(req, res, 400, "Bad Request",
        "This dependent has class enrollment, purchase, or booking history and can't be deleted. Graduate them to their own account instead if they no longer need this profile.");
    }

    await dependentRef.delete();
    sendJsonResponse(req, res, 200, { id: dependentId, deleted: true });
  } catch (error) {
    console.error("Delete dependent error:", error);
    handleError(req, res, error);
  }
});

app.post("/dependents/:id/graduate/initiate", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const dependentId = req.params["id"] as string;
    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string; data: () => Record<string, unknown> } | null;
    if (!studentDoc) return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");

    const db = getFirestore();
    const dependentRef = db.collection("usersStudentProfiles").doc(studentDoc.id).collection("dependents").doc(dependentId);
    const dependentDoc = await dependentRef.get();
    if (!dependentDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Dependent not found");
    const dependentData = dependentDoc.data() as Record<string, unknown>;
    if (dependentData["graduatedAt"]) {
      return sendErrorResponse(req, res, 400, "Bad Request", "This dependent has already graduated");
    }

    const code = generateClaimCode();
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.collection("dependentGraduationClaims").doc(code).set({
      parentId: studentDoc.id,
      dependentId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
    });
    await dependentRef.update({
      graduationClaimCode: code,
      graduationClaimCodeExpiresAt: expiresAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Best-effort — the code is already generated and usable even if this fails, so a
    // SendGrid hiccup shouldn't block the response the parent is waiting on.
    const parentData = studentDoc.data();
    sendGraduationCodeEmail(
      (parentData["email"] as string) || user.email || "",
      (parentData["firstName"] as string) || "",
      (dependentData["firstName"] as string) || "",
      code,
      expiresAt.toDate(),
    ).catch((err) => console.error("Failed to send graduation code email:", err));

    sendJsonResponse(req, res, 200, { code, expiresAt: expiresAt.toDate().toISOString() });
  } catch (error) {
    console.error("Initiate graduation error:", error);
    handleError(req, res, error);
  }
});

app.post("/dependents/:id/graduate/cancel", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const dependentId = req.params["id"] as string;
    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");

    const db = getFirestore();
    const dependentRef = db.collection("usersStudentProfiles").doc(studentDoc.id).collection("dependents").doc(dependentId);
    const dependentDoc = await dependentRef.get();
    if (!dependentDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Dependent not found");
    const existingCode = (dependentDoc.data() as Record<string, unknown>)["graduationClaimCode"] as string | undefined;

    if (existingCode) {
      await db.collection("dependentGraduationClaims").doc(existingCode).delete();
    }
    await dependentRef.update({
      graduationClaimCode: admin.firestore.FieldValue.delete(),
      graduationClaimCodeExpiresAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { id: dependentId, cancelled: true });
  } catch (error) {
    console.error("Cancel graduation error:", error);
    handleError(req, res, error);
  }
});

app.post("/graduate/redeem", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const code = (req.body as { code?: string }).code?.trim().toUpperCase();
    if (!code) return sendErrorResponse(req, res, 400, "Validation Error", "code is required");

    const db = getFirestore();
    const claimRef = db.collection("dependentGraduationClaims").doc(code);
    const claimDoc = await claimRef.get();
    if (!claimDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "This code isn't valid. Double-check it and try again.");
    }
    const claimData = claimDoc.data() as { parentId: string; dependentId: string; expiresAt: admin.firestore.Timestamp };
    if (claimData.expiresAt.toMillis() < Date.now()) {
      await claimRef.delete();
      return sendErrorResponse(req, res, 400, "Bad Request", "This code has expired. Ask for a new one.");
    }

    const dependentRef = db.collection("usersStudentProfiles").doc(claimData.parentId)
      .collection("dependents").doc(claimData.dependentId);
    const dependentDoc = await dependentRef.get();
    if (!dependentDoc.exists) {
      await claimRef.delete();
      return sendErrorResponse(req, res, 404, "Not Found", "This dependent profile no longer exists");
    }

    await studioEnrollmentService.claimDependentRosterRowsForNewAuthUid(claimData.dependentId, user.uid);

    // The new account starts its own auto-checkin preferences from scratch —
    // strip any entries the parent had set for this dependent, since those
    // roster rows the parent no longer owns after the re-point above.
    const parentProfileRef = db.collection("usersStudentProfiles").doc(claimData.parentId);
    const parentProfileDoc = await parentProfileRef.get();
    const parentData = parentProfileDoc.data() as Record<string, unknown> | undefined;
    const existingEntries = (parentData?.["autoCheckInEntries"] as Array<{ dependentId?: string }>) || [];
    if (existingEntries.some((e) => e.dependentId === claimData.dependentId)) {
      await parentProfileRef.update({
        autoCheckInEntries: existingEntries.filter((e) => e.dependentId !== claimData.dependentId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await dependentRef.update({
      graduatedAt: admin.firestore.FieldValue.serverTimestamp(),
      graduatedToAuthUid: user.uid,
      graduationClaimCode: admin.firestore.FieldValue.delete(),
      graduationClaimCodeExpiresAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await claimRef.delete();

    sendJsonResponse(req, res, 200, { graduated: true });
  } catch (error) {
    console.error("Redeem graduation error:", error);
    handleError(req, res, error);
  }
});

app.patch("/auto-checkin-prefs", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }
    const db = getFirestore();

    // New shape: per-entry, optionally per-dependent. Kept as a separate body
    // key (not a replacement) so existing mobile clients sending the flat
    // legacy shape below keep working completely unchanged.
    const rawEntries = (req.body as { entries?: unknown }).entries;
    if (rawEntries !== undefined) {
      if (!Array.isArray(rawEntries) || rawEntries.length > 50) {
        return sendErrorResponse(req, res, 400, "Bad Request", "entries must be an array of at most 50 items");
      }
      const entries: Array<{ classId: string; studioOwnerId: string; dependentId: string | null }> = [];
      for (const raw of rawEntries) {
        const classId = (raw as Record<string, unknown>)?.["classId"];
        const dependentId = (raw as Record<string, unknown>)?.["dependentId"];
        if (typeof classId !== "string" || (dependentId !== undefined && dependentId !== null && typeof dependentId !== "string")) {
          return sendErrorResponse(req, res, 400, "Bad Request", "Each entry needs a classId (string) and optional dependentId (string)");
        }
        // studioOwnerId is resolved server-side, never trusted from the client
        // — matches how attendance.ts already resolves it from the class doc.
        const classDoc = await db.collection("classes").doc(classId).get();
        if (!classDoc.exists) continue;
        const studioOwnerId = (classDoc.data() as Record<string, unknown>)["studioOwnerId"] as string | undefined;
        if (!studioOwnerId) continue;
        entries.push({ classId, studioOwnerId, dependentId: (dependentId as string) || null });
      }

      await db.collection("usersStudentProfiles").doc(studentDoc.id).update({
        autoCheckInEntries: entries,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return sendJsonResponse(req, res, 200, { entries });
    }

    // Legacy shape — self only, unchanged from before family accounts existed.
    const { autoCheckInClassIds } = req.body as { autoCheckInClassIds?: unknown };
    if (!Array.isArray(autoCheckInClassIds) || autoCheckInClassIds.some((id) => typeof id !== "string")) {
      return sendErrorResponse(req, res, 400, "Bad Request", "autoCheckInClassIds must be an array of strings");
    }
    if (autoCheckInClassIds.length > 50) {
      return sendErrorResponse(req, res, 400, "Bad Request", "autoCheckInClassIds cannot exceed 50 items");
    }

    await db.collection("usersStudentProfiles").doc(studentDoc.id).update({
      autoCheckInClassIds,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { autoCheckInClassIds });
  } catch (error) {
    console.error("Error updating auto check-in prefs:", error);
    handleError(req, res, error);
  }
});

app.patch("/me/fcm-token", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { fcmToken } = req.body as { fcmToken?: string };
    if (!fcmToken || typeof fcmToken !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "fcmToken is required");
    }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const db = getFirestore();
    await db.collection("usersStudentProfiles").doc(studentDoc.id).update({
      fcmToken,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { success: true });
  } catch (error) {
    console.error("Error updating FCM token:", error);
    handleError(req, res, error);
  }
});

app.get("/my-classes", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioIds = await studentsService.getEnrolledStudios(user.uid) as string[];
    if (studioIds.length === 0) {
      return sendJsonResponse(req, res, 200, { upcoming: [], past: [] });
    }

    const allClasses: Array<Record<string, unknown>> = [];
    for (const studioId of studioIds) {
      try {
        const classes = await classesService.getClasses(studioId) as Array<Record<string, unknown>>;
        const activeClasses = classes.filter((cls) => cls["isActive"]);
        allClasses.push(...activeClasses.map((cls) => ({ ...cls, studioOwnerId: studioId })));
      } catch (error) {
        console.error(`Error fetching classes for studio ${studioId}:`, error);
      }
    }

    const now = new Date();
    const upcoming: Array<Record<string, unknown>> = [];
    const past: Array<Record<string, unknown>> = [];

    for (const classData of allClasses) {
      try {
        const studio = await studiosService.getPublicStudioById(classData["studioOwnerId"] as string) as Record<string, unknown> | null;
        if (!studio) continue;

        const nextInstance = studentsService.calculateNextClassInstance(
          classData["dayOfWeek"] as string,
          classData["startTime"] as string,
          now,
        ) as Date;

        if (nextInstance > now) {
          upcoming.push({
            id: classData["id"],
            name: classData["name"],
            level: classData["level"],
            cost: classData["cost"],
            dayOfWeek: classData["dayOfWeek"],
            startTime: classData["startTime"],
            endTime: classData["endTime"],
            description: classData["description"],
            room: classData["room"],
            danceGenre: classData["danceGenre"],
            instanceDate: nextInstance.toISOString(),
            studio: { id: studio["id"], name: studio["studioName"], city: studio["city"], state: studio["state"], lat: studio["studioLat"] ?? null, lng: studio["studioLng"] ?? null },
          });
        }

        const pastInstances = studentsService.calculatePastClassInstances(
          classData["dayOfWeek"] as string,
          classData["startTime"] as string,
          now,
          30,
        ) as Date[];

        for (const instanceDate of pastInstances) {
          past.push({
            id: classData["id"],
            name: classData["name"],
            level: classData["level"],
            cost: classData["cost"],
            dayOfWeek: classData["dayOfWeek"],
            startTime: classData["startTime"],
            endTime: classData["endTime"],
            description: classData["description"],
            room: classData["room"],
            danceGenre: classData["danceGenre"],
            instanceDate: instanceDate.toISOString(),
            studio: { id: studio["id"], name: studio["studioName"], city: studio["city"], state: studio["state"], lat: studio["studioLat"] ?? null, lng: studio["studioLng"] ?? null },
          });
        }
      } catch (error) {
        console.error(`Error processing class ${classData["id"] as string}:`, error);
      }
    }

    upcoming.sort((a, b) => new Date(a["instanceDate"] as string).getTime() - new Date(b["instanceDate"] as string).getTime());
    past.sort((a, b) => new Date(b["instanceDate"] as string).getTime() - new Date(a["instanceDate"] as string).getTime());

    sendJsonResponse(req, res, 200, { upcoming, past });
  } catch (error) {
    console.error("Error getting my classes:", error);
    handleError(req, res, error);
  }
});

app.get("/my-workshops", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const purchasesSnapshot = await db.collection("purchases")
      .where("authUid", "==", user.uid)
      .where("purchaseType", "==", "workshop")
      .where("status", "==", "completed")
      .get();

    if (purchasesSnapshot.empty) {
      return sendJsonResponse(req, res, 200, { upcoming: [], past: [] });
    }

    const now = new Date();
    const upcoming: Array<Record<string, unknown>> = [];
    const past: Array<Record<string, unknown>> = [];

    for (const doc of purchasesSnapshot.docs) {
      const purchase = doc.data() as Record<string, unknown>;
      const workshopId = purchase["itemId"] as string;

      try {
        const workshop = await workshopsService.getPublicWorkshopById(workshopId) as Record<string, unknown> | null;
        if (!workshop) continue;

        const studioId = (workshop["studioOwnerId"] as string) || ((workshop["studio"] as Record<string, unknown>)?.["id"] as string) || (purchase["studioOwnerId"] as string);
        let studioInfo: Record<string, unknown> = { id: studioId, name: purchase["studioName"] || "Studio", city: "", state: "" };
        if (studioId) {
          try {
            const studio = await studiosService.getPublicStudioById(studioId) as Record<string, unknown> | null;
            if (studio) studioInfo = { id: studio["id"], name: studio["studioName"], city: studio["city"], state: studio["state"] };
          } catch { /* use fallback */ }
        }

        const startRaw = workshop["startTime"] as { toDate?: () => Date } | string | null;
        const endRaw = workshop["endTime"] as { toDate?: () => Date } | string | null;
        const startTime = startRaw && typeof startRaw === "object" && startRaw.toDate ? startRaw.toDate() : new Date(startRaw as string);
        const endTime = endRaw && typeof endRaw === "object" && endRaw.toDate ? endRaw.toDate() : new Date(endRaw as string);

        const workshopData: Record<string, unknown> = {
          id: workshop["id"] || workshopId,
          purchaseId: doc.id,
          name: workshop["name"],
          levels: workshop["levels"] || [],
          description: workshop["description"],
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          imageUrl: workshop["imageUrl"],
          priceTiers: workshop["priceTiers"] || [],
          addressLine1: workshop["addressLine1"] || "",
          addressLine2: workshop["addressLine2"],
          city: workshop["city"] || "",
          state: workshop["state"] || "",
          zip: workshop["zip"] || "",
          locationName: workshop["locationName"],
          studio: studioInfo,
          isCheckedIn: purchase["checkedIn"] || false,
        };

        if (endTime > now) upcoming.push(workshopData);
        else past.push(workshopData);
      } catch (error) {
        console.error(`Error processing workshop purchase ${doc.id}:`, error);
      }
    }

    upcoming.sort((a, b) => new Date(a["startTime"] as string).getTime() - new Date(b["startTime"] as string).getTime());
    past.sort((a, b) => new Date(b["startTime"] as string).getTime() - new Date(a["startTime"] as string).getTime());

    sendJsonResponse(req, res, 200, { upcoming, past });
  } catch (error) {
    console.error("Error getting my workshops:", error);
    handleError(req, res, error);
  }
});

app.get("/my-events", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioIds = await studentsService.getEnrolledStudios(user.uid) as string[];
    if (studioIds.length === 0) {
      return sendJsonResponse(req, res, 200, { upcoming: [], past: [] });
    }

    const allEvents: Array<Record<string, unknown>> = [];
    for (const studioId of studioIds) {
      try {
        const events = await eventsService.getEvents(studioId) as Array<Record<string, unknown>>;
        allEvents.push(...events.map((e) => ({ ...e, studioOwnerId: studioId })));
      } catch (error) {
        console.error(`Error fetching events for studio ${studioId}:`, error);
      }
    }

    const now = new Date();
    const upcoming: Array<Record<string, unknown>> = [];
    const past: Array<Record<string, unknown>> = [];

    for (const event of allEvents) {
      try {
        const studio = await studiosService.getPublicStudioById(event["studioOwnerId"] as string) as Record<string, unknown> | null;
        if (!studio) continue;

        const startRaw = event["startTime"] as { toDate?: () => Date } | string | null;
        const endRaw = event["endTime"] as { toDate?: () => Date } | string | null;
        const startTime = startRaw && typeof startRaw === "object" && startRaw.toDate ? startRaw.toDate() : new Date(startRaw as string);
        const endTime = endRaw
          ? (typeof endRaw === "object" && endRaw.toDate ? endRaw.toDate() : new Date(endRaw as string))
          : null;

        const eventData: Record<string, unknown> = {
          id: event["id"],
          name: event["name"],
          type: event["type"],
          description: event["description"],
          startTime: startTime.toISOString(),
          endTime: endTime ? endTime.toISOString() : null,
          imageUrl: event["imageUrl"],
          priceTiers: event["priceTiers"],
          addressLine1: event["addressLine1"],
          addressLine2: event["addressLine2"],
          city: event["city"],
          state: event["state"],
          zip: event["zip"],
          locationName: event["locationName"],
          studio: { id: studio["id"], name: studio["studioName"], city: studio["city"], state: studio["state"] },
        };

        const compareTime = endTime || startTime;
        if (compareTime > now) upcoming.push(eventData);
        else past.push(eventData);
      } catch (error) {
        console.error(`Error processing event ${event["id"] as string}:`, error);
      }
    }

    upcoming.sort((a, b) => new Date(a["startTime"] as string).getTime() - new Date(b["startTime"] as string).getTime());
    past.sort((a, b) => new Date(b["startTime"] as string).getTime() - new Date(a["startTime"] as string).getTime());

    sendJsonResponse(req, res, 200, { upcoming, past });
  } catch (error) {
    console.error("Error getting my events:", error);
    handleError(req, res, error);
  }
});

app.get("/event-passes", async (req, res) => {
  let user;
  try {
    user = await verifyToken(req);
  } catch (authError) {
    return handleError(req, res, authError);
  }

  try {
    const db = getFirestore();

    const purchasesSnap = await db.collection("purchases")
      .where("authUid", "==", user.uid)
      .where("status", "==", "completed")
      .get();

    // Filtered in code, not via a Firestore equality clause, since this already fetches
    // every completed purchase for the account — no new composite index needed, and
    // legacy rows with no dependentId field at all are unaffected when unfiltered.
    const dependentId = typeof req.query["dependentId"] === "string" ? req.query["dependentId"] as string : undefined;
    const relevantPurchases = purchasesSnap.docs.filter((doc) => {
      const data = doc.data();
      const t = data["purchaseType"] as string;
      if (t !== "event" && t !== "workshop") return false;
      if (dependentId === undefined) return true;
      return (data["dependentId"] as string | null | undefined) === dependentId;
    });

    // Batch-fetch item docs for startTime/endTime
    const itemFetches = relevantPurchases.map(async (doc) => {
      const data = doc.data() as Record<string, unknown>;
      const purchaseType = data["purchaseType"] as string;
      const itemId = data["itemId"] as string;
      const collection = purchaseType === "event" ? "events" : "workshops";

      let startTime = "";
      let endTime = "";
      try {
        const itemDoc = await db.collection(collection).doc(itemId).get();
        if (itemDoc.exists) {
          const itemData = itemDoc.data() as Record<string, unknown>;
          const startRaw = itemData["startTime"] as { toDate?: () => Date } | string | null;
          const endRaw = itemData["endTime"] as { toDate?: () => Date } | string | null;
          startTime = startRaw && typeof startRaw === "object" && startRaw.toDate
            ? startRaw.toDate().toISOString()
            : (typeof startRaw === "string" ? startRaw : "");
          endTime = endRaw && typeof endRaw === "object" && endRaw.toDate
            ? endRaw.toDate().toISOString()
            : (typeof endRaw === "string" ? endRaw : "");
        }
      } catch (_) { /* item may have been deleted */ }

      return {
        name: (data["itemName"] as string) || "",
        studioName: (data["studioName"] as string) || "",
        startTime,
        endTime,
        eventCode: doc.id,
        eventId: purchaseType === "event" ? itemId : undefined,
        workshopId: purchaseType === "workshop" ? itemId : undefined,
      };
    });

    const passes = await Promise.all(itemFetches);
    sendJsonResponse(req, res, 200, passes);
  } catch (error) {
    console.error("Error fetching event passes:", error);
    handleError(req, res, error);
  }
});

app.post("/forgot-password", async (req, res) => {
  try {
    const validation = validateForgotPasswordPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid request data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const { email } = req.body as { email: string };
    const baseResetUrl = process.env["PASSWORD_RESET_URL"] || `${req.headers.origin || "https://danceup.app"}/reset-password`;

    try {
      const oobCode = await authService.generatePasswordResetOobCode(email);
      const resetUrl = `${baseResetUrl}?oobCode=${encodeURIComponent(oobCode)}`;
      await sendPasswordResetEmail(email, resetUrl);
    } catch (emailError) {
      const msg = (emailError as Error).message || "";
      if (!msg.includes("user-not-found") && !msg.includes("No user found")) throw emailError;
    }

    sendJsonResponse(req, res, 200, { message: "If an account with that email exists, a password reset link has been sent." });
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
      apiKey = await getFirebaseApiKey() as string;
    } catch (error) {
      console.error("FIREBASE_WEB_API_KEY not configured:", (error as Error).message);
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    try {
      await authService.verifyPasswordForReauth(user.email, currentPassword, apiKey);
    } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Incorrect password");
    }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { id: string } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    await authService.updateUserEmail(user.uid, newEmail);

    const db = getFirestore();
    await db.collection("usersStudentProfiles").doc(studentDoc.id).update({
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

app.get("/notifications/unread-count", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    const db = getFirestore();
    const snapshot = await db.collection("studentNotifications")
      .where("authUid", "==", user.uid)
      .where("read", "==", false)
      .get();
    sendJsonResponse(req, res, 200, { count: snapshot.size });
  } catch (error) {
    console.error("Error fetching unread notification count:", error);
    handleError(req, res, error);
  }
});

app.get("/notifications", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const snapshot = await db.collection("studentNotifications")
      .where("authUid", "==", user.uid)
      .orderBy("createdAt", "desc")
      .limit(30)
      .get();

    const notifications = snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const ts = data["createdAt"] as admin.firestore.Timestamp | null;
      return {
        id: doc.id,
        type: data["type"] ?? "general",
        title: data["title"] ?? "",
        body: data["body"] ?? "",
        read: data["read"] ?? false,
        createdAt: ts ? ts.toDate().toISOString() : new Date().toISOString(),
      };
    });

    sendJsonResponse(req, res, 200, notifications);
  } catch (error) {
    console.error("Error fetching student notifications:", error);
    handleError(req, res, error);
  }
});

app.patch("/notifications/read-all", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const snapshot = await db.collection("studentNotifications")
      .where("authUid", "==", user.uid)
      .where("read", "==", false)
      .limit(50)
      .get();

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.update(doc.ref, { read: true }));
    await batch.commit();

    sendJsonResponse(req, res, 200, { updated: snapshot.size });
  } catch (error) {
    console.error("Error marking notifications as read:", error);
    handleError(req, res, error);
  }
});

app.post("/logout", async (req, res) => {
  try {
    try { await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    sendJsonResponse(req, res, 200, { message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    handleError(req, res, error);
  }
});

app.get("/config/stripe", async (req, res) => {
  try {
    const publishableKey = await getStripePublishableKey() as string;
    sendJsonResponse(req, res, 200, { publishableKey });
  } catch (error) {
    console.error("Error fetching Stripe publishable key:", error);
    handleError(req, res, error);
  }
});

app.post("/me/payment-methods/setup", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { data: () => Record<string, unknown> } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const profileData = studentDoc.data() as { stripeCustomerId?: string; email?: string; firstName?: string; lastName?: string; studentProfileId?: string };
    let { stripeCustomerId } = profileData;

    if (!stripeCustomerId) {
      const email = profileData.email || user.email || "";
      const name = [profileData.firstName, profileData.lastName].filter(Boolean).join(" ");
      const stripeCustomer = await createCustomer(email, { uid: user.uid, name }) as { id: string; email: string };
      const db = getFirestore();
      const docId = (studentDoc as unknown as { id: string }).id;
      await db.collection("usersStudentProfiles").doc(docId).update({
        stripeCustomerId: stripeCustomer.id,
        stripeEmail: stripeCustomer.email,
      });
      stripeCustomerId = stripeCustomer.id;
    }

    const setupIntent = await createSetupIntent(stripeCustomerId) as { client_secret: string };
    sendJsonResponse(req, res, 200, { clientSecret: setupIntent.client_secret });
  } catch (error) {
    console.error("Error creating setup intent:", error);
    handleError(req, res, error);
  }
});

app.get("/me/payment-methods", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { data: () => Record<string, unknown> } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const { stripeCustomerId } = studentDoc.data() as { stripeCustomerId?: string };
    if (!stripeCustomerId) {
      return sendJsonResponse(req, res, 200, []);
    }

    const stripe = await getStripeClient();
    const [paymentMethods, customer] = await Promise.all([
      listPaymentMethods(stripeCustomerId) as unknown as Promise<Array<Record<string, unknown>>>,
      stripe.customers.retrieve(stripeCustomerId),
    ]);

    const customerData = customer as unknown as Record<string, unknown>;
    const defaultPmId = customerData["deleted"]
      ? null
      : ((customerData["invoice_settings"] as Record<string, unknown> | undefined)
          ?.["default_payment_method"] as string | null) ?? null;

    const simplified = (paymentMethods as Array<Record<string, unknown>>).map((pm) => {
      const card = (pm["card"] as Record<string, unknown>) || {};
      return {
        id: pm["id"],
        brand: card["brand"],
        last4: card["last4"],
        expMonth: card["exp_month"],
        expYear: card["exp_year"],
        isDefault: pm["id"] === defaultPmId,
      };
    });

    sendJsonResponse(req, res, 200, simplified);
  } catch (error) {
    console.error("Error fetching payment methods:", error);
    handleError(req, res, error);
  }
});

app.delete("/me/payment-methods/:paymentMethodId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { data: () => Record<string, unknown> } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const { stripeCustomerId } = studentDoc.data() as { stripeCustomerId?: string };
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account");
    }

    const paymentMethodId = req.params["paymentMethodId"] as string;
    const paymentMethods = await listPaymentMethods(stripeCustomerId) as unknown as Array<Record<string, unknown>>;
    const owned = paymentMethods.some((pm) => pm["id"] === paymentMethodId);
    if (!owned) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    await detachPaymentMethod(paymentMethodId);
    sendJsonResponse(req, res, 200, { success: true });
  } catch (error) {
    console.error("Error deleting payment method:", error);
    handleError(req, res, error);
  }
});

app.patch("/me/payment-methods/:paymentMethodId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { data: () => Record<string, unknown> } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const { stripeCustomerId } = studentDoc.data() as { stripeCustomerId?: string };
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account");
    }

    const paymentMethodId = req.params["paymentMethodId"] as string;
    const { expMonth, expYear } = req.body as { expMonth?: unknown; expYear?: unknown };

    if (!expMonth || !expYear) {
      return sendErrorResponse(req, res, 400, "Bad Request", "expMonth and expYear are required");
    }

    const paymentMethods = await listPaymentMethods(stripeCustomerId) as unknown as Array<Record<string, unknown>>;
    const owned = paymentMethods.some((pm) => pm["id"] === paymentMethodId);
    if (!owned) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    const updated = await updatePaymentMethod(paymentMethodId, Number(expMonth), Number(expYear)) as unknown as Record<string, unknown>;
    const card = (updated["card"] as Record<string, unknown>) || {};
    sendJsonResponse(req, res, 200, {
      id: updated["id"],
      brand: card["brand"],
      last4: card["last4"],
      expMonth: card["exp_month"],
      expYear: card["exp_year"],
    });
  } catch (error) {
    console.error("Error updating payment method:", error);
    handleError(req, res, error);
  }
});

app.patch("/me/payment-methods/:paymentMethodId/default", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid) as { data: () => Record<string, unknown> } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const { stripeCustomerId } = studentDoc.data() as { stripeCustomerId?: string };
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account");
    }

    const paymentMethodId = req.params["paymentMethodId"] as string;

    // Verify the PM belongs to this customer before setting it as default
    const paymentMethods = await listPaymentMethods(stripeCustomerId) as unknown as Array<Record<string, unknown>>;
    if (!paymentMethods.some((pm) => pm["id"] === paymentMethodId)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    await setDefaultPaymentMethod(stripeCustomerId, paymentMethodId);
    sendJsonResponse(req, res, 200, { success: true });
  } catch (error) {
    console.error("Error setting default payment method:", error);
    handleError(req, res, error);
  }
});

// POST /me/request-deletion — begin 90-day pending deletion window for a student account
app.post("/me/request-deletion", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { currentPassword } = req.body as { currentPassword?: string };
    if (!currentPassword || typeof currentPassword !== "string" || !currentPassword.trim()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Current password is required");
    }

    let apiKey: string;
    try {
      apiKey = await getFirebaseApiKey() as string;
    } catch (error) {
      console.error("FIREBASE_WEB_API_KEY not configured:", (error as Error).message);
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    try {
      await authService.verifyPasswordForReauth(user.email, currentPassword, apiKey);
    } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Incorrect password");
    }

    const db = getFirestore();
    const profileSnap = await db.collection("usersStudentProfiles")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (profileSnap.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const profileDoc = profileSnap.docs[0]!;
    const profileData = profileDoc.data() as Record<string, unknown>;

    if (profileData["deletionStatus"] === "pending") {
      return sendErrorResponse(req, res, 400, "Bad Request", "Account deletion already requested");
    }

    // Cancel any active Stripe subscriptions
    if (profileData["stripeCustomerId"]) {
      try {
        const stripe = await getStripeClient();
        const subscriptions = await stripe.subscriptions.list({
          customer: profileData["stripeCustomerId"] as string,
          status: "active",
        });
        for (const sub of subscriptions.data) {
          await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
        }
      } catch (stripeError) {
        console.error("Error cancelling student subscriptions during deletion request:", stripeError);
      }
    }

    await profileDoc.ref.update({
      deletionStatus: "pending",
      deletionRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {
      message: "Account deletion scheduled. Your account and personal data will be permanently deleted after 90 days.",
      deletionWindowDays: 90,
    });
  } catch (error) {
    console.error("Student request-deletion error:", error);
    handleError(req, res, error);
  }
});

// DELETE /me/cancel-deletion — cancel a pending deletion within the 90-day window
app.delete("/me/cancel-deletion", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const profileSnap = await db.collection("usersStudentProfiles")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (profileSnap.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const profileDoc = profileSnap.docs[0]!;
    const profileData = profileDoc.data() as Record<string, unknown>;

    if (profileData["deletionStatus"] !== "pending") {
      return sendErrorResponse(req, res, 400, "Bad Request", "No pending deletion to cancel");
    }

    await profileDoc.ref.update({
      deletionStatus: admin.firestore.FieldValue.delete(),
      deletionRequestedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { message: "Account deletion cancelled." });
  } catch (error) {
    console.error("Student cancel-deletion error:", error);
    handleError(req, res, error);
  }
});

// POST /checkin — self check-in for mobile students; uses auth token, no studentId required
app.post("/checkin", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { classId, classInstanceDate, dependentId } = req.body as { classId?: string; classInstanceDate?: string; dependentId?: string };
    if (!classId) return sendErrorResponse(req, res, 400, "Validation Error", "classId is required");
    if (!classInstanceDate) return sendErrorResponse(req, res, 400, "Validation Error", "classInstanceDate is required");

    const db = getFirestore();

    // Get studioOwnerId from the class document
    const classDoc = await db.collection("classes").doc(classId).get();
    if (!classDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Class not found");
    const classData = classDoc.data() as Record<string, unknown>;
    const studioOwnerId = classData["studioOwnerId"] as string | undefined;
    if (!studioOwnerId) return sendErrorResponse(req, res, 400, "Bad Request", "Class has no studio owner");

    // Find the student record in the old students collection using authUid + studioOwnerId,
    // scoped to a specific dependent's row when one is given.
    const studentId = dependentId
      ? await attendanceService.resolveOrCreateStudentIdForDependent(user.uid, studioOwnerId, dependentId)
      : await attendanceService.getStudentIdByAuthUidAndStudio(user.uid, studioOwnerId);
    if (!studentId) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student enrollment not found for this studio. Please contact your studio.");
    }

    // Delegate to attendance service (handles duplicate check, credits, record creation).
    // (Previously loaded via a dynamic require() with a path that doesn't resolve in the
    // compiled output — attendanceService is already imported above; use it directly.)
    await attendanceService.createAttendanceRecord(
      { studentId, classId, classInstanceDate, checkedInBy: "student" },
      studioOwnerId,
    );

    sendJsonResponse(req, res, 201, { message: "Checked in successfully", studentId, classId });
  } catch (error) {
    const msg = (error as Error).message ?? "";
    if (msg.toLowerCase().includes("already checked in") || msg.toLowerCase().includes("already checked")) {
      return sendErrorResponse(req, res, 409, "Conflict", "Already checked in");
    }
    if (msg.toLowerCase().includes("insufficient credits") || msg.toLowerCase().includes("no credits")) {
      return sendErrorResponse(req, res, 402, "Payment Required", "Insufficient credits");
    }
    console.error("Student checkin error:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const usersstudent = functions.https.onRequest(app);
