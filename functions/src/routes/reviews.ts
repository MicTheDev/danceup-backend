import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import reviewsService from "../services/reviews.service";
import authService from "../services/auth.service";
import { verifyToken } from "../utils/auth";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

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
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { entityType, entityId, rating, comment } = req.body as {
      entityType?: string; entityId?: string; rating?: unknown; comment?: unknown;
    };

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

    const studentId = await reviewsService.getStudentId(user.uid);
    if (!studentId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Student profile not found");
    }

    const reviewId = await reviewsService.createReview(
      { entityType: entityType as "class" | "instructor" | "studio", entityId, rating, comment: (comment as string) || "" },
      studentId,
      user.uid,
    );

    const review = await reviewsService.getReviewById(reviewId);
    sendJsonResponse(req, res, 201, review);
  } catch (error) {
    console.error("Error creating review:", error);
    const msg = (error as Error).message;
    if (msg?.includes("already has a review")) return sendErrorResponse(req, res, 409, "Conflict", msg);
    if (msg?.includes("not enrolled")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.get("/aggregate/:entityType/:entityId", async (req, res) => {
  try {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };

    if (!["class", "instructor", "studio"].includes(entityType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid entityType. Must be 'class', 'instructor', or 'studio'");
    }

    const aggregateRatings = await reviewsService.getAggregateRatings(entityType as "class" | "instructor" | "studio", entityId);
    if (!aggregateRatings) {
      return sendErrorResponse(req, res, 404, "Not Found", "Entity not found");
    }

    sendJsonResponse(req, res, 200, aggregateRatings);
  } catch (error) {
    console.error("Error getting aggregate ratings:", error);
    handleError(req, res, error);
  }
});

app.get("/id/:id", async (req, res) => {
  try {
    const review = await reviewsService.getReviewById(req.params["id"] as string);
    if (!review) return sendErrorResponse(req, res, 404, "Not Found", "Review not found");
    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error getting review:", error);
    handleError(req, res, error);
  }
});

app.get("/owner/:studioOwnerId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = req.params["studioOwnerId"] as string;
    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!studioOwnerDoc) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    if (studioOwnerDoc.id !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only view reviews for your own studio");
    }

    const entityTypeFilter = req.query["entityType"] as string | undefined;
    const filters = {
      entityType: (entityTypeFilter as "class" | "instructor" | "studio" | undefined) || undefined,
      rating: req.query["rating"] ? parseInt(req.query["rating"] as string, 10) : undefined,
      hasResponse: req.query["hasResponse"] === "true" ? true : req.query["hasResponse"] === "false" ? false : undefined,
      limit: req.query["limit"] ? parseInt(req.query["limit"] as string, 10) : 50,
    };

    const reviews = await reviewsService.getReviewsForStudio(studioOwnerId, filters);
    sendJsonResponse(req, res, 200, reviews);
  } catch (error) {
    console.error("Error getting studio reviews:", error);
    handleError(req, res, error);
  }
});

app.get("/:entityType/:entityId", async (req, res) => {
  try {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };

    if (!["class", "instructor", "studio"].includes(entityType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid entityType. Must be 'class', 'instructor', or 'studio'");
    }

    const filters = {
      limit: req.query["limit"] ? parseInt(req.query["limit"] as string, 10) : 20,
      startAfter: (req.query["startAfter"] as string) || undefined,
    };

    const reviews = await reviewsService.getReviews(entityType as "class" | "instructor" | "studio", entityId, filters);
    sendJsonResponse(req, res, 200, reviews);
  } catch (error) {
    console.error("Error getting reviews:", error);
    handleError(req, res, error);
  }
});

app.put("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { rating, comment } = req.body as { rating?: unknown; comment?: unknown };

    if (rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "rating must be between 1 and 5");
    }
    if (comment !== undefined && (typeof comment !== "string" || comment.length > 2000)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "comment must be a string with max 2000 characters");
    }

    const studentId = await reviewsService.getStudentId(user.uid);
    if (!studentId) return sendErrorResponse(req, res, 403, "Access Denied", "Student profile not found");

    await reviewsService.updateReview(req.params["id"] as string, { rating, comment }, studentId);
    const review = await reviewsService.getReviewById(req.params["id"] as string);
    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error updating review:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.delete("/:id/response", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!studioOwnerDoc) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");

    await reviewsService.deleteResponse(req.params["id"] as string, studioOwnerDoc.id);
    const review = await reviewsService.getReviewById(req.params["id"] as string);
    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error deleting response:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.delete("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;
    const studentId = await reviewsService.getStudentId(user.uid);
    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    const studioOwnerDocId = studioOwnerDoc ? studioOwnerDoc.id : null;

    const review = await reviewsService.getReviewById(id) as Record<string, unknown> | null;
    if (!review) return sendErrorResponse(req, res, 404, "Not Found", "Review not found");

    if (studentId && review["studentId"] === studentId) {
      await reviewsService.deleteReview(id, studentId);
    } else if (studioOwnerDocId) {
      await reviewsService.hardDeleteReview(id, studioOwnerDocId);
    } else {
      return sendErrorResponse(req, res, 403, "Access Denied", "You do not have permission to delete this review");
    }

    sendJsonResponse(req, res, 200, { message: "Review deleted successfully" });
  } catch (error) {
    console.error("Error deleting review:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.post("/:id/response", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { text } = req.body as { text?: string };
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Response text is required");
    }
    if (text.length > 2000) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Response text must be max 2000 characters");
    }

    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!studioOwnerDoc) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");

    await reviewsService.addResponse(req.params["id"] as string, text.trim(), studioOwnerDoc.id);
    const review = await reviewsService.getReviewById(req.params["id"] as string);
    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error adding response:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("already exists")) return sendErrorResponse(req, res, 409, "Conflict", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.put("/:id/response", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { text } = req.body as { text?: string };
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Response text is required");
    }
    if (text.length > 2000) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Response text must be max 2000 characters");
    }

    const studioOwnerDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!studioOwnerDoc) return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");

    await reviewsService.updateResponse(req.params["id"] as string, text.trim(), studioOwnerDoc.id);
    const review = await reviewsService.getReviewById(req.params["id"] as string);
    sendJsonResponse(req, res, 200, review);
  } catch (error) {
    console.error("Error updating response:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found") || msg?.includes("No response exists")) {
      return sendErrorResponse(req, res, 404, "Not Found", msg);
    }
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const reviews = functions.https.onRequest(app);
