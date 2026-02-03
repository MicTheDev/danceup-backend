const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const classesService = require("./services/classes.service");
const {verifyToken} = require("./utils/auth");
const {
  validateCreateClassPayload,
  validateUpdateClassPayload,
} = require("./utils/validation");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
} = require("./utils/http");

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
 * OPTIONS /public
 * Handle CORS preflight for public classes endpoint
 */
app.options("/public", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * GET /public
 * Get all public classes with optional filters (no authentication required)
 */
app.get("/public", async (req, res) => {
  try {
    // Extract filter parameters from query string
    const filters = {
      danceGenre: req.query.danceGenre || null,
      city: req.query.city || null,
      state: req.query.state || null,
      studioName: req.query.studioName || null,
      minPrice: req.query.minPrice ? parseFloat(req.query.minPrice) : null,
      maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : null,
      level: req.query.level || null,
    };

    // Get all public classes with filters
    const classes = await classesService.getAllPublicClasses(filters);

    sendJsonResponse(req, res, 200, classes);
  } catch (error) {
    console.error("Error getting public classes:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /public/:id
 * Handle CORS preflight for public class detail endpoint
 */
app.options("/public/:id", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * GET /public/:id
 * Get a single public class by ID with studio and instructor details (no authentication required)
 */
app.get("/public/:id", async (req, res) => {
  try {
    const {id} = req.params;

    // Get the class with studio and instructor details
    const classData = await classesService.getPublicClassById(id);
    if (!classData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Class not found or not available");
    }

    // Get related classes
    const relatedClasses = await classesService.getRelatedClasses(id, classData.studioOwnerId, 4);

    sendJsonResponse(req, res, 200, {
      ...classData,
      relatedClasses,
    });
  } catch (error) {
    console.error("Error getting public class:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /
 * Get all classes for the authenticated studio owner
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
    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get all classes for this studio owner
    const classes = await classesService.getClasses(studioOwnerId);

    sendJsonResponse(req, res, 200, classes);
  } catch (error) {
    console.error("Error getting classes:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new class
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
    const validation = validateCreateClassPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid class data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Create the class
    const classId = await classesService.createClass(req.body, studioOwnerId);

    sendJsonResponse(req, res, 201, {
      id: classId,
      message: "Class created successfully",
    });
  } catch (error) {
    console.error("Error creating class:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id
 * Get a single class by ID
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
    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get the class
    const classData = await classesService.getClassById(id, studioOwnerId);
    if (!classData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Class not found");
    }

    sendJsonResponse(req, res, 200, classData);
  } catch (error) {
    console.error("Error getting class:", error);
    
    // Handle access denied errors
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * PUT /:id
 * Update an existing class
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
    const validation = validateUpdateClassPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid class data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Update the class
    await classesService.updateClass(id, req.body, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Class updated successfully",
    });
  } catch (error) {
    console.error("Error updating class:", error);
    
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
 * Delete a class
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
    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Delete the class
    await classesService.deleteClass(id, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Class deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting class:", error);
    
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.classes = functions.https.onRequest(app);

