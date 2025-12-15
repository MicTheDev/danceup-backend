const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const instructorsService = require("./services/instructors.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {
  validateCreateInstructorPayload,
  validateUpdateInstructorPayload,
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
 * Get all instructors for the authenticated studio owner
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
    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get all instructors for this studio owner
    const instructors = await instructorsService.getInstructors(studioOwnerId);

    sendJsonResponse(req, res, 200, instructors);
  } catch (error) {
    console.error("Error getting instructors:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new instructor
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

    // Extract photo file from payload if present
    const {photoFile, ...instructorData} = req.body;

    // Validate input (excluding photoFile)
    const validation = validateCreateInstructorPayload(instructorData);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid instructor data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Handle photo upload if provided
    let photoUrl = null;
    if (photoFile && typeof photoFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(photoFile);
        const mimeType = storageService.getMimeTypeFromBase64(photoFile);
        const fileName = `instructor-${Date.now()}.${mimeType.split("/")[1]}`;

        photoUrl = await storageService.uploadInstructorPhoto(
            fileBuffer,
            fileName,
            mimeType,
        );
      } catch (imageError) {
        console.error("Error uploading instructor photo:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", imageError.message || "Failed to upload instructor photo");
      }
    }

    // Add photoUrl to payload if uploaded
    const payload = photoUrl ? {...instructorData, photoUrl} : instructorData;

    // Create the instructor
    const instructorId = await instructorsService.createInstructor(payload, studioOwnerId);

    sendJsonResponse(req, res, 201, {
      id: instructorId,
      message: "Instructor created successfully",
    });
  } catch (error) {
    console.error("Error creating instructor:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /options
 * Get instructor options for dropdowns (simplified version)
 * IMPORTANT: This route must come before /:id
 */
app.get("/options", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get all instructors for this studio owner
    const instructors = await instructorsService.getInstructors(studioOwnerId);

    // Return simplified options
    const options = instructors.map((instructor) => ({
      id: instructor.id,
      name: `${instructor.firstName} ${instructor.lastName}`.trim(),
    }));

    sendJsonResponse(req, res, 200, options);
  } catch (error) {
    console.error("Error getting instructor options:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /public/:id
 * Handle CORS preflight for public instructor detail endpoint
 */
app.options("/public/:id", (req, res) => {
  res.status(204).send("");
});

/**
 * GET /public/:id
 * Get a single public instructor by ID (no authentication required)
 */
app.get("/public/:id", async (req, res) => {
  try {
    const {id} = req.params;

    // Get the instructor (public access, no authentication required)
    const instructorData = await instructorsService.getPublicInstructorById(id);
    if (!instructorData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    }

    sendJsonResponse(req, res, 200, instructorData);
  } catch (error) {
    console.error("Error getting public instructor:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id
 * Get a single instructor by ID
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
    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get the instructor
    const instructorData = await instructorsService.getInstructorById(id, studioOwnerId);
    if (!instructorData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Instructor not found");
    }

    sendJsonResponse(req, res, 200, instructorData);
  } catch (error) {
    console.error("Error getting instructor:", error);
    
    // Handle access denied errors
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * PUT /:id
 * Update an existing instructor
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

    // Extract photo file from payload if present
    const {photoFile, ...instructorData} = req.body;

    // Validate input (excluding photoFile)
    const validation = validateUpdateInstructorPayload(instructorData);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid instructor data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Handle photo upload if provided
    let photoUrl = undefined;
    if (photoFile && typeof photoFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(photoFile);
        const mimeType = storageService.getMimeTypeFromBase64(photoFile);
        const fileName = `instructor-${Date.now()}.${mimeType.split("/")[1]}`;

        photoUrl = await storageService.uploadInstructorPhoto(
            fileBuffer,
            fileName,
            mimeType,
        );
      } catch (imageError) {
        console.error("Error uploading instructor photo:", imageError);
        return sendErrorResponse(req, res, 400, "File Upload Error", imageError.message || "Failed to upload instructor photo");
      }
    }

    // Add photoUrl to payload if uploaded
    const payload = photoUrl !== undefined ? {...instructorData, photoUrl} : instructorData;

    // Update the instructor
    await instructorsService.updateInstructor(id, payload, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Instructor updated successfully",
    });
  } catch (error) {
    console.error("Error updating instructor:", error);
    
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
 * Delete an instructor
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
    const studioOwnerId = await instructorsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Delete the instructor
    await instructorsService.deleteInstructor(id, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Instructor deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting instructor:", error);
    
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
exports.instructors = functions.https.onRequest(app);

