const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const authService = require("./services/auth.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {getFirestore} = require("./utils/firestore");
const {
  validateRegistrationPayload,
  validateLoginPayload,
  validateForgotPasswordPayload,
  validateResetPasswordPayload,
  validateChangeEmailPayload,
  validateMembership,
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
        roles: ["student", "studio_owner"],
        studioImageUrl,
        facebook: facebook ? facebook.trim() : null,
        instagram: instagram ? instagram.trim() : null,
        tiktok: tiktok ? tiktok.trim() : null,
        youtube: youtube ? youtube.trim() : null,
      };

      // Only include membership if it's provided
      if (membership !== undefined && membership !== null) {
        userData.membership = membership;
      }

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

/**
 * OPTIONS /forgot-password
 * Handle CORS preflight for forgot password endpoint
 */
app.options("/forgot-password", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
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

    // Send password reset email
    await authService.sendPasswordResetEmail(email, actionCodeSettings);

    sendJsonResponse(req, res, 200, {
      message: "Password reset email sent successfully",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    const message = error.message || "Failed to send password reset email";
    if (message.includes("user-not-found") || message.includes("No user found")) {
      return sendErrorResponse(req, res, 404, "Not Found", "No account found with this email address");
    }
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /reset-password
 * Handle CORS preflight for reset password endpoint
 */
app.options("/reset-password", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
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
 * OPTIONS /change-email
 * Handle CORS preflight for change email endpoint
 */
app.options("/change-email", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
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

    // Get Firebase Web API key from environment
    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!apiKey) {
      console.error("FIREBASE_WEB_API_KEY not configured");
      return sendErrorResponse(req, res, 500, "Configuration Error", "Server configuration error");
    }

    // Re-authenticate user by verifying current password
    try {
      await authService.verifyPasswordForReauth(user.email, currentPassword, apiKey);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Incorrect password");
    }

    // Get user document from Firestore
    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    // Update email address in Firebase Auth
    await authService.updateUserEmail(user.uid, newEmail);

    // Update email in Firestore user document
    const db = getFirestore();
    await db.collection("users").doc(userDoc.id).update({
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
 * OPTIONS /update-membership
 * Handle CORS preflight for update-membership endpoint
 */
app.options("/update-membership", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * PATCH /update-membership
 * Update user's membership tier
 */
app.patch("/update-membership", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const {membership} = req.body;

    // Validate membership
    if (!membership) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Membership is required");
    }

    const membershipValidation = validateMembership(membership);
    if (!membershipValidation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", membershipValidation.message);
    }

    // Get user document
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userDoc = userQuery.docs[0];

    // Update membership
    await userDoc.ref.update({
      membership,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {
      message: "Membership updated successfully",
      membership,
    });
  } catch (error) {
    console.error("Update membership error:", error);
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

