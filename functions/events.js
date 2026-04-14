const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const eventsService = require("./services/events.service");
const storageService = require("./services/storage.service");
const {verifyToken} = require("./utils/auth");
const {
  validateCreateEventPayload,
  validateUpdateEventPayload,
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
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({extended: true}));


/**
 * GET /public
 * Get all public events with optional filters (no authentication required)
 */
app.get("/public", async (req, res) => {
  try {
    // Extract filter parameters from query string
    const filters = {
      type: req.query.type || null,
      city: req.query.city || null,
      state: req.query.state || null,
      studioName: req.query.studioName || null,
      minPrice: req.query.minPrice ? parseFloat(req.query.minPrice) : null,
      maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : null,
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null,
      lat: req.query.lat ? parseFloat(req.query.lat) : null,
      lng: req.query.lng ? parseFloat(req.query.lng) : null,
      radius: req.query.radius ? parseFloat(req.query.radius) : null,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    };

    // Get all public events with filters
    const events = await eventsService.getAllPublicEvents(filters);

    sendJsonResponse(req, res, 200, events);
  } catch (error) {
    console.error("Error getting public events:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /public/:id
 * Get a single public event by ID (no authentication required)
 */
app.get("/public/:id", async (req, res) => {
  try {
    const {id} = req.params;

    // Get the event
    const eventData = await eventsService.getPublicEventById(id);
    if (!eventData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found or not available");
    }

    sendJsonResponse(req, res, 200, eventData);
  } catch (error) {
    console.error("Error getting public event:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /
 * Get all events for the authenticated studio owner
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
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get all events for this studio owner
    const events = await eventsService.getEvents(studioOwnerId);

    sendJsonResponse(req, res, 200, events);
  } catch (error) {
    console.error("Error getting events:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /
 * Create a new event
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
    const {imageFile, ...eventData} = req.body;

    // Validate input (excluding imageFile)
    const validation = validateCreateEventPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid event data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Create the event first to get the ID
    const eventId = await eventsService.createEvent(eventData, studioOwnerId);

    // Handle image upload if provided
    let imageUrl = null;
    if (imageFile && typeof imageFile === "string") {
      try {
        const fileBuffer = storageService.base64ToBuffer(imageFile);
        const mimeType = storageService.getMimeTypeFromBase64(imageFile);
        // Extract file extension from mimeType (e.g., "image/png" -> "png")
        const extension = mimeType.split("/")[1] || "jpg";
        const fileName = `event-${Date.now()}.${extension}`;

        imageUrl = await storageService.uploadEventImage(
            fileBuffer,
            fileName,
            mimeType,
            studioOwnerId,
            eventId,
        );

        // Update the event with the image URL
        await eventsService.updateEvent(eventId, {imageUrl}, studioOwnerId);
      } catch (imageError) {
        console.error("Error uploading event image:", imageError);
        console.error("Image upload error details:", {
          message: imageError.message,
          stack: imageError.stack,
          studioOwnerId,
          eventId,
        });
        // Continue without image - event is still created
      }
    }

    sendJsonResponse(req, res, 201, {
      id: eventId,
      message: "Event created successfully",
    });
  } catch (error) {
    console.error("Error creating event:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id/attendees
 * Get attendees (purchases) for an event. Stub: returns [] until full implementation.
 */
app.get("/:id/attendees", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
    const {id} = req.params;
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const eventData = await eventsService.getEventById(id, studioOwnerId);
    if (!eventData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
    }
    sendJsonResponse(req, res, 200, []);
  } catch (error) {
    console.error("Error getting event attendees:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id/report
 * Get event report (ticket sales by tier, revenue). Stub: returns empty report until full implementation.
 */
app.get("/:id/report", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }
    const {id} = req.params;
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }
    const eventData = await eventsService.getEventById(id, studioOwnerId);
    if (!eventData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
    }
    const priceTiers = eventData.priceTiers || [];
    const ticketSalesByTier = priceTiers.map((t) => ({
      tierName: t.name || "Tier",
      quantity: 0,
      revenue: 0,
    }));
    const report = {
      eventId: id,
      name: eventData.name || "Event",
      attendeesCount: 0,
      ticketSalesByTier,
      totalTickets: 0,
      totalRevenue: 0,
    };
    sendJsonResponse(req, res, 200, report);
  } catch (error) {
    console.error("Error getting event report:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /:id
 * Get a single event by ID
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
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Get the event
    const eventData = await eventsService.getEventById(id, studioOwnerId);
    if (!eventData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Event not found");
    }

    sendJsonResponse(req, res, 200, eventData);
  } catch (error) {
    console.error("Error getting event:", error);
    
    // Handle access denied errors
    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * PUT /:id
 * Update an existing event
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
    const {imageFile, ...eventData} = req.body;

    // Validate input (excluding imageFile)
    const validation = validateUpdateEventPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid event data", {
        errors: validation.errors,
      });
    }

    // Get studio owner ID from authenticated user
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
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
        const fileName = `event-${Date.now()}.${extension}`;

        imageUrl = await storageService.uploadEventImage(
            fileBuffer,
            fileName,
            mimeType,
            studioOwnerId,
            id,
        );
      } catch (imageError) {
        console.error("Error uploading event image:", imageError);
        console.error("Image upload error details:", {
          message: imageError.message,
          stack: imageError.stack,
          studioOwnerId,
          eventId: id,
        });
        return sendErrorResponse(req, res, 400, "File Upload Error", imageError.message || "Failed to upload event image");
      }
    }

    // Add imageUrl to payload if uploaded
    const payload = imageUrl !== undefined ? {...eventData, imageUrl} : eventData;

    // Update the event
    await eventsService.updateEvent(id, payload, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Event updated successfully",
    });
  } catch (error) {
    console.error("Error updating event:", error);
    
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
 * Delete an event
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
    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    // Delete the event
    await eventsService.deleteEvent(id, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Event deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting event:", error);
    
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
 * GET /upcoming
 * Get upcoming events for the authenticated studio owner (startDate >= today)
 */
app.get("/upcoming", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const studioOwnerId = await eventsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const {getFirestore} = require("./utils/firestore");
    const db = getFirestore();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const snapshot = await db.collection("events")
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const events = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      const startRaw = data.startTime;
      const startDate = startRaw?.toDate ? startRaw.toDate() : (startRaw ? new Date(startRaw) : null);
      if (startDate && startDate >= today) {
        events.push({
          id: doc.id,
          ...data,
          startTime: startDate.toISOString(),
          endTime: data.endTime?.toDate ? data.endTime.toDate().toISOString() : (data.endTime || null),
        });
      }
    });

    events.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    sendJsonResponse(req, res, 200, events);
  } catch (error) {
    console.error("Error getting upcoming events:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.events = functions.https.onRequest(app);

