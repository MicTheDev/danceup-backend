const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {setCorsHeaders, isAllowedOrigin, applySecurityMiddleware} = require("./utils/http");

const START_TIME = Date.now();

/**
 * GET /health
 * Liveness probe — confirms the function is running.
 * Returns 200 immediately without hitting dependencies.
 */
const healthApp = require("express")();
applySecurityMiddleware(healthApp);

healthApp.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res.status(204).send();
});

healthApp.get("/", (req, res) => {
  setCorsHeaders(req, res);
  res.status(200).json({
    status: "ok",
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
  });
});

/**
 * GET /health/ready
 * Readiness probe — confirms Firestore is reachable before reporting healthy.
 * Use this for deployment health gates.
 */
healthApp.get("/ready", async (req, res) => {
  setCorsHeaders(req, res);
  try {
    // Lightweight Firestore ping — reads a non-existent doc (no data returned)
    await admin.firestore().doc("_health/ping").get();
    res.status(200).json({
      status: "ok",
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      checks: {firestore: "ok"},
    });
  } catch (error) {
    console.error("Readiness check failed:", error instanceof Error ? error.message : String(error));
    res.status(503).json({
      status: "unavailable",
      checks: {firestore: "error"},
    });
  }
});

exports.health = functions.https.onRequest(healthApp);
