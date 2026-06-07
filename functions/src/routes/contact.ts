import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import { getFirestore } from "../utils/firestore";
import { sendJsonResponse, sendErrorResponse, handleError, isAllowedOrigin, applySecurityMiddleware } from "../utils/http";

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
    const { name, email, subject, message } = req.body as {
      name?: string;
      email?: string;
      subject?: string;
      message?: string;
    };

    const errors: { field: string; message: string }[] = [];
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      errors.push({ field: "name", message: "Name is required" });
    }
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.push({ field: "email", message: "A valid email address is required" });
    }
    if (!subject || typeof subject !== "string" || subject.trim().length === 0) {
      errors.push({ field: "subject", message: "Subject is required" });
    }
    if (!message || typeof message !== "string" || message.trim().length < 10) {
      errors.push({ field: "message", message: "Message must be at least 10 characters" });
    }

    if (errors.length > 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Please fix the errors below", { errors });
    }

    const db = getFirestore();
    const docRef = await db.collection("Inquiry").add({
      name: name!.trim(),
      email: email!.trim().toLowerCase(),
      subject: subject!.trim(),
      message: message!.trim(),
      status: "new",
      source: "users-app",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 201, { id: docRef.id, message: "Inquiry submitted successfully" });
  } catch (error) {
    console.error("Error saving contact inquiry:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Contact error:", err);
  handleError(_req, res, err);
});

export const contact = functions.https.onRequest(app);
