const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const {getFirestore} = require("./utils/firestore");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} = require("./utils/http");

const app = express();

// Handle OPTIONS preflight — only reflect origin if it is in the allowlist
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  return res.status(204).send("");
});

app.use(cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({extended: true}));

/**
 * POST /
 * Submit a contact inquiry — saved to the Inquiry Firestore collection.
 * Public endpoint — no authentication required.
 */
app.post("/", async (req, res) => {
  try {
    const {name, email, subject, message} = req.body;

    const errors = [];
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      errors.push({field: "name", message: "Name is required"});
    }
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.push({field: "email", message: "A valid email address is required"});
    }
    if (!subject || typeof subject !== "string" || subject.trim().length === 0) {
      errors.push({field: "subject", message: "Subject is required"});
    }
    if (!message || typeof message !== "string" || message.trim().length < 10) {
      errors.push({field: "message", message: "Message must be at least 10 characters"});
    }

    if (errors.length > 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Please fix the errors below", {errors});
    }

    const db = getFirestore();
    const docRef = await db.collection("Inquiry").add({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      subject: subject.trim(),
      message: message.trim(),
      status: "new",
      source: "users-app",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 201, {id: docRef.id, message: "Inquiry submitted successfully"});
  } catch (error) {
    console.error("Error saving contact inquiry:", error);
    handleError(req, res, error);
  }
});

app.use((err, req, res, _next) => {
  console.error("Contact error:", err);
  handleError(req, res, err);
});

exports.contact = functions.https.onRequest(app);
