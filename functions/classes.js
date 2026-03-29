const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const classesService = require("./services/classes.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {
  validateCreateClassPayload,
  validateUpdateClassPayload,
} = require("./utils/validation");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
} = require("./utils/http");

// Initialize Express app
const app = express();

// CORS — only reflect origin if it is in the allowlist
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  next();
});

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({extended: true}));


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

    // Handle optional class image upload
    const classBody = {...req.body};
    if (classBody.imageFile && typeof classBody.imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(classBody.imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(classBody.imageFile);
        const fileName = `class-image.${mimeType.split("/")[1]}`;
        classBody.imageUrl = await storageService.uploadClassImage(fileBuffer, fileName, mimeType, studioOwnerId, "new");
      } catch (imageError) {
        return sendErrorResponse(req, res, 400, "Image Upload Failed", imageError.message || "Failed to upload class image");
      }
    }
    delete classBody.imageFile;

    // Create the class
    const classId = await classesService.createClass(classBody, studioOwnerId);

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

    // Handle optional class image upload
    const updateBody = {...req.body};
    if (updateBody.imageFile && typeof updateBody.imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(updateBody.imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(updateBody.imageFile);
        const fileName = `class-image.${mimeType.split("/")[1]}`;
        updateBody.imageUrl = await storageService.uploadClassImage(fileBuffer, fileName, mimeType, studioOwnerId, id);
      } catch (imageError) {
        return sendErrorResponse(req, res, 400, "Image Upload Failed", imageError.message || "Failed to upload class image");
      }
    }
    delete updateBody.imageFile;

    // Update the class
    await classesService.updateClass(id, updateBody, studioOwnerId);

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

