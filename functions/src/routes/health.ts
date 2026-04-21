import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express from "express";
import { setCorsHeaders, isAllowedOrigin, applySecurityMiddleware } from "../utils/http";

const START_TIME = Date.now();

const app = express();
applySecurityMiddleware(app);

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.status(204).send();
});

app.get("/", (req, res) => {
  setCorsHeaders(req, res);
  res.status(200).json({
    status: "ok",
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
  });
});

app.get("/ready", async (req, res) => {
  setCorsHeaders(req, res);
  try {
    await admin.firestore().doc("_health/ping").get();
    res.status(200).json({
      status: "ok",
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      checks: { firestore: "ok" },
    });
  } catch (error) {
    console.error("Readiness check failed:", error instanceof Error ? error.message : String(error));
    res.status(503).json({
      status: "unavailable",
      checks: { firestore: "error" },
    });
  }
});

export const health = functions.https.onRequest(app);
