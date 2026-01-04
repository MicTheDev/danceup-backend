const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const workshopsService = require("./services/workshops.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {
  validateCreateWorkshopPayload,
  validateUpdateWorkshopPayload,
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
 * OPTIONS /public
 * Handle CORS preflight for public workshops endpoint
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
 * Get all public workshops with optional filters (no authentication required)
 */
app.get("/public", async (req, res) => {
  try {
    // Extract filter parameters from query string
    const filters = {
      level: req.query.level || null,
      city: req.query.city || null,
      state: req.query.state || null,
      studioName: req.query.studioName || null,
      minPrice: req.query.minPrice ? parseFloat(req.query.minPrice) : null,
      maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : null,
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null,
    };

    // Get all public workshops with filters
    const workshops = await workshopsService.getAllPublicWorkshops(filters);

    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("Error getting public workshops:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /public/:id
 * Handle CORS preflight for public workshop detail endpoint
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
 * Get a single public workshop by ID (no authentication required)
 */
app.get("/public/:id", async (req, res) => {
  try {
    const {id} = req.params;

    // Get the workshop
    const workshopData = await workshopsService.getPublicWorkshopById(id);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found or not available");
    }

    sendJsonResponse(req, res, 200, workshopData);
  } catch (error) {
    console.error("Error getting public workshop:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /
 * Get all workshops for the authenticated studio owner
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
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get all workshops for this studio owner
    const workshops = await workshopsService.getWorkshops(studioOwnerId);

    sendJsonResponse(req, res, 200, workshops);
  } catch (error) {
    console.error("Error getting workshops:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new workshop
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

    // Extract image file from payload if present
    const {imageFile, ...workshopData} = req.body;

    // Validate input (excluding imageFile)
    const validation = validateCreateWorkshopPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid workshop data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Create the workshop first to get the ID
    const workshopId = await workshopsService.createWorkshop(workshopData, studioOwnerId);

    // Handle image upload if provided
    let imageUrl = null;
    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        // Extract file extension from mimeType (e.g., "image/png" -> "png")
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `workshop-${Date.now()}.${extension}`;

        imageUrl = await storageService.uploadWorkshopImage(
            fileBuffer,
            fileName,
            mimeType,
            studioOwnerId,
            workshopId,
        );

        // Update the workshop with the image URL
        await workshopsService.updateWorkshop(workshopId, {imageUrl}, studioOwnerId);
      } catch (imageError) {
        console.error("Error uploading workshop image:", imageError);
        console.error("Image upload error details:", {
          message: imageError.message,
          stack: imageError.stack,
          studioOwnerId,
          workshopId,
        });
        // Continue without image - workshop is still created
      }
    }

    sendJsonResponse(req, res, 201, {
      id: workshopId,
      message: "Workshop created successfully",
    });
  } catch (error) {
    console.error("Error creating workshop:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id
 * Get a single workshop by ID
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
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get the workshop
    const workshopData = await workshopsService.getWorkshopById(id, studioOwnerId);
    if (!workshopData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Workshop not found");
    }

    sendJsonResponse(req, res, 200, workshopData);
  } catch (error) {
    console.error("Error getting workshop:", error);
    
    // Handle access denied errors
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * PUT /:id
 * Update an existing workshop
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

    // Extract image file from payload if present
    const {imageFile, ...workshopData} = req.body;

    // Validate input (excluding imageFile)
    const validation = validateUpdateWorkshopPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid workshop data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Handle image upload if provided
    let imageUrl = undefined;
    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        // Extract file extension from mimeType (e.g., "image/png" -> "png")
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `workshop-${Date.now()}.${extension}`;

        imageUrl = await storageService.uploadWorkshopImage(
            fileBuffer,
            fileName,
            mimeType,
            studioOwnerId,
            id,
        );
      } catch (imageError) {
        console.error("Error uploading workshop image:", imageError);
        console.error("Image upload error details:", {
          message: imageError.message,
          stack: imageError.stack,
          studioOwnerId,
          workshopId: id,
        });
        return sendErrorResponse(req, res, 400, "File Upload Error", imageError.message || "Failed to upload workshop image");
      }
    }

    // Add imageUrl to payload if uploaded
    const payload = imageUrl !== undefined ? {...workshopData, imageUrl} : workshopData;

    // Update the workshop
    await workshopsService.updateWorkshop(id, payload, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Workshop updated successfully",
    });
  } catch (error) {
    console.error("Error updating workshop:", error);
    
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
 * Delete a workshop
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
    const studioOwnerId = await workshopsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Delete the workshop
    await workshopsService.deleteWorkshop(id, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Workshop deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting workshop:", error);
    
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
exports.workshops = functions.https.onRequest(app);

