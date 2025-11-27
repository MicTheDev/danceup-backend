const admin = require("firebase-admin");

/**
 * Middleware to verify Firebase ID token from Authorization header
 * Attaches user info to request object if token is valid
 */
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing or invalid authorization header",
      });
    }

    const idToken = authHeader.split("Bearer ")[1];

    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      req.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        emailVerified: decodedToken.email_verified,
      };
      next();
    } catch (error) {
      console.error("Error verifying ID token:", error);
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or expired token",
      });
    }
  } catch (error) {
    console.error("Error in verifyToken middleware:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to verify authentication",
    });
  }
};

module.exports = {
  verifyToken,
};


