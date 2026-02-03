const functions = require("firebase-functions");
const express = require("express");
const authService = require("./services/auth.service");
const {verifyToken} = require("./utils/auth");
const {getFirestore} = require("./utils/firestore");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
} = require("./utils/http");

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

app.use(express.json());
app.use(express.urlencoded({extended: true}));

/**
 * POST /
 * Create a new support issue
 */
app.post("/", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Validate input
    const {page, description} = req.body;

    if (!page || typeof page !== "string" || page.trim().length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Page is required", {
        errors: [{field: "page", message: "Page is required"}],
      });
    }

    if (!description || typeof description !== "string" || description.trim().length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Description is required", {
        errors: [{field: "description", message: "Description is required"}],
      });
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

    // Create support issue document
    const db = getFirestore();
    const supportIssueData = {
      page: page.trim(),
      description: description.trim(),
      email: user.email || "",
      studioName: userData.studioName || "",
      uid: user.uid,
      studioOwnerId: userDoc.id,
      status: "open",
      createdAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("support_issues").add(supportIssueData);

    sendJsonResponse(req, res, 201, {
      id: docRef.id,
      message: "Support issue reported successfully",
    });
  } catch (error) {
    console.error("Error creating support issue:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.support = functions.https.onRequest(app);

