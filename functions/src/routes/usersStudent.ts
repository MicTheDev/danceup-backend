import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import authService from "../services/auth.service";
import storageService from "../services/storage.service";
import studioEnrollmentService from "../services/studio-enrollment.service";
import creditTrackingService from "../services/credit-tracking.service";
import studentsService from "../services/students.service";
import classesService from "../services/classes.service";
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
import { sendWelcomeEmail } from "../services/sendgrid.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { getFirebaseApiKey } from "../utils/firebase-api-key";
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

      // Attribute any prior guest purchases (same email, no authUid) to this new account
      try {
        const db = getFirestore();
        const guestPurchases = await db.collection("purchases")
          .where("guestEmail", "==", userRecord.email.toLowerCase())
          .where("authUid", "==", "guest")
          .get();
        if (!guestPurchases.empty) {
          const batch = db.batch();
          for (const doc of guestPurchases.docs) {
            batch.update(doc.ref, {
              authUid: userRecord.uid,
              studentId: studentProfileId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
          await batch.commit();
        }
      } catch (attributionError) {
        // Non-critical — log and continue
        console.error("Error attributing guest purchases:", attributionError);
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
          user: { uid: userRecord.uid, email: userRecord.email, studentProfileId },
        });
      }

      const tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey) as {
        idToken: string; refreshToken: string; expiresIn: string;
      };

      sendJsonResponse(req, res, 201, {
        idToken: tokenResponse.idToken,
        refreshToken: tokenResponse.refreshToken,
        expiresIn: tokenResponse.expiresIn,
        user: { uid: userRecord.uid, email: userRecord.email, studentProfileId },
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

    let decodedToken: admin.auth.DecodedIdToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(googleIdToken);
    } catch {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired Google ID token");
    }

    const { uid, email, name, picture } = decodedToken as admin.auth.DecodedIdToken & { name?: string; picture?: string };

    let studentDoc = await authService.getStudentProfileByAuthUid(uid);

    if (!studentDoc) {
      const nameParts = (name || "").trim().split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      const profileData = {
        email: email || "",
        firstName, lastName,
        city: "", state: "", zip: "",
        phone: null,
        danceGenres: [],
        subscribeToNewsletter: false,
        photoURL: picture || null,
        provider: "google",
      };

      const studentProfileId = await authService.createStudentProfileDocument(uid, profileData) as string;
      studentDoc = await authService.getStudentProfileByAuthUid(uid);

      try {
        const stripeCustomer = await createCustomer(email || "", {
          uid,
          studentProfileId,
          name: `${firstName} ${lastName}`.trim(),
        }) as { id: string; email: string };
        const db = getFirestore();
        await db.collection("usersStudentProfiles").doc(studentProfileId).update({
          stripeCustomerId: stripeCustomer.id,
          stripeEmail: stripeCustomer.email,
        });
      } catch (stripeError) {
        console.error("Error creating Stripe customer for Google sign-in:", stripeError);
      }
    }

    let apiKey: string;
    try {
      apiKey = await getFirebaseApiKey() as string;
    } catch {
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    const customToken = await authService.createCustomToken(uid) as string;
    const tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey) as {
      idToken: string; refreshToken: string; expiresIn: string;
    };

    sendJsonResponse(req, res, 200, {
      idToken: tokenResponse.idToken,
      refreshToken: tokenResponse.refreshToken,
      expiresIn: tokenResponse.expiresIn,
      user: {
        uid,
        email: email || "",
        studentProfileId: studentDoc ? (studentDoc as { id: string }).id : null,
      },
    });
  } catch (error) {
    console.error("Google sign-in error:", error);
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

    const studentDoc = await authService.getStudentProfileByAuthUid(userRecord.uid) as { id: string } | null;
    if (!studentDoc) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Student profile not found");
    }

    const customToken = await authService.createCustomToken(userRecord.uid) as string;
    const tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey) as {
      idToken: string; refreshToken: string; expiresIn: string;
    };

    sendJsonResponse(req, res, 200, {
      idToken: tokenResponse.idToken,
      refreshToken: tokenResponse.refreshToken,
      expiresIn: tokenResponse.expiresIn,
      user: { uid: userRecord.uid, email: userRecord.email, studentProfileId: studentDoc.id },
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

    const studiosWithLiveCredits: Record<string, { credits: number }> = {};
    for (const studioId of Object.keys(studiosBase)) {
      const credits = await creditTrackingService.getLiveCreditsForAuthUser(user.uid, studioId) as number;
      studiosWithLiveCredits[studioId] = { credits };
    }

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studentProfileId: studentDoc.id,
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
            studio: { id: studio["id"], name: studio["studioName"], city: studio["city"], state: studio["state"] },
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
            studio: { id: studio["id"], name: studio["studioName"], city: studio["city"], state: studio["state"] },
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
  try {
    await verifyToken(req);
  } catch (authError) {
    return handleError(req, res, authError);
  }
  sendJsonResponse(req, res, 200, []);
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

    const actionCodeSettings = {
      url: process.env["PASSWORD_RESET_URL"] || `${req.headers.origin || "https://your-app.com"}/reset-password`,
      handleCodeInApp: false,
    };

    try {
      await authService.sendPasswordResetEmail(email, actionCodeSettings);
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

    const { stripeCustomerId } = studentDoc.data() as { stripeCustomerId?: string };
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account");
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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const usersstudent = functions.https.onRequest(app);
