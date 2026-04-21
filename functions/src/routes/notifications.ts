import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import notificationsService from "../services/notifications.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await notificationsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const limit = parseInt(req.query["limit"] as string) || 50;
    const startAfter = (req.query["startAfter"] as string) || null;

    const notifications = await notificationsService.getNotificationsByStudio(studioOwnerId, limit, startAfter);
    sendJsonResponse(req, res, 200, notifications);
  } catch (error) {
    console.error("Error getting notifications:", error);
    handleError(req, res, error);
  }
});

app.get("/unread-count", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await notificationsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const count = await notificationsService.getUnreadCount(studioOwnerId);
    sendJsonResponse(req, res, 200, { count });
  } catch (error) {
    console.error("Error getting unread count:", error);
    handleError(req, res, error);
  }
});

app.patch("/:notificationId/read", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { notificationId } = req.params;

    const studioOwnerId = await notificationsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await notificationsService.markNotificationAsRead(notificationId, studioOwnerId);

    const db = getFirestore();
    const doc = await db.collection("notifications").doc(notificationId).get();
    sendJsonResponse(req, res, 200, { id: doc.id, ...(doc.data() as Record<string, unknown>) });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    const err = error as Error;
    if (err.message === "Notification not found") return sendErrorResponse(req, res, 404, "Not Found", err.message);
    if (err.message?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", err.message);
    handleError(req, res, error);
  }
});

app.patch("/:notificationId/unread", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { notificationId } = req.params;

    const studioOwnerId = await notificationsService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await notificationsService.markNotificationAsUnread(notificationId, studioOwnerId);

    const db = getFirestore();
    const doc = await db.collection("notifications").doc(notificationId).get();
    sendJsonResponse(req, res, 200, { id: doc.id, ...(doc.data() as Record<string, unknown>) });
  } catch (error) {
    console.error("Error marking notification as unread:", error);
    const err = error as Error;
    if (err.message === "Notification not found") return sendErrorResponse(req, res, 404, "Not Found", err.message);
    if (err.message?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", err.message);
    handleError(req, res, error);
  }
});

app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, _err));

export const notifications = functions.https.onRequest(app);
