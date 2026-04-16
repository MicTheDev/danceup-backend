const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const authService = require("./services/auth.service");
const storageService = require("./services/storage.service");
const studioEnrollmentService = require("./services/studio-enrollment.service");
const creditTrackingService = require("./services/credit-tracking.service");
const {createCustomer, createSetupIntent, listPaymentMethods, detachPaymentMethod, updatePaymentMethod, getStripePublishableKey} = require("./services/stripe.service");
const {verifyToken} = require("./utils/auth");
const {sendWelcomeEmail} = require("./services/sendgrid.service");
const {getFirestore} = require("./utils/firestore");
const {getFirebaseApiKey} = require("./utils/firebase-api-key");
const {
  validateStudentRegistrationPayload,
  validateLoginPayload,
  validateForgotPasswordPayload,
  validateResetPasswordPayload,
  validateChangeEmailPayload,
} = require("./utils/validation");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} = require("./utils/http");

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

// Initialize Express app
const app = express();

// Handle OPTIONS preflight — only reflect origin if it is in the allowlist
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

// Apply CORS middleware using the shared allowlist
app.use(cors(corsOptions));

app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({extended: true}));


/**
 * POST /register
 * Register a new student user
 */
app.post("/register", async (req, res) => {
  try {
    // Validate input
    const validation = validateStudentRegistrationPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid registration data", {
        errors: validation.errors,
      });
    }

    const {
      email,
      password,
      firstName,
      lastName,
      city,
      state,
      zip,
      phone,
      danceGenres,
      subscribeToNewsletter,
      avatarFile,
    } = req.body;

    let userRecord;
    let avatarUrl = null;

    try {
      // Create Firebase Auth user
      userRecord = await authService.createUser(email, password);

      // Handle avatar file upload if provided
      if (avatarFile && typeof avatarFile === "string") {
        try {
          const fileBuffer = storageService.base64ToBuffer(avatarFile);
          const mimeType = storageService.getMimeTypeFromBase64(avatarFile);
          const fileName = `avatar-${userRecord.uid}.${mimeType.split("/")[1]}`;

          avatarUrl = await storageService.uploadStudentAvatar(
              fileBuffer,
              fileName,
              mimeType,
              userRecord.uid,
          );
        } catch (imageError) {
          console.error("Error uploading avatar:", imageError);
          // Continue without avatar - don't fail registration
        }
      }

      // Prepare student profile document data
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

      // Create student profile document in Firestore
      const studentProfileId = await authService.createStudentProfileDocument(
          userRecord.uid,
          userData,
      );

      // Create Stripe customer and persist the ID — non-fatal if Stripe is unavailable
      try {
        const stripeCustomer = await createCustomer(email, {
          uid: userRecord.uid,
          studentProfileId,
          name: `${firstName.trim()} ${lastName.trim()}`,
        });
        const db = getFirestore();
        await db.collection("usersStudentProfiles").doc(studentProfileId).update({
          stripeCustomerId: stripeCustomer.id,
          stripeEmail: stripeCustomer.email,
        });
      } catch (stripeError) {
        console.error("Error creating Stripe customer during registration:", stripeError);
        // Registration still succeeds — customer can be created later
      }

      // Send welcome email — non-fatal
      try {
        await sendWelcomeEmail(userRecord.email, firstName);
      } catch (emailError) {
        console.error("Error sending welcome email:", emailError);
      }

      // Generate custom token
      const customToken = await authService.createCustomToken(userRecord.uid);

      // Get Firebase Web API key from Secret Manager or environment for token exchange
      let apiKey;
      try {
        apiKey = await getFirebaseApiKey();
      } catch (error) {
        console.error("FIREBASE_WEB_API_KEY not configured:", error.message);
        // Still return custom token as fallback
        return sendJsonResponse(req, res, 201, {
          customToken,
          user: {
            uid: userRecord.uid,
            email: userRecord.email,
            studentProfileId,
          },
        });
      }

      // Exchange custom token for ID token
      const tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey);

      sendJsonResponse(req, res, 201, {
        idToken: tokenResponse.idToken,
        refreshToken: tokenResponse.refreshToken,
        expiresIn: tokenResponse.expiresIn,
        user: {
          uid: userRecord.uid,
          email: userRecord.email,
          studentProfileId,
        },
      });
    } catch (error) {
      // Cleanup: delete Firebase Auth user if Firestore creation failed
      if (userRecord) {
        await authService.deleteUser(userRecord.uid);
        if (avatarUrl) {
          await storageService.deleteFile(avatarUrl);
        }
      }
      throw error;
    }
  } catch (error) {
    console.error("Student registration error:", error);
    handleError(req, res, {
      status: 400,
      error: "Registration Failed",
      message: error.message || "Failed to register student",
    });
  }
});


