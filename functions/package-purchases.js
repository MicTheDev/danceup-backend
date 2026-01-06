const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const packagePurchaseService = require("./services/package-purchase.service");
const packagesService = require("./services/packages.service");
const {verifyToken} = require("./utils/auth");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
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

// Apply CORS middleware (backup)
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({extended: true}));

/**
 * POST /
 * Purchase a package for the authenticated user
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

    const {packageId, studioOwnerId} = req.body;

    if (!packageId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Package ID is required");
    }

    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");
    }

    // Purchase the package
    const result = await packagePurchaseService.purchasePackageForUser(
      packageId,
      user.uid,
      studioOwnerId
    );

    sendJsonResponse(req, res, 200, {
      message: "Package purchased successfully",
      ...result,
    });
  } catch (error) {
    console.error("Error purchasing package:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found") || error.message?.includes("not enrolled")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("not active")) {
      return sendErrorResponse(req, res, 400, "Bad Request", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * POST /for-student
 * Purchase a package for a student (studio owner action)
 */
app.post("/for-student", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {packageId, studentId, studioOwnerId} = req.body;

    if (!packageId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Package ID is required");
    }

    if (!studentId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Student ID is required");
    }

    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");
    }

    // Verify the authenticated user is the studio owner
    const authenticatedStudioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!authenticatedStudioOwnerId || authenticatedStudioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only purchase packages for students in your own studio");
    }

    // Purchase the package for the student
    const result = await packagePurchaseService.purchasePackageForStudent(
      packageId,
      studentId,
      studioOwnerId
    );

    sendJsonResponse(req, res, 200, {
      message: "Package purchased successfully for student",
      ...result,
    });
  } catch (error) {
    console.error("Error purchasing package for student:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("not active")) {
      return sendErrorResponse(req, res, 400, "Bad Request", error.message);
    }

    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.packagePurchases = functions.https.onRequest(app);

