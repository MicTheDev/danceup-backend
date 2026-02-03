/**
 * Shared HTTP utilities for Firebase Functions
 * Provides CORS handling, error handling, and response helpers
 */

/**
 * CORS configuration
 */
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

/**
 * Handle CORS preflight requests
 * @param {Request} req - HTTP request
 * @param {Response} res - HTTP response
 * @returns {boolean} - True if request was handled, false otherwise
 */
function handleCorsPreflight(req, res) {
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.set("Access-Control-Allow-Methods", corsOptions.methods.join(", "));
    res.set("Access-Control-Allow-Headers", corsOptions.allowedHeaders.join(", "));
    res.set("Access-Control-Allow-Credentials", "true");
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
  res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.set("Access-Control-Allow-Credentials", "true");
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
  const response = {
    error,
    message,
    ...additionalData,
  };
  if (process.env.NODE_ENV === "development" && additionalData.stack) {
    response.stack = additionalData.stack;
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
  console.error("Error:", error);
  
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
  
  // Default to 500
  sendErrorResponse(req, res, 500, "Internal Server Error", error.message || "An unexpected error occurred", {
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

module.exports = {
  corsOptions,
  handleCorsPreflight,
  setCorsHeaders,
  parseJsonBody,
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  extractPathParams,
};