/**
 * POST /google-signin
 * Sign in or register a student using a Google-issued Firebase ID token.
 * The client completes signInWithPopup/Redirect on the frontend, then sends
 * the resulting Firebase ID token here so we can issue our own backend JWT
 * and ensure a student profile exists in Firestore.
 */
app.post("/google-signin", async (req, res) => {
  try {
    const {idToken: googleIdToken} = req.body;
    if (!googleIdToken) {
      return sendErrorResponse(req, res, 400, "Validation Error", "idToken is required");
    }

    // Verify the token with Firebase Admin — this also confirms it came from Google
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(googleIdToken);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired Google ID token");
    }

    const {uid, email, name, picture} = decodedToken;

    // Look up existing student profile
    let studentDoc = await authService.getStudentProfileByAuthUid(uid);

    if (!studentDoc) {
      // First-time Google sign-in — create a minimal profile
      const nameParts = (name || "").trim().split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      const profileData = {
        email: email || "",
        firstName,
        lastName,
        city: "",
        state: "",
        zip: "",
        phone: null,
        danceGenres: [],
        subscribeToNewsletter: false,
        photoURL: picture || null,
        provider: "google",
      };

      const studentProfileId = await authService.createStudentProfileDocument(uid, profileData);

      // Re-fetch so we have the doc reference
      studentDoc = await authService.getStudentProfileByAuthUid(uid);

      // Create Stripe customer — non-fatal
      try {
        const {createCustomer} = require("./services/stripe.service");
        const stripeCustomer = await createCustomer(email, {
          uid,
          studentProfileId,
          name: `${firstName} ${lastName}`.trim(),
        });
        const db = getFirestore();
        await db.collection("usersStudentProfiles").doc(studentProfileId).update({
          stripeCustomerId: stripeCustomer.id,
          stripeEmail: stripeCustomer.email,
        });
      } catch (stripeError) {
        console.error("Error creating Stripe customer for Google sign-in:", stripeError);
      }
    }

    // Get Firebase Web API key
    let apiKey;
    try {
      apiKey = await getFirebaseApiKey();
    } catch (error) {
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    // Issue our backend JWT via custom token exchange
    const customToken = await authService.createCustomToken(uid);
    const tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey);

    sendJsonResponse(req, res, 200, {
      idToken: tokenResponse.idToken,
      refreshToken: tokenResponse.refreshToken,
      expiresIn: tokenResponse.expiresIn,
      user: {
        uid,
        email: email || "",
        studentProfileId: studentDoc ? studentDoc.id : null,
      },
    });
  } catch (error) {
    console.error("Google sign-in error:", error);
    handleError(req, res, error);
  }
});


/**
 * POST /login
 * Login with email and password for student users
 */
