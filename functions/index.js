const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

// Initialize Firebase Admin
if (!admin.apps.length) {
  // Try to use explicit service account credentials if available
  // This is needed for createCustomToken to work properly
  let credential = null;
  
  // Check if service account credentials are provided via environment variable
  // This would be set in Google Cloud Console as a secret or environment variable
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(serviceAccount);
      console.log("Initializing Firebase Admin with explicit service account credentials");
      console.log("Service account email:", serviceAccount.client_email);
      console.log("IMPORTANT: This service account needs 'Service Account Token Creator' role on itself");
      console.log("Grant the role to:", serviceAccount.client_email);
    } catch (error) {
      console.warn("Failed to parse FIREBASE_SERVICE_ACCOUNT, using default credentials:", error.message);
    }
  }
  
  if (credential) {
    admin.initializeApp({
      credential: credential,
    });
  } else {
    // Use Application Default Credentials (ADC)
    // This uses the Cloud Function's service account
    admin.initializeApp();
    console.log("Firebase Admin initialized with Application Default Credentials");
    console.log("Note: The function's service account needs 'Service Account Token Creator' role");
  }
}

// Initialize Express app
const app = express();

// CORS configuration
const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    // Allow localhost for development
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return callback(null, true);
    }

    // Allow all origins for now (you can restrict this in production)
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

// Explicitly handle OPTIONS requests for preflight
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({extended: true}));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "danceup-backend",
  });
});

// API routes
app.use("/v1/auth", require("./routes/auth"));
app.use("/v1/classes", require("./routes/classes"));
app.use("/v1/instructors", require("./routes/instructors"));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && {stack: err.stack}),
  });
});

// Export Express app as Firebase Function
exports.api = functions.https.onRequest(app);

// Export app for testing
module.exports.app = app;

