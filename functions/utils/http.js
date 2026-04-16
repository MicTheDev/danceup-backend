/**
 * Shared HTTP utilities for Firebase Functions
 * Provides CORS handling, error handling, and response helpers
 */

const helmet = require("helmet");

/**
 * Allowed origins for CORS.
 * Localhost is permitted for local development and emulator use.
 * Add custom production domains here when they are configured.
 */
const ALLOWED_ORIGINS = new Set([
  // Dev
  "https://danceup-users-dev--dev-danceup.us-east4.hosted.app",
  "https://danceup-studio-owners-dev--dev-danceup.us-east4.hosted.app",
  // Staging
  "https://danceup-users-staging--staging-danceup.us-east4.hosted.app",
  "https://danceup-studio-owners--staging-danceup.us-east4.hosted.app",
  // Production (Firebase Hosting URLs — replace or supplement with custom domains when ready)
  "https://danceup-users-production--production-danceup.us-east4.hosted.app",
  "https://danceup-studio-owners--production-danceup.us-east4.hosted.app",
]);

/**
 * Returns true if the given origin is allowed to make cross-origin requests.
 * @param {string} origin
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
    return true;
  }
  return ALLOWED_ORIGINS.has(origin);
}

/**
 * CORS configuration
 */
const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS policy`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

/**
 * Handle CORS preflight requests
 * @param {Request} req - HTTP request
 * @param {Response} res - HTTP response
 * @returns {boolean} - True if request was handled, false otherwise
 */
function handleCorsPreflight(req, res) {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
    }
    res.set("Access-Control-Allow-Methods", corsOptions.methods.join(", "));
    res.set("Access-Control-Allow-Headers", corsOptions.allowedHeaders.join(", "));
    res.set("Access-Control-Max-Age", "3600");
    res.status(corsOptions.optionsSuccessStatus).send("");
    return true;
  }
  return false;
}

/**
 * Set CORS headers on response
 * @param {Request} req - HTTP request
 * @param {Response} res - HTTP response
 */
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
  }
  res.set("Access-Control-Expose-Headers", corsOptions.exposedHeaders.join(", "));
}

/**
 * Parse JSON request body
 * @param {Request} req - HTTP request
 * @returns {Promise<Object>} - Parsed JSON body
 */
async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        if (!body) {
          resolve({});
        } else {
          resolve(JSON.parse(body));
        }
      } catch (error) {
        reject(new Error("Invalid JSON in request body"));
      }
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

/**
 * Send JSON response with CORS headers
 * @param {Request} req - HTTP request
 * @param {Response} res - HTTP response
 * @param {number} statusCode - HTTP status code
 * @param {Object} data - Response data
 */
function sendJsonResponse(req, res, statusCode, data) {
  setCorsHeaders(req, res);
  res.status(statusCode).json(data);
}

/**
 * Send error response with CORS headers
 * @param {Request} req - HTTP request
 * @param {Response} res - HTTP response
 * @param {number} statusCode - HTTP status code
 * @param {string} error - Error type
 * @param {string} message - Error message
 * @param {Object} additionalData - Additional error data
 */
function sendErrorResponse(req, res, statusCode, error, message, additionalData = {}) {
  setCorsHeaders(req, res);
  // Never include stack traces or internal details outside of local development
  const {stack: _stack, ...safeData} = additionalData;
  const response = {
    error,
    message,
    ...safeData,
  };
  if (process.env.NODE_ENV === "development" && _stack) {
    response.stack = _stack;
  }
  res.status(statusCode).json(response);
}

/**
 * Handle errors in async functions
 * @param {Request} req - HTTP request
 * @param {Response} res - HTTP response
 * @param {Error} error - Error object
 */
function handleError(req, res, error) {
  console.error("Unhandled error:", error instanceof Error ? error.message : String(error));

  // Handle known error types
  if (error.status) {
    return sendErrorResponse(req, res, error.status, error.error || "Error", error.message || "An error occurred");
  }

  // Handle validation errors
  if (error.name === "ValidationError" || error.message?.includes("Validation")) {
    return sendErrorResponse(req, res, 400, "Validation Error", error.message || "Invalid input", {
      errors: error.errors || [],
    });
  }

  // Default to 500 — stack is stripped from the response by sendErrorResponse in non-dev
  sendErrorResponse(req, res, 500, "Internal Server Error", "An unexpected error occurred", {
    stack: error.stack,
  });
}

/**
 * Extract path parameters from URL
 * For Firebase Functions, the URL path starts after the function name
 * @param {string} url - Request URL (e.g., "/123" or "/class/123")
 * @param {string} pattern - URL pattern (e.g., "/class/:id" or "/:id")
 * @returns {Object|null} - Parameters object or null if pattern doesn't match
 */
function extractPathParams(url, pattern) {
  // Remove query string
  const path = url.split("?")[0];
  // Split and filter empty parts
  const patternParts = pattern.split("/").filter((p) => p);
  const urlParts = path.split("/").filter((p) => p);
  
  if (patternParts.length !== urlParts.length) {
    return null;
  }
  
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      const paramName = patternParts[i].substring(1);
      params[paramName] = urlParts[i];
    } else if (patternParts[i] !== urlParts[i]) {
      return null;
    }
  }
  
  return params;
}

/**
 * Apply common security middleware to an Express app.
 * Call this once per app, before registering routes.
 * @param {import('express').Application} app
 */
function applySecurityMiddleware(app) {
  // Standard security headers (X-Content-Type-Options, X-Frame-Options,
  // Strict-Transport-Security, Referrer-Policy, etc.)
  app.use(helmet({
    // crossOriginResourcePolicy is set to cross-origin so Firebase Hosting
    // can serve assets from a different origin without blocking them.
    crossOriginResourcePolicy: {policy: "cross-origin"},
    // contentSecurityPolicy is left to the frontend apps; APIs don't serve HTML.
    contentSecurityPolicy: false,
  }));
}

module.exports = {
  corsOptions,
  isAllowedOrigin,
  handleCorsPreflight,
  setCorsHeaders,
  parseJsonBody,
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  extractPathParams,
  applySecurityMiddleware,
};

