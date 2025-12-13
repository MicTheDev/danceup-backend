/**
 * Shared authentication utilities for Firebase Functions
 * Provides token verification functionality
 */

const admin = require("firebase-admin");

/**
 * Verify Firebase ID token from Authorization header
 * @param {Request} req - HTTP request
 * @returns {Promise<Object>} - Decoded token with user info
 * @throws {Error} - If token is missing or invalid
 */
async function verifyToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const error = new Error("Missing or invalid authorization header");
    error.status = 401;
    error.error = "Unauthorized";
    throw error;
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified,
    };
  } catch (error) {
    console.error("Error verifying ID token:", error);
    const authError = new Error("Invalid or expired token");
    authError.status = 401;
    authError.error = "Unauthorized";
    throw authError;
  }
}

module.exports = {
  verifyToken,
};





