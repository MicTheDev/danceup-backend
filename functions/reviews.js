const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const reviewsService = require("./services/reviews.service");
const authService = require("./services/auth.service");
const {verifyToken} = require("./utils/auth");
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
 * POST /reviews
 * Create a new review (student auth required)
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
    const {entityType, entityId, rating, comment} = req.body;

    if (!entityType || !["class", "instructor", "studio"].includes(entityType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid entityType. Must be 'class', 'instructor', or 'studio'");
    }

    if (!entityId || typeof entityId !== "string") {
      return sendErrorResponse(req, res, 400, "Validation Error", "entityId is required");
    }

    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5) {
      return sendErrorResponse(req, res, 400, "Validation Error", "rating is required and must be between 1 and 5");
    }

    if (comment && (typeof comment !== "string" || comment.length > 2000)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "comment must be a string with max 2000 characters");
    }

    // Get student ID
    const studentId = await reviewsService.getStudentId(user.uid);
    if (!studentId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Student profile not found");
    }

    // Create the review
    const reviewId = await reviewsService.createReview(
        {
          entityType,
          entityId,
          rating,
          comment: comment || "",
        },
        studentId,
        user.uid,
    );

    // Get the created review
    const review = await reviewsService.getReviewById(reviewId);

    sendJsonResponse(req, res, 201, review);
  } catch (error) {
    console.error("Error creating review:", error);
    
    if (error.message?.includes("already has a review")) {
      return sendErrorResponse(req, res, 409, "Conflict", error.message);
    }
    
    if (error.message?.includes("not enrolled")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * GET /reviews/aggregate/:entityType/:entityId
 * Get aggregate ratings for an entity (public)
 * Must come before /:entityType/:entityId to avoid route conflicts
 */
app.get("/aggregate/:entityType/:entityId", async (req, res) => {
  try {
    const {entityType, entityId} = req.params;

    if (!["class", "instructor", "studio"].includes(entityType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid entityType. Must be 'class', 'instructor', or 'studio'");
    }

    const aggregateRatings = await reviewsService.getAggregateRatings(entityType, entityId);

    if (!aggregateRatings) {
      return sendErrorResponse(req, res, 404, "Not Found", "Entity not found");
    }

    sendJsonResponse(req, res, 200, aggregateRatings);
  } catch (error) {
    console.error("Error getting aggregate ratings:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /reviews/id/:id
 * Get a single review by ID (public)
 * Must come before /:entityType/:entityId to avoid route conflicts
 */
app.get("/id/:id", async (req, res) => {
  try {
    const {id} = req.params;

    const review = await reviewsService.getReviewById(id);

    if (!review) {
      return sendErrorResponse(req, res, 404, "Not Found", "Review not found");
    }

    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error getting review:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /reviews/studio/:studioOwnerId
 * Get all reviews for a studio (studio owner only)
 * Must come before /:entityType/:entityId to avoid route conflicts
 */
app.get("/studio/:studioOwnerId", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {studioOwnerId} = req.params;

    // Get studio owner ID from authenticated user
    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!studioOwnerDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    // Verify the authenticated user owns this studio
    if (studioOwnerDoc.id !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only view reviews for your own studio");
    }

    const filters = {
      entityType: req.query.entityType || null,
      rating: req.query.rating ? parseInt(req.query.rating, 10) : null,
      hasResponse: req.query.hasResponse === "true" ? true : req.query.hasResponse === "false" ? false : undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
    };

    const reviews = await reviewsService.getReviewsForStudio(studioOwnerId, filters);

    sendJsonResponse(req, res, 200, reviews);
  } catch (error) {
    console.error("Error getting studio reviews:", error);
    handleError(req, res, error);
  }
});

/**
 * GET /reviews/:entityType/:entityId
 * Get reviews for an entity (public)
 * Must come after all specific routes to avoid conflicts
 */
app.get("/:entityType/:entityId", async (req, res) => {
  try {
    const {entityType, entityId} = req.params;

    if (!["class", "instructor", "studio"].includes(entityType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid entityType. Must be 'class', 'instructor', or 'studio'");
    }

    const filters = {
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 20,
      startAfter: req.query.startAfter || null,
    };

    const reviews = await reviewsService.getReviews(entityType, entityId, filters);

    sendJsonResponse(req, res, 200, reviews);
  } catch (error) {
    console.error("Error getting reviews:", error);
    handleError(req, res, error);
  }
});

/**
 * PUT /reviews/:id
 * Update a review (student owner only)
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
    const {rating, comment} = req.body;

    // Validate input
    if (rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "rating must be between 1 and 5");
    }

    if (comment !== undefined && (typeof comment !== "string" || comment.length > 2000)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "comment must be a string with max 2000 characters");
    }

    // Get student ID
    const studentId = await reviewsService.getStudentId(user.uid);
    if (!studentId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Student profile not found");
    }

    // Update the review
    await reviewsService.updateReview(id, {rating, comment}, studentId);

    // Get the updated review
    const review = await reviewsService.getReviewById(id);

    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error updating review:", error);
    
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
 * DELETE /reviews/:id
 * Delete a review (student owner or studio owner)
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

    // Try to get student ID first
    const studentId = await reviewsService.getStudentId(user.uid);
    
    // Try to get studio owner ID
    const studioOwnerId = await authService.getUserDocumentByAuthUid(user.uid);
    const studioOwnerDocId = studioOwnerId ? studioOwnerId.id : null;

    // Get the review to determine ownership
    const review = await reviewsService.getReviewById(id);
    if (!review) {
      return sendErrorResponse(req, res, 404, "Not Found", "Review not found");
    }

    // Check if user is the student who wrote the review
    if (studentId && review.studentId === studentId) {
      // Soft delete (student)
      await reviewsService.deleteReview(id, studentId);
    } else if (studioOwnerDocId) {
      // Hard delete (studio owner)
      await reviewsService.hardDeleteReview(id, studioOwnerDocId);
    } else {
      return sendErrorResponse(req, res, 403, "Access Denied", "You do not have permission to delete this review");
    }

    sendJsonResponse(req, res, 200, {
      message: "Review deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting review:", error);
    
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
 * POST /reviews/:id/response
 * Add a response to a review (studio owner only)
 */
app.post("/:id/response", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;
    const {text} = req.body;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Response text is required");
    }

    if (text.length > 2000) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Response text must be max 2000 characters");
    }

    // Get studio owner ID
    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!studioOwnerDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    const studioOwnerId = studioOwnerDoc.id;

    // Add response
    await reviewsService.addResponse(id, text.trim(), studioOwnerId);

    // Get the updated review
    const review = await reviewsService.getReviewById(id);

    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error adding response:", error);
    
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("already exists")) {
      return sendErrorResponse(req, res, 409, "Conflict", error.message);
    }

    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * PUT /reviews/:id/response
 * Update a response to a review (studio owner only)
 */
app.put("/:id/response", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;
    const {text} = req.body;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Response text is required");
    }

    if (text.length > 2000) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Response text must be max 2000 characters");
    }

    // Get studio owner ID
    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!studioOwnerDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    const studioOwnerId = studioOwnerDoc.id;

    // Update response
    await reviewsService.updateResponse(id, text.trim(), studioOwnerId);

    // Get the updated review
    const review = await reviewsService.getReviewById(id);

    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error updating response:", error);
    
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("No response exists")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * DELETE /reviews/:id/response
 * Delete a response to a review (studio owner only)
 */
app.delete("/:id/response", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {id} = req.params;

    // Get studio owner ID
    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!studioOwnerDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    const studioOwnerId = studioOwnerDoc.id;

    // Delete response
    await reviewsService.deleteResponse(id, studioOwnerId);

    // Get the updated review
    const review = await reviewsService.getReviewById(id);

    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error deleting response:", error);
    
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
exports.reviews = functions.https.onRequest(app);
