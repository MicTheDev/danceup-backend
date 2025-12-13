const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const authService = require("./services/auth.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {
  validateRegistrationPayload,
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
 * Register a new studio owner
 */
app.post("/register", async (req, res) => {
  try {
    // Validate input
    const validation = validateRegistrationPayload(req.body);
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
      studioName,
      studioAddressLine1,
      studioAddressLine2,
      city,
      state,
      zip,
      membership,
      facebook,
      instagram,
      tiktok,
      youtube,
      studioImageFile,
    } = req.body;

    let userRecord;
    let studioImageUrl = null;

    try {
      // Create Firebase Auth user
      userRecord = await authService.createUser(email, password);

      // Handle studio image upload if provided
      if (studioImageFile && typeof studioImageFile === "string") {
        try {
          const fileBuffer = storageService.base64ToBuffer(studioImageFile);
          const mimeType = storageService.getMimeTypeFromBase64(studioImageFile);
          const fileName = `studio-image-${userRecord.uid}.${mimeType.split("/")[1]}`;

          studioImageUrl = await storageService.uploadStudioImage(
              fileBuffer,
              fileName,
              mimeType,
          );
        } catch (imageError) {
          console.error("Error uploading studio image:", imageError);
          // Continue without image - don't fail registration
        }
      }

      // Prepare user document data
      const userData = {
        email: userRecord.email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        studioName: studioName.trim(),
        studioAddressLine1: studioAddressLine1.trim(),
        studioAddressLine2: studioAddressLine2 ? studioAddressLine2.trim() : null,
        city: city.trim(),
        state: state.trim().toUpperCase(),
        zip: zip.trim(),
        membership,
        roles: ["student", "studio_owner"],
        studioImageUrl,
        facebook: facebook ? facebook.trim() : null,
        instagram: instagram ? instagram.trim() : null,
        tiktok: tiktok ? tiktok.trim() : null,
        youtube: youtube ? youtube.trim() : null,
      };

      // Create user document in Firestore
      const studioOwnerId = await authService.createUserDocument(
          userRecord.uid,
          userData,
      );

      // Generate custom token
      const customToken = await authService.createCustomToken(userRecord.uid);

      sendJsonResponse(req, res, 201, {
        customToken,
        user: {
          uid: userRecord.uid,
          email: userRecord.email,
          studioOwnerId,
        },
      });
    } catch (error) {
      // Cleanup: delete Firebase Auth user if Firestore creation failed
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
      message: error.message || "Failed to register user",
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
 * Login with email and password
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

    // Get user document from Firestore
    const userDoc = await authService.getUserDocumentByAuthUid(userRecord.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "User profile not found");
    }

    // Verify user has studio_owner role
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "This account does not have studio owner access");
    }

    // Generate custom token
    const customToken = await authService.createCustomToken(userRecord.uid);

    sendJsonResponse(req, res, 200, {
      customToken,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        studioOwnerId: userDoc.id,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
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
 * Get current authenticated user profile
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

    // Get user document from Firestore
    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userData = userDoc.data();

    sendJsonResponse(req, res, 200, {
      uid: user.uid,
      email: user.email,
      studioOwnerId: userDoc.id,
      profile: {
        firstName: userData.firstName,
        lastName: userData.lastName,
        studioName: userData.studioName,
        studioAddressLine1: userData.studioAddressLine1,
        studioAddressLine2: userData.studioAddressLine2 || null,
        city: userData.city,
        state: userData.state,
        zip: userData.zip,
        studioImageUrl: userData.studioImageUrl || null,
        membership: userData.membership,
        facebook: userData.facebook || null,
        instagram: userData.instagram || null,
        tiktok: userData.tiktok || null,
        youtube: userData.youtube || null,
        roles: userData.roles || [],
      },
    });
  } catch (error) {
    console.error("Get user profile error:", error);
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
exports.auth = functions.https.onRequest(app);

