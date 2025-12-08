const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const authService = require("./services/auth.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {validateUpdateProfilePayload} = require("./utils/validation");
const {getFirestore} = require("./utils/firestore");
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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
 * GET /
 * Get current authenticated user's studio profile
 */
app.get("/", async (req, res) => {
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

    // Verify user has studio_owner role
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "This account does not have studio owner access");
    }

    sendJsonResponse(req, res, 200, {
      firstName: userData.firstName,
      lastName: userData.lastName,
      studioName: userData.studioName,
      studioAddressLine1: userData.studioAddressLine1,
      studioAddressLine2: userData.studioAddressLine2 || null,
      city: userData.city,
      state: userData.state,
      zip: userData.zip,
      studioImageUrl: userData.studioImageUrl || null,
      facebook: userData.facebook || null,
      instagram: userData.instagram || null,
      tiktok: userData.tiktok || null,
      youtube: userData.youtube || null,
      email: userData.email,
      membership: userData.membership,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    handleError(req, res, error);
  }
});

/**
 * PUT /
 * Update current authenticated user's studio profile
 */
app.put("/", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Validate input
    const validation = validateUpdateProfilePayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid profile data", {
        errors: validation.errors,
      });
    }

    // Get user document from Firestore
    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    // Verify user has studio_owner role
    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "This account does not have studio owner access");
    }

    const {
      firstName,
      lastName,
      studioName,
      studioAddressLine1,
      studioAddressLine2,
      city,
      state,
      zip,
      facebook,
      instagram,
      tiktok,
      youtube,
      studioImageFile,
    } = req.body;

    // Handle studio image upload if provided
    let studioImageUrl = null;
    let oldStudioImageUrl = userDoc.data().studioImageUrl || null;

    if (studioImageFile && typeof studioImageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(studioImageFile);
        const mimeType = storageService.getMimeTypeFromBase64(studioImageFile);
        const fileName = `studio-image-${user.uid}.${mimeType.split("/")[1]}`;

        studioImageUrl = await storageService.uploadStudioImage(
            fileBuffer,
            fileName,
            mimeType,
        );

        // Delete old image if it exists and is different from new one
        if (oldStudioImageUrl && oldStudioImageUrl !== studioImageUrl) {
          try {
            await storageService.deleteFile(oldStudioImageUrl);
          } catch (deleteError) {
            console.error("Error deleting old studio image:", deleteError);
            // Continue even if deletion fails
          }
        }
      } catch (imageError) {
        console.error("Error uploading studio image:", imageError);
        return sendErrorResponse(req, res, 400, "Image Upload Failed", imageError.message || "Failed to upload studio image");
      }
    }

    // Prepare update data
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (firstName !== undefined) {
      updateData.firstName = firstName.trim();
    }
    if (lastName !== undefined) {
      updateData.lastName = lastName.trim();
    }
    if (studioName !== undefined) {
      updateData.studioName = studioName.trim();
    }
    if (studioAddressLine1 !== undefined) {
      updateData.studioAddressLine1 = studioAddressLine1.trim();
    }
    if (studioAddressLine2 !== undefined) {
      updateData.studioAddressLine2 = studioAddressLine2 ? studioAddressLine2.trim() : null;
    }
    if (city !== undefined) {
      updateData.city = city.trim();
    }
    if (state !== undefined) {
      updateData.state = state.trim().toUpperCase();
    }
    if (zip !== undefined) {
      updateData.zip = zip.trim();
    }
    if (facebook !== undefined) {
      updateData.facebook = facebook ? facebook.trim() : null;
    }
    if (instagram !== undefined) {
      updateData.instagram = instagram ? instagram.trim() : null;
    }
    if (tiktok !== undefined) {
      updateData.tiktok = tiktok ? tiktok.trim() : null;
    }
    if (youtube !== undefined) {
      updateData.youtube = youtube ? youtube.trim() : null;
    }
    if (studioImageUrl !== null) {
      updateData.studioImageUrl = studioImageUrl;
    }

    // Update Firestore document
    const db = getFirestore();
    await db.collection("users").doc(userDoc.id).update(updateData);

    // Get updated document
    const updatedDoc = await db.collection("users").doc(userDoc.id).get();
    const updatedData = updatedDoc.data();

    sendJsonResponse(req, res, 200, {
      firstName: updatedData.firstName,
      lastName: updatedData.lastName,
      studioName: updatedData.studioName,
      studioAddressLine1: updatedData.studioAddressLine1,
      studioAddressLine2: updatedData.studioAddressLine2 || null,
      city: updatedData.city,
      state: updatedData.state,
      zip: updatedData.zip,
      studioImageUrl: updatedData.studioImageUrl || null,
      facebook: updatedData.facebook || null,
      instagram: updatedData.instagram || null,
      tiktok: updatedData.tiktok || null,
      youtube: updatedData.youtube || null,
      email: updatedData.email,
      membership: updatedData.membership,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.profile = functions.https.onRequest(app);

