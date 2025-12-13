const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const authService = require("./services/auth.service");
const storageService = require("./services/storage.service");
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

// Handle OPTIONS preflight requests FIRST - before any other middleware
app.options("*", (req, res) => {
  const origin = req.headers.origin || "*";
  
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  
  return res.status(204).send();
});

// CORS middleware for all requests
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  
  next();
});

// Use cors package as backup
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
  exposedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));

app.use(express.json());
app.use(express.urlencoded({extended: true}));

/**
 * OPTIONS /register
 * Handle CORS preflight for register endpoint
 */
app.options("/register", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

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
 * OPTIONS /login
 * Handle CORS preflight for login endpoint
 */
app.options("/login", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
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
 * OPTIONS /me
 * Handle CORS preflight for me endpoint
 */
app.options("/me", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
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
      },
    });
  } catch (error) {
    console.error("Get student profile error:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /me (for PUT)
 * Handle CORS preflight for update profile endpoint
 */
app.options("/me", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
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
 * OPTIONS /me/avatar
 * Handle CORS preflight for delete avatar endpoint
 */
app.options("/me/avatar", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
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
 * OPTIONS /logout
 * Handle CORS preflight for logout endpoint
 */
app.options("/logout", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
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
