const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const authService = require("./services/auth.service");
const storageService = require("./services/storage.service");
const studioEnrollmentService = require("./services/studio-enrollment.service");
const {verifyToken} = require("./utils/auth");
const {getFirestore} = require("./utils/firestore");
const {
  validateStudentRegistrationPayload,
  validateLoginPayload,
} = require("./utils/validation");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
} = require("./utils/http");

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

// Initialize Express app
const app = express();

// Explicit CORS handling - must be before other middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Set CORS headers
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  
  next();
});

// CORS configuration (backup)
const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return callback(null, true);
    }
    callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());
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
      danceGenre,
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
        danceGenre: danceGenre || null,
        subscribeToNewsletter: subscribeToNewsletter || false,
        photoURL: avatarUrl,
      };

      // Create student profile document in Firestore
      const studentProfileId = await authService.createStudentProfileDocument(
          userRecord.uid,
          userData,
      );

      // Generate custom token
      const customToken = await authService.createCustomToken(userRecord.uid);

      // Get Firebase Web API key from environment for token exchange
      const apiKey = process.env.FIREBASE_WEB_API_KEY;
      if (!apiKey) {
        console.error("FIREBASE_WEB_API_KEY not configured");
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

    // Get Firebase Web API key from environment
    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!apiKey) {
      console.error("FIREBASE_WEB_API_KEY not configured");
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
    const studios = studioEnrollmentService.ensureStudiosStructure(studentData);

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
        danceGenre: studentData.danceGenre || null,
        subscribeToNewsletter: studentData.subscribeToNewsletter || false,
        photoURL: studentData.photoURL || null,
        role: studentData.role || "student",
        studios: studios,
        // Keep studioIds for backward compatibility (deprecated)
        studioIds: Object.keys(studios),
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
      danceGenre,
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
      danceGenre: danceGenre || null,
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
        danceGenre: updatedData.danceGenre || null,
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
        danceGenre: updatedData.danceGenre || null,
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
 * Get workshops from studios the student is enrolled in
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

    const studentsService = require("./services/students.service");
    const workshopsService = require("./services/workshops.service");
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

    // Fetch all workshops from enrolled studios
    const allWorkshops = [];
    for (const studioId of studioIds) {
      try {
        const workshops = await workshopsService.getWorkshops(studioId);
        allWorkshops.push(...workshops.map((w) => ({ ...w, studioOwnerId: studioId })));
      } catch (error) {
        console.error(`Error fetching workshops for studio ${studioId}:`, error);
        // Continue with other studios
      }
    }

    const now = new Date();
    const upcoming = [];
    const past = [];

    // Process each workshop
    for (const workshop of allWorkshops) {
      try {
        // Get studio info
        const studio = await studiosService.getPublicStudioById(workshop.studioOwnerId);
        if (!studio) continue;

        const startTime = workshop.startTime?.toDate ? workshop.startTime.toDate() : new Date(workshop.startTime);
        const endTime = workshop.endTime?.toDate ? workshop.endTime.toDate() : new Date(workshop.endTime);

        const workshopData = {
          id: workshop.id,
          name: workshop.name,
          levels: workshop.levels,
          description: workshop.description,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          imageUrl: workshop.imageUrl,
          priceTiers: workshop.priceTiers,
          addressLine1: workshop.addressLine1,
          addressLine2: workshop.addressLine2,
          city: workshop.city,
          state: workshop.state,
          zip: workshop.zip,
          locationName: workshop.locationName,
          studio: {
            id: studio.id,
            name: studio.studioName,
            city: studio.city,
            state: studio.state,
          },
        };

        if (endTime > now) {
          upcoming.push(workshopData);
        } else {
          past.push(workshopData);
        }
      } catch (error) {
        console.error(`Error processing workshop ${workshop.id}:`, error);
        // Continue with next workshop
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.usersstudent = functions.https.onRequest(app);