app.post("/login", async (req, res) => {
  try {
    // Validate input
    const validation = validateLoginPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid login data", {
        errors: validation.errors,
      });
    }

    const {email, password} = req.body;

    // Get Firebase Web API key from Secret Manager or environment
    let apiKey;
    try {
      apiKey = await getFirebaseApiKey();
    } catch (error) {
      console.error("FIREBASE_WEB_API_KEY not configured:", error.message);
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    // Verify password using Firebase Auth REST API
    try {
      await authService.verifyPassword(email, password, apiKey);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid email or password");
    }

    // Get user by email
    let userRecord;
    try {
      userRecord = await authService.getUserByEmail(email);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "User not found");
    }

    // Get student profile document from Firestore
    const studentDoc = await authService.getStudentProfileByAuthUid(userRecord.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Student profile not found");
    }

    // Generate custom token
    const customToken = await authService.createCustomToken(userRecord.uid);

    // Exchange custom token for ID token
    const tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey);

    sendJsonResponse(req, res, 200, {
      idToken: tokenResponse.idToken,
      refreshToken: tokenResponse.refreshToken,
      expiresIn: tokenResponse.expiresIn,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        studentProfileId: studentDoc.id,
      },
    });
  } catch (error) {
    console.error("Student login error:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /me
 * Get current authenticated student profile
 */
app.get("/me", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get student profile document from Firestore
    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const studentData = studentDoc.data();

    // Ensure studios object structure (backward compatibility)
    const studiosBase = studioEnrollmentService.ensureStudiosStructure(studentData);

    // Build studios with live credit totals from subcollection (single source of truth)
    const studiosWithLiveCredits = {};
    for (const studioId of Object.keys(studiosBase)) {
      const credits = await creditTrackingService.getLiveCreditsForAuthUser(user.uid, studioId);
      studiosWithLiveCredits[studioId] = { credits };
    }

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studentProfileId: studentDoc.id,
      profile: {
        firstName: studentData.firstName,
        lastName: studentData.lastName,
        city: studentData.city,
        state: studentData.state,
        zip: studentData.zip,
        phone: studentData.phone || null,
        danceGenres: studentData.danceGenres || (studentData.danceGenre ? [studentData.danceGenre] : []),
        subscribeToNewsletter: studentData.subscribeToNewsletter || false,
        photoURL: studentData.photoURL || null,
        role: studentData.role || "student",
        studios: studiosWithLiveCredits,
        // Keep studioIds for backward compatibility (deprecated)
        studioIds: Object.keys(studiosWithLiveCredits),
      },
    });
  } catch (error) {
    console.error("Get student profile error:", error);
    handleError(req, res, error);
  }
});


/**
 * PUT /me
 * Update current authenticated student profile
 */
app.put("/me", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get student profile document from Firestore
    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const {
      firstName,
      lastName,
      city,
      state,
      zip,
      phone,
      danceGenres,
      subscribeToNewsletter,
      avatarFile,
    } = req.body;

    // Prepare update data
    const updateData = {
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

    // Handle avatar file upload if provided
    if (avatarFile && typeof avatarFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(avatarFile);
        const mimeType = storageService.getMimeTypeFromBase64(avatarFile);
        const fileName = `avatar-${user.uid}.${mimeType.split("/")[1]}`;

        const avatarUrl = await storageService.uploadStudentAvatar(
            fileBuffer,
            fileName,
            mimeType,
            user.uid,
        );
        updateData.photoURL = avatarUrl;
      } catch (imageError) {
        console.error("Error uploading avatar:", imageError);
        // Continue without avatar update - don't fail the request
      }
    }

    // Update the profile document
    const db = getFirestore();
    await db.collection("usersStudentProfiles").doc(studentDoc.id).update(updateData);

    // Sync phone to any enrolled students records for this user
    if (phone !== undefined) {
      try {
        const studentsSnapshot = await db.collection("students")
            .where("authUid", "==", user.uid)
            .get();
        const batch = db.batch();
        studentsSnapshot.forEach((doc) => {
          batch.update(doc.ref, {phone: phone ? phone.trim() : null});
        });
        if (!studentsSnapshot.empty) {
          await batch.commit();
        }
      } catch (syncError) {
        console.error("Error syncing phone to students collection:", syncError);
        // Non-fatal: profile is already updated
      }
    }

    // Fetch updated profile
    const updatedDoc = await authService.getStudentProfileByAuthUid(user.uid);
    const updatedData = updatedDoc.data();

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studentProfileId: updatedDoc.id,
      profile: {
        firstName: updatedData.firstName,
        lastName: updatedData.lastName,
        city: updatedData.city,
        state: updatedData.state,
        zip: updatedData.zip,
        phone: updatedData.phone || null,
        danceGenres: updatedData.danceGenres || (updatedData.danceGenre ? [updatedData.danceGenre] : []),
        subscribeToNewsletter: updatedData.subscribeToNewsletter || false,
        photoURL: updatedData.photoURL || null,
        role: updatedData.role || "student",
      },
    });
  } catch (error) {
    console.error("Update student profile error:", error);
    handleError(req, res, error);
  }
});


