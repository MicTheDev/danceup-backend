import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import authService from "../services/auth.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { sendJsonResponse, sendErrorResponse, handleError, isAllowedOrigin, applySecurityMiddleware } from "../utils/http";

const app = express();

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
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  next();
});

app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

app.post("/", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const { page, description } = req.body as { page?: string; description?: string };

    if (!page || typeof page !== "string" || page.trim().length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Page is required", {
        errors: [{ field: "page", message: "Page is required" }],
      });
    }

    if (!description || typeof description !== "string" || description.trim().length === 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Description is required", {
        errors: [{ field: "description", message: "Description is required" }],
      });
    }

    const userDoc = await authService.getUserDocumentByAuthUid(user.uid);
    if (!userDoc) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userData = userDoc.data() as Record<string, unknown> | undefined;

    if (!authService.hasStudioOwnerRole(userDoc)) {
      return sendErrorResponse(req, res, 403, "Access Denied", "This account does not have studio owner access");
    }

    const db = getFirestore();
    const supportIssueData = {
      page: page.trim(),
      description: description.trim(),
      email: user.email || "",
      studioName: (userData?.["studioName"] as string) || "",
      uid: user.uid,
      studioOwnerId: userDoc.id,
      status: "open",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("support_issues").add(supportIssueData);

    sendJsonResponse(req, res, 201, { id: docRef.id, message: "Support issue reported successfully" });
  } catch (error) {
    console.error("Error creating support issue:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Error:", err);
  handleError(_req, res, err);
});

export const support = functions.https.onRequest(app);
