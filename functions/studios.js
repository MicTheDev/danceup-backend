const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const studiosService = require("./services/studios.service");
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
 * OPTIONS /public
 * Handle CORS preflight for public studios listing endpoint
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
 * Get all public studios with optional filters (no authentication required)
 */
app.get("/public", async (req, res) => {
  try {
    // Extract filter parameters from query string
    const filters = {
      city: req.query.city || null,
      state: req.query.state || null,
      studioName: req.query.studioName || null,
    };

    // Get all public studios with filters
    const studios = await studiosService.getAllPublicStudios(filters);

    sendJsonResponse(req, res, 200, studios);
  } catch (error) {
    console.error("Error getting public studios:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /public/:id
 * Handle CORS preflight for public studio detail endpoint
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
 * Get a single public studio by ID with instructor details (no authentication required)
 */
app.get("/public/:id", async (req, res) => {
  try {
    const {id} = req.params;

    // Get the studio with instructor details
    const studioData = await studiosService.getPublicStudioById(id);
    if (!studioData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio not found");
    }

    sendJsonResponse(req, res, 200, studioData);
  } catch (error) {
    console.error("Error getting public studio:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.studios = functions.https.onRequest(app);