/**
 * DELETE /me/avatar
 * Delete current authenticated student avatar
 */
app.delete("/me/avatar", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get student profile document from Firestore
    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const studentData = studentDoc.data();
    const photoURL = studentData.photoURL;

    // Delete avatar from storage if it exists
    if (photoURL) {
      try {
        await storageService.deleteFile(photoURL);
      } catch (storageError) {
        console.error("Error deleting avatar from storage:", storageError);
        // Continue to update Firestore even if storage deletion fails
      }
    }

    // Update the profile document to remove photoURL
    const db = getFirestore();
    await db.collection("usersStudentProfiles").doc(studentDoc.id).update({
      photoURL: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Fetch updated profile
    const updatedDoc = await authService.getStudentProfileByAuthUid(user.uid);
    const updatedData = updatedDoc.data();

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studentProfileId: updatedDoc.id,
      profile: {
        firstName: updatedData.firstName,
        lastName: updatedData.lastName,
        city: updatedData.city,
        state: updatedData.state,
        zip: updatedData.zip,
        danceGenres: updatedData.danceGenres || (updatedData.danceGenre ? [updatedData.danceGenre] : []),
        subscribeToNewsletter: updatedData.subscribeToNewsletter || false,
        photoURL: null,
        role: updatedData.role || "student",
      },
    });
  } catch (error) {
    console.error("Delete student avatar error:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /my-classes
 * Get classes from studios the student is enrolled in
 */
app.get("/my-classes", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studentsService = require("./services/students.service");
    const classesService = require("./services/classes.service");
    const studiosService = require("./services/studios.service");
    const db = getFirestore();

    // Get enrolled studio IDs
    const studioIds = await studentsService.getEnrolledStudios(user.uid);
    if (studioIds.length === 0) {
      return sendJsonResponse(req, res, 200, {
        upcoming: [],
        past: [],
      });
    }

    // Fetch all classes from enrolled studios
    const allClasses = [];
    for (const studioId of studioIds) {
      try {
        const classes = await classesService.getClasses(studioId);
        // Filter for active classes only
        const activeClasses = classes.filter((cls) => cls.isActive);
        allClasses.push(...activeClasses.map((cls) => ({ ...cls, studioOwnerId: studioId })));
      } catch (error) {
        console.error(`Error fetching classes for studio ${studioId}:`, error);
        // Continue with other studios
      }
    }

    const now = new Date();
    const upcoming = [];
    const past = [];

    // Process each class to calculate instances
    for (const classData of allClasses) {
      try {
        // Get studio info
        const studio = await studiosService.getPublicStudioById(classData.studioOwnerId);
        if (!studio) continue;

        // Calculate next occurrence
        const nextInstance = studentsService.calculateNextClassInstance(
          classData.dayOfWeek,
          classData.startTime,
          now
        );

        if (nextInstance > now) {
          upcoming.push({
            id: classData.id,
            name: classData.name,
            level: classData.level,
            cost: classData.cost,
            dayOfWeek: classData.dayOfWeek,
            startTime: classData.startTime,
            endTime: classData.endTime,
            description: classData.description,
            room: classData.room,
            danceGenre: classData.danceGenre,
            instanceDate: nextInstance.toISOString(),
            studio: {
              id: studio.id,
              name: studio.studioName,
              city: studio.city,
              state: studio.state,
            },
          });
        }

        // Calculate past instances (last 30 days)
        const pastInstances = studentsService.calculatePastClassInstances(
          classData.dayOfWeek,
          classData.startTime,
          now,
          30
        );

        for (const instanceDate of pastInstances) {
          past.push({
            id: classData.id,
            name: classData.name,
            level: classData.level,
            cost: classData.cost,
            dayOfWeek: classData.dayOfWeek,
            startTime: classData.startTime,
            endTime: classData.endTime,
            description: classData.description,
            room: classData.room,
            danceGenre: classData.danceGenre,
            instanceDate: instanceDate.toISOString(),
            studio: {
              id: studio.id,
              name: studio.studioName,
              city: studio.city,
              state: studio.state,
            },
          });
        }
      } catch (error) {
        console.error(`Error processing class ${classData.id}:`, error);
        // Continue with next class
      }
    }

    // Sort upcoming by instance date (ascending)
    upcoming.sort((a, b) => new Date(a.instanceDate) - new Date(b.instanceDate));
    // Sort past by instance date (descending - most recent first)
    past.sort((a, b) => new Date(b.instanceDate) - new Date(a.instanceDate));

    sendJsonResponse(req, res, 200, {
      upcoming,
      past,
    });
  } catch (error) {
    console.error("Error getting my classes:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /my-workshops
 * Get workshops the student has purchased tickets for.
 */
app.get("/my-workshops", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const workshopsService = require("./services/workshops.service");
    const studiosService = require("./services/studios.service");
    const db = getFirestore();

    // Query all completed workshop purchases for this user
    const purchasesSnapshot = await db.collection("purchases")
        .where("authUid", "==", user.uid)
        .where("purchaseType", "==", "workshop")
        .where("status", "==", "completed")
        .get();

    if (purchasesSnapshot.empty) {
      return sendJsonResponse(req, res, 200, {upcoming: [], past: []});
    }

    const now = new Date();
    const upcoming = [];
    const past = [];

    for (const doc of purchasesSnapshot.docs) {
      const purchase = doc.data();
      const workshopId = purchase.itemId;

      try {
        const workshop = await workshopsService.getPublicWorkshopById(workshopId);
        if (!workshop) continue;

        const studioId = workshop.studioOwnerId || workshop.studio?.id || purchase.studioOwnerId;
        let studioInfo = {
          id: studioId,
          name: purchase.studioName || "Studio",
          city: "",
          state: "",
        };
        if (studioId) {
          try {
            const studio = await studiosService.getPublicStudioById(studioId);
            if (studio) {
              studioInfo = {id: studio.id, name: studio.studioName, city: studio.city, state: studio.state};
            }
          } catch (e) {
            // use fallback studioInfo
          }
        }

        const startTime = workshop.startTime?.toDate ? workshop.startTime.toDate() : new Date(workshop.startTime);
        const endTime = workshop.endTime?.toDate ? workshop.endTime.toDate() : new Date(workshop.endTime);

        const workshopData = {
          id: workshop.id || workshopId,
          purchaseId: doc.id,
          name: workshop.name,
          levels: workshop.levels || [],
          description: workshop.description,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          imageUrl: workshop.imageUrl,
          priceTiers: workshop.priceTiers || [],
          addressLine1: workshop.addressLine1 || "",
          addressLine2: workshop.addressLine2,
          city: workshop.city || "",
          state: workshop.state || "",
          zip: workshop.zip || "",
          locationName: workshop.locationName,
          studio: studioInfo,
          isCheckedIn: purchase.checkedIn || false,
        };

        if (endTime > now) {
          upcoming.push(workshopData);
        } else {
          past.push(workshopData);
        }
      } catch (error) {
        console.error(`Error processing workshop purchase ${doc.id}:`, error);
        // Continue with next purchase
      }
    }

    // Sort upcoming by start time (ascending)
    upcoming.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    // Sort past by start time (descending - most recent first)
    past.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    sendJsonResponse(req, res, 200, {upcoming, past});
  } catch (error) {
    console.error("Error getting my workshops:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /my-events
 * Get events from studios the student is enrolled in
 */
app.get("/my-events", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studentsService = require("./services/students.service");
    const eventsService = require("./services/events.service");
    const studiosService = require("./services/studios.service");
    const db = getFirestore();

    // Get enrolled studio IDs
    const studioIds = await studentsService.getEnrolledStudios(user.uid);
    if (studioIds.length === 0) {
      return sendJsonResponse(req, res, 200, {
        upcoming: [],
        past: [],
      });
    }

    // Fetch all events from enrolled studios
    const allEvents = [];
    for (const studioId of studioIds) {
      try {
        const events = await eventsService.getEvents(studioId);
        allEvents.push(...events.map((e) => ({ ...e, studioOwnerId: studioId })));
      } catch (error) {
        console.error(`Error fetching events for studio ${studioId}:`, error);
        // Continue with other studios
      }
    }

    const now = new Date();
    const upcoming = [];
    const past = [];

    // Process each event
    for (const event of allEvents) {
      try {
        // Get studio info
        const studio = await studiosService.getPublicStudioById(event.studioOwnerId);
        if (!studio) continue;

        const startTime = event.startTime?.toDate ? event.startTime.toDate() : new Date(event.startTime);
        const endTime = event.endTime?.toDate ? event.endTime.toDate() : (event.endTime ? new Date(event.endTime) : null);

        const eventData = {
          id: event.id,
          name: event.name,
          type: event.type,
          description: event.description,
          startTime: startTime.toISOString(),
          endTime: endTime ? endTime.toISOString() : null,
          imageUrl: event.imageUrl,
          priceTiers: event.priceTiers,
          addressLine1: event.addressLine1,
          addressLine2: event.addressLine2,
          city: event.city,
          state: event.state,
          zip: event.zip,
          locationName: event.locationName,
          studio: {
            id: studio.id,
            name: studio.studioName,
            city: studio.city,
            state: studio.state,
          },
        };

        // Use endTime if available, otherwise use startTime
        const compareTime = endTime || startTime;
        if (compareTime > now) {
          upcoming.push(eventData);
        } else {
          past.push(eventData);
        }
      } catch (error) {
        console.error(`Error processing event ${event.id}:`, error);
        // Continue with next event
      }
    }

    // Sort upcoming by start time (ascending)
    upcoming.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    // Sort past by start time (descending - most recent first)
    past.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    sendJsonResponse(req, res, 200, {
      upcoming,
      past,
    });
  } catch (error) {
    console.error("Error getting my events:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /event-passes
 * Returns checked-in event/workshop passes (with event code) for the current user.
 * Stub: returns empty array until full implementation (e.g. from purchases + check-in codes).
 */
app.get("/event-passes", async (req, res) => {
  try {
    await verifyToken(req);
  } catch (authError) {
    return handleError(req, res, authError);
  }
  sendJsonResponse(req, res, 200, []);
});


/**
 * POST /forgot-password
 * Send password reset email
 */
app.post("/forgot-password", async (req, res) => {
  try {
    // Validate input
    const validation = validateForgotPasswordPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid request data", {
        errors: validation.errors,
      });
    }

    const {email} = req.body;

    // Get action code settings from environment or use defaults
    const actionCodeSettings = {
      url: process.env.PASSWORD_RESET_URL || `${req.headers.origin || 'https://your-app.com'}/reset-password`,
      handleCodeInApp: false,
    };

    // Send password reset email — silently swallow user-not-found to prevent enumeration
    try {
      await authService.sendPasswordResetEmail(email, actionCodeSettings);
    } catch (emailError) {
      const msg = emailError.message || "";
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


/**
 * POST /reset-password
 * Reset password with code from email
 */
app.post("/reset-password", async (req, res) => {
  try {
    // Validate input
    const validation = validateResetPasswordPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid request data", {
        errors: validation.errors,
      });
    }

    const {oobCode, newPassword} = req.body;

    // Verify code and reset password
    await authService.verifyPasswordResetCode(oobCode, newPassword);

    sendJsonResponse(req, res, 200, {
      message: "Password reset successfully",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    const message = error.message || "Failed to reset password";
    if (message.includes("expired") || message.includes("invalid")) {
      return sendErrorResponse(req, res, 400, "Invalid Code", "This password reset link has expired or is invalid");
    }
    handleError(req, res, error);
  }
});


/**
 * POST /change-email
 * Change user email address (requires re-authentication)
 */
app.post("/change-email", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Validate input
    const validation = validateChangeEmailPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid request data", {
        errors: validation.errors,
      });
    }

    const {currentPassword, newEmail} = req.body;

    // Get Firebase Web API key from Secret Manager or environment
    let apiKey;
    try {
      apiKey = await getFirebaseApiKey();
    } catch (error) {
      console.error("FIREBASE_WEB_API_KEY not configured:", error.message);
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    // Re-authenticate user by verifying current password
    try {
      await authService.verifyPasswordForReauth(user.email, currentPassword, apiKey);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Incorrect password");
    }

    // Get student profile document from Firestore
    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    // Update email address in Firebase Auth
    await authService.updateUserEmail(user.uid, newEmail);

    // Update email in Firestore student profile
    const db = getFirestore();
    await db.collection("usersStudentProfiles").doc(studentDoc.id).update({
      email: newEmail.trim().toLowerCase(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {
      message: "Email address updated successfully",
      email: newEmail,
    });
  } catch (error) {
    console.error("Change email error:", error);
    const message = error.message || "Failed to update email address";
    if (message.includes("email-already-exists") || message.includes("already in use")) {
      return sendErrorResponse(req, res, 409, "Conflict", "This email address is already in use");
    }
    if (message.includes("invalid-email")) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid email address");
    }
    handleError(req, res, error);
  }
});

/**
 * POST /logout
 * Logout (token revocation can be handled here if needed)
 */
app.post("/logout", async (req, res) => {
  try {
    // Verify token (even though we don't use the result, we want to ensure valid auth)
    try {
      await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    sendJsonResponse(req, res, 200, {
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout error:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /config/stripe
 * Public endpoint — returns the Stripe publishable key from Secret Manager.
 * No auth required; publishable keys are safe to expose to the browser.
 */
app.get("/config/stripe", async (req, res) => {
  try {
    const publishableKey = await getStripePublishableKey();
    sendJsonResponse(req, res, 200, {publishableKey});
  } catch (error) {
    console.error("Error fetching Stripe publishable key:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /me/payment-methods/setup
 * Create a Stripe SetupIntent so the client can securely save a card
 */
app.post("/me/payment-methods/setup", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const {stripeCustomerId} = studentDoc.data();
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account");
    }

    const setupIntent = await createSetupIntent(stripeCustomerId);
    sendJsonResponse(req, res, 200, {clientSecret: setupIntent.client_secret});
  } catch (error) {
    console.error("Error creating setup intent:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /me/payment-methods
 * Return the saved payment methods for the authenticated user (brand + last4 only)
 */
app.get("/me/payment-methods", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const {stripeCustomerId} = studentDoc.data();
    if (!stripeCustomerId) {
      return sendJsonResponse(req, res, 200, []);
    }

    const paymentMethods = await listPaymentMethods(stripeCustomerId);
    const simplified = paymentMethods.map((pm) => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    }));

    sendJsonResponse(req, res, 200, simplified);
  } catch (error) {
    console.error("Error fetching payment methods:", error);
    handleError(req, res, error);
  }
});

/**
 * DELETE /me/payment-methods/:paymentMethodId
 * Detach (delete) a saved payment method from the authenticated user's Stripe customer
 */
app.delete("/me/payment-methods/:paymentMethodId", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const {stripeCustomerId} = studentDoc.data();
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account");
    }

    const {paymentMethodId} = req.params;

    // Verify the payment method belongs to this customer before detaching
    const paymentMethods = await listPaymentMethods(stripeCustomerId);
    const owned = paymentMethods.some((pm) => pm.id === paymentMethodId);
    if (!owned) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    await detachPaymentMethod(paymentMethodId);
    sendJsonResponse(req, res, 200, {success: true});
  } catch (error) {
    console.error("Error deleting payment method:", error);
    handleError(req, res, error);
  }
});

/**
 * PATCH /me/payment-methods/:paymentMethodId
 * Update the expiration date of a saved card
 * Body: { expMonth: number, expYear: number }
 */
app.patch("/me/payment-methods/:paymentMethodId", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studentDoc = await authService.getStudentProfileByAuthUid(user.uid);
    if (!studentDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found");
    }

    const {stripeCustomerId} = studentDoc.data();
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account");
    }

    const {paymentMethodId} = req.params;
    const {expMonth, expYear} = req.body;

    if (!expMonth || !expYear) {
      return sendErrorResponse(req, res, 400, "Bad Request", "expMonth and expYear are required");
    }

    // Verify the payment method belongs to this customer
    const paymentMethods = await listPaymentMethods(stripeCustomerId);
    const owned = paymentMethods.some((pm) => pm.id === paymentMethodId);
    if (!owned) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    const updated = await updatePaymentMethod(paymentMethodId, Number(expMonth), Number(expYear));
    sendJsonResponse(req, res, 200, {
      id: updated.id,
      brand: updated.card.brand,
      last4: updated.card.last4,
      expMonth: updated.card.exp_month,
      expYear: updated.card.exp_year,
    });
  } catch (error) {
    console.error("Error updating payment method:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.usersstudent = functions.https.onRequest(app);
