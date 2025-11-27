const express = require("express");
const authService = require("../services/auth.service");
const storageService = require("../services/storage.service");
const {verifyToken} = require("../middleware/auth.middleware");
const {
  validateRegistrationPayload,
  validateLoginPayload,
} = require("../utils/validation");

const router = express.Router();

/**
 * POST /v1/auth/register
 * Register a new studio owner
 */
router.post("/register", async (req, res, next) => {
  try {
    // Validate input
    const validation = validateRegistrationPayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid registration data",
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
      studioImageFile, // Base64 string or null
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

      res.status(201).json({
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
        // Also delete uploaded image if it exists
        if (studioImageUrl) {
          await storageService.deleteFile(studioImageUrl);
        }
      }
      throw error;
    }
  } catch (error) {
    console.error("Registration error:", error);
    res.status(400).json({
      error: "Registration Failed",
      message: error.message || "Failed to register user",
    });
  }
});

/**
 * POST /v1/auth/login
 * Login with email and password
 * Verifies password using Firebase Auth REST API and returns custom token
 */
router.post("/login", async (req, res) => {
  try {
    // Validate input
    const validation = validateLoginPayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid login data",
        errors: validation.errors,
      });
    }

    const {email, password} = req.body;

    // Get Firebase Web API key from environment
    // This should be set in Firebase Functions config or environment variables
    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!apiKey) {
      console.error("FIREBASE_WEB_API_KEY not configured");
      return res.status(500).json({
        error: "Configuration Error",
        message: "Server configuration error",
      });
    }

    // Verify password using Firebase Auth REST API
    let passwordVerification;
    try {
      passwordVerification = await authService.verifyPassword(
          email,
          password,
          apiKey,
      );
    } catch (error) {
      return res.status(401).json({
        error: "Authentication Failed",
        message: "Invalid email or password",
      });
    }

    // Get user by UID from the verification result
    let userRecord;
    try {
      userRecord = await authService.getUserByEmail(email);
    } catch (error) {
      return res.status(401).json({
        error: "Authentication Failed",
        message: "User not found",
      });
    }

    // Get user document from Firestore
    const userDoc = await authService.getUserDocumentByAuthUid(userRecord.uid);
    if (!userDoc) {
      return res.status(401).json({
        error: "Authentication Failed",
        message: "User profile not found",
      });
    }

    // Verify user has studio_owner role
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return res.status(403).json({
        error: "Access Denied",
        message: "This account does not have studio owner access",
      });
    }

    // Generate custom token
    const customToken = await authService.createCustomToken(userRecord.uid);

    res.json({
      customToken,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        studioOwnerId: userDoc.id,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      error: "Login Failed",
      message: error.message || "Failed to login",
    });
  }
});

/**
 * GET /v1/auth/me
 * Get current authenticated user profile
 */
router.get("/me", verifyToken, async (req, res) => {
  try {
    const {uid} = req.user;

    // Get user document from Firestore
    const userDoc = await authService.getUserDocumentByAuthUid(uid);
    if (!userDoc) {
      return res.status(404).json({
        error: "Not Found",
        message: "User profile not found",
      });
    }

    const userData = userDoc.data();

    res.json({
      uid,
      email: req.user.email,
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
    res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to retrieve user profile",
    });
  }
});

/**
 * POST /v1/auth/logout
 * Logout (token revocation can be handled here if needed)
 */
router.post("/logout", verifyToken, async (req, res) => {
  try {
    // Firebase ID tokens are stateless and can't be revoked server-side
    // The frontend should clear the token from storage
    // If needed, we could implement token blacklisting here

    res.json({
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to logout",
    });
  }
});

module.exports = router;

