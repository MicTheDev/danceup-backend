const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const packagesService = require("./services/packages.service");
const packagePurchaseService = require("./services/package-purchase.service");
const {verifyToken} = require("./utils/auth");
const {
  validateCreatePackagePayload,
  validateUpdatePackagePayload,
} = require("./utils/validation");
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
 * GET /
 * Get all packages for the authenticated studio owner
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

    // Get studio owner ID from authenticated user
    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get all packages for this studio owner
    const packages = await packagesService.getPackages(studioOwnerId);

    sendJsonResponse(req, res, 200, packages);
  } catch (error) {
    console.error("Error getting packages:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new package
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
    const validation = validateCreatePackagePayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid package data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Create the package
    const packageId = await packagesService.createPackage(req.body, studioOwnerId);

    sendJsonResponse(req, res, 201, {
      id: packageId,
      message: "Package created successfully",
    });
  } catch (error) {
    console.error("Error creating package:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id
 * Get a single package by ID
 */
app.get("/:id", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get the package
    const packageData = await packagesService.getPackageById(id, studioOwnerId);
    if (!packageData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Package not found");
    }

    sendJsonResponse(req, res, 200, packageData);
  } catch (error) {
    console.error("Error getting package:", error);
    
    // Handle access denied errors
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * PUT /:id
 * Update an existing package
 */
app.put("/:id", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;

    // Validate input
    const validation = validateUpdatePackagePayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid package data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Update the package
    await packagesService.updatePackage(id, req.body, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Package updated successfully",
    });
  } catch (error) {
    console.error("Error updating package:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * DELETE /:id
 * Delete a package
 */
app.delete("/:id", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Delete the package
    await packagesService.deletePackage(id, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Package deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting package:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * GET /public/:studioOwnerId
 * Get all active packages for a studio (public endpoint, no auth required)
 */
app.get("/public/:studioOwnerId", async (req, res) => {
  try {
    const {studioOwnerId} = req.params;

    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");
    }

    // Get all packages for this studio owner
    const allPackages = await packagesService.getPackages(studioOwnerId);
    
    // Filter to only active packages
    const activePackages = allPackages.filter(pkg => pkg.isActive === true);

    sendJsonResponse(req, res, 200, activePackages);
  } catch (error) {
    console.error("Error getting public packages:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /:id/purchase
 * Purchase a package for the authenticated user
 */
app.post("/:id/purchase", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;
    const {studioOwnerId} = req.body;

    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");
    }

    // Purchase the package
    const result = await packagePurchaseService.purchasePackageForUser(
      id,
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
 * POST /:id/purchase-for-student
 * Purchase a package for a student (studio owner action)
 */
app.post("/:id/purchase-for-student", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;
    const {studentId, studioOwnerId} = req.body;

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
      id,
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
exports.packages = functions.https.onRequest(app);


