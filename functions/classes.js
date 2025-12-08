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

