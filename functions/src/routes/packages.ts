import * as functions from "firebase-functions";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import packagesService from "../services/packages.service";
import packagePurchaseService from "../services/package-purchase.service";
import { verifyToken } from "../utils/auth";
import { validateCreatePackagePayload, validateUpdatePackagePayload } from "../utils/validation";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

app.get("/public/:studioOwnerId", async (req, res) => {
  try {
    const studioOwnerId = req.params["studioOwnerId"] as string;
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");
    }
    const allPackages = await packagesService.getPackages(studioOwnerId) as Array<Record<string, unknown>>;
    const activePackages = allPackages.filter((pkg) => pkg["isActive"] === true);
    sendJsonResponse(req, res, 200, activePackages);
  } catch (error) {
    console.error("Error getting public packages:", error);
    handleError(req, res, error);
  }
});

app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const packages = await packagesService.getPackages(studioOwnerId);
    sendJsonResponse(req, res, 200, packages);
  } catch (error) {
    console.error("Error getting packages:", error);
    handleError(req, res, error);
  }
});

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const validation = validateCreatePackagePayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid package data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const packageId = await packagesService.createPackage(req.body, studioOwnerId);
    sendJsonResponse(req, res, 201, { id: packageId, message: "Package created successfully" });
  } catch (error) {
    console.error("Error creating package:", error);
    handleError(req, res, error);
  }
});

app.get("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    const packageData = await packagesService.getPackageById(req.params["id"] as string, studioOwnerId);
    if (!packageData) {
      return sendErrorResponse(req, res, 404, "Not Found", "Package not found");
    }

    sendJsonResponse(req, res, 200, packageData);
  } catch (error) {
    console.error("Error getting package:", error);
    if ((error as Error).message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", (error as Error).message);
    }
    handleError(req, res, error);
  }
});

app.put("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const validation = validateUpdatePackagePayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid package data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await packagesService.updatePackage(req.params["id"] as string, req.body, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Package updated successfully" });
  } catch (error) {
    console.error("Error updating package:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.delete("/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found or insufficient permissions");
    }

    await packagesService.deletePackage(req.params["id"] as string, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Package deleted successfully" });
  } catch (error) {
    console.error("Error deleting package:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.post("/:id/purchase", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { studioOwnerId } = req.body as { studioOwnerId?: string };
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");
    }

    const result = await packagePurchaseService.purchasePackageForUser(req.params["id"] as string, user.uid, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Package purchased successfully", ...result });
  } catch (error) {
    console.error("Error purchasing package:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found") || msg?.includes("not enrolled")) {
      return sendErrorResponse(req, res, 404, "Not Found", msg);
    }
    if (msg?.includes("not active")) return sendErrorResponse(req, res, 400, "Bad Request", msg);
    handleError(req, res, error);
  }
});

app.post("/:id/purchase-for-student", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { studentId, studioOwnerId } = req.body as { studentId?: string; studioOwnerId?: string };
    if (!studentId) return sendErrorResponse(req, res, 400, "Bad Request", "Student ID is required");
    if (!studioOwnerId) return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");

    const authenticatedStudioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!authenticatedStudioOwnerId || authenticatedStudioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only purchase packages for students in your own studio");
    }

    const result = await packagePurchaseService.purchasePackageForStudent(req.params["id"] as string, studentId, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Package purchased successfully for student", ...result });
  } catch (error) {
    console.error("Error purchasing package for student:", error);
    const msg = (error as Error).message;
    if (msg?.includes("not found")) return sendErrorResponse(req, res, 404, "Not Found", msg);
    if (msg?.includes("not active")) return sendErrorResponse(req, res, 400, "Bad Request", msg);
    if (msg?.includes("Access denied")) return sendErrorResponse(req, res, 403, "Access Denied", msg);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const packages = functions.https.onRequest(app);
