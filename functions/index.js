const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

// Initialize Firebase Admin
if (!admin.apps.length) {
  // Try to use explicit service account credentials if available
  // This is needed for createCustomToken to work properly
  let credential = null;
  
  // Get project ID from environment (Cloud Functions sets GCLOUD_PROJECT automatically)
  let projectId = process.env.GCLOUD_PROJECT;
  if (!projectId && process.env.FIREBASE_CONFIG) {
    try {
      const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
      projectId = firebaseConfig.projectId;
    } catch (error) {
      console.warn("Failed to parse FIREBASE_CONFIG:", error.message);
    }
  }
  // Fallback to functions config (may not be available in all environments)
  if (!projectId) {
    try {
      const firebaseConfig = functions.config().firebase;
      if (firebaseConfig && firebaseConfig.projectId) {
        projectId = firebaseConfig.projectId;
      }
    } catch (error) {
      // functions.config() may not be available, that's okay
      console.warn("Could not get project from functions.config():", error.message);
    }
  }
  
  // Check if service account credentials are provided via environment variable
  // This would be set in Google Cloud Console as a secret or environment variable
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(serviceAccount);
      // Use project ID from service account if available (most reliable)
      if (serviceAccount.project_id) {
        projectId = serviceAccount.project_id;
      }
      console.log("Initializing Firebase Admin with explicit service account credentials");
      console.log("Service account email:", serviceAccount.client_email);
      console.log("Project ID:", projectId);
      console.log("IMPORTANT: This service account needs 'Service Account Token Creator' role on itself");
      console.log("Grant the role to:", serviceAccount.client_email);
    } catch (error) {
      console.warn("Failed to parse FIREBASE_SERVICE_ACCOUNT, using default credentials:", error.message);
    }
  }
  
  // Build initialization options
  const initOptions = {};
  
  if (credential) {
    initOptions.credential = credential;
  }
  
  // Always set projectId explicitly to avoid configuration errors
  // This is critical for proper Firebase Admin initialization
  if (projectId) {
    initOptions.projectId = projectId;
    console.log("Setting Firebase Admin projectId:", projectId);
  } else {
    console.warn("WARNING: Could not determine project ID. Firebase Admin may not initialize correctly.");
    console.warn("GCLOUD_PROJECT:", process.env.GCLOUD_PROJECT);
    console.warn("FIREBASE_CONFIG:", process.env.FIREBASE_CONFIG ? "present" : "not set");
  }
  
  // Initialize with options
  if (Object.keys(initOptions).length > 0) {
    admin.initializeApp(initOptions);
  } else {
    // Use Application Default Credentials (ADC)
    // This uses the Cloud Function's service account
    admin.initializeApp();
    console.log("Firebase Admin initialized with Application Default Credentials");
    console.log("Note: The function's service account needs 'Service Account Token Creator' role");
  }
  
  // Log the initialized project for debugging
  try {
    const app = admin.app();
    console.log("Firebase Admin initialized successfully. Project:", app.options.projectId || projectId || "unknown");
  } catch (error) {
    console.warn("Could not verify Firebase Admin initialization:", error.message);
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

