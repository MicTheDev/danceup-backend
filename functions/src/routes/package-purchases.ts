import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import packagePurchaseService from "../services/package-purchase.service";
import packagesService from "../services/packages.service";
import studentsService from "../services/students.service";
import * as stripeService from "../services/stripe.service";
import authService from "../services/auth.service";
import { getFirestore } from "../utils/firestore";
import { verifyToken } from "../utils/auth";
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

app.post("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { packageId, studioOwnerId } = req.body as { packageId?: string; studioOwnerId?: string };
    if (!packageId) return sendErrorResponse(req, res, 400, "Bad Request", "Package ID is required");
    if (!studioOwnerId) return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");

    const result = await packagePurchaseService.purchasePackageForUser(packageId, user.uid, studioOwnerId);
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

app.post("/for-student", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { packageId, studentId, studioOwnerId } = req.body as { packageId?: string; studentId?: string; studioOwnerId?: string };
    if (!packageId) return sendErrorResponse(req, res, 400, "Bad Request", "Package ID is required");
    if (!studentId) return sendErrorResponse(req, res, 400, "Bad Request", "Student ID is required");
    if (!studioOwnerId) return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");

    const authenticatedStudioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!authenticatedStudioOwnerId || authenticatedStudioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only purchase packages for students in your own studio");
    }

    const result = await packagePurchaseService.purchasePackageForStudent(packageId, studentId, studioOwnerId);
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

app.get("/student/:studentId/payment-methods", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const studentId = req.params["studentId"] as string;

    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Only studio owners can access student payment methods");
    }

    const student = await studentsService.getStudentById(studentId, studioOwnerId) as Record<string, unknown> | null;
    if (!student) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    if (!student["authUid"]) {
      return sendJsonResponse(req, res, 200, []);
    }

    const profileDoc = await authService.getStudentProfileByAuthUid(student["authUid"] as string);
    const stripeCustomerId = profileDoc ? (profileDoc.data() as Record<string, unknown>)["stripeCustomerId"] as string : null;
    if (!stripeCustomerId) {
      return sendJsonResponse(req, res, 200, []);
    }

    const paymentMethods = await stripeService.listPaymentMethods(stripeCustomerId);
    sendJsonResponse(req, res, 200, paymentMethods.map((pm) => ({
      id: pm.id,
      brand: (pm.card as unknown as Record<string, unknown>)["brand"],
      last4: (pm.card as unknown as Record<string, unknown>)["last4"],
      expMonth: (pm.card as unknown as Record<string, unknown>)["exp_month"],
      expYear: (pm.card as unknown as Record<string, unknown>)["exp_year"],
    })));
  } catch (error) {
    console.error("Error fetching student payment methods:", error);
    handleError(req, res, error);
  }
});

app.post("/charge-card-for-student", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { packageId, studentId, studioOwnerId, paymentMethodId } = req.body as {
      packageId?: string; studentId?: string; studioOwnerId?: string; paymentMethodId?: string;
    };
    if (!packageId || !studentId || !studioOwnerId || !paymentMethodId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "packageId, studentId, studioOwnerId, and paymentMethodId are required");
    }

    const authenticatedStudioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!authenticatedStudioOwnerId || authenticatedStudioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only charge cards for students in your own studio");
    }

    const student = await studentsService.getStudentById(studentId, studioOwnerId) as Record<string, unknown> | null;
    if (!student || !student["authUid"]) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    const profileDoc = await authService.getStudentProfileByAuthUid(student["authUid"] as string);
    const stripeCustomerId = profileDoc ? (profileDoc.data() as Record<string, unknown>)["stripeCustomerId"] as string : null;
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Student does not have a saved payment method. Please ask them to add one from their dashboard.");
    }

    const savedMethods = await stripeService.listPaymentMethods(stripeCustomerId);
    if (!savedMethods.some((pm) => pm.id === paymentMethodId)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this student");
    }

    const packageData = await packagesService.getPackageById(packageId, studioOwnerId) as Record<string, unknown> | null;
    if (!packageData || !packageData["isActive"]) {
      return sendErrorResponse(req, res, 404, "Not Found", "Package not found or not active");
    }

    const db = getFirestore();
    const studioOwnerDoc = await db.collection("users").doc(studioOwnerId).get();
    const connectedAccountId = studioOwnerDoc.exists ? ((studioOwnerDoc.data() as Record<string, unknown>)["stripeAccountId"] as string) || null : null;

    const paymentIntent = await stripeService.chargePaymentMethodDirectly(
      stripeCustomerId,
      paymentMethodId,
      Math.round((packageData["price"] as number) * 100),
      { purchaseType: "package", itemId: packageId, studioOwnerId, studentId, chargedBy: "studio_owner" },
      connectedAccountId,
    );

    if ((paymentIntent as unknown as Record<string, unknown>)["status"] === "requires_action") {
      return sendErrorResponse(req, res, 402, "Authentication Required", "This card requires additional authentication. Please ask the student to update their payment method from their dashboard.");
    }

    if ((paymentIntent as unknown as Record<string, unknown>)["status"] !== "succeeded") {
      return sendErrorResponse(req, res, 402, "Payment Failed", "The card charge failed. Please try a different payment method.");
    }

    const result = await packagePurchaseService.purchasePackageForStudent(packageId, studentId, studioOwnerId);
    sendJsonResponse(req, res, 200, { message: "Card charged and package credited successfully", paymentMethod: "card", ...result });
  } catch (error) {
    console.error("Error charging student card:", error);
    handleError(req, res, error);
  }
});

app.post("/cash-for-student", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const { packageId, studentId, studioOwnerId } = req.body as { packageId?: string; studentId?: string; studioOwnerId?: string };
    if (!packageId || !studentId || !studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "packageId, studentId, and studioOwnerId are required");
    }

    const authenticatedStudioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!authenticatedStudioOwnerId || authenticatedStudioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only record payments for students in your own studio");
    }

    const result = await packagePurchaseService.purchasePackageForStudent(packageId, studentId, studioOwnerId) as Record<string, unknown>;

    try {
      const db = getFirestore();
      let packagePrice = 0;
      try {
        const pkgDoc = await db.collection("packages").doc(packageId).get();
        if (pkgDoc.exists) packagePrice = ((pkgDoc.data() as Record<string, unknown>)["price"] as number) || 0;
      } catch { /* non-critical */ }

      const cashDoc: Record<string, unknown> = {
        studioOwnerId,
        amount: packagePrice,
        paymentMethod: "cash",
        status: "completed",
        source: "package",
        studentId,
        purchaseType: "package",
        itemId: packageId,
        itemName: result["packageName"],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      try {
        const studentDoc = await db.collection("students").doc(studentId).get();
        if (studentDoc.exists) {
          const s = studentDoc.data() as Record<string, unknown>;
          cashDoc["studentName"] = [s["firstName"], s["lastName"]].filter(Boolean).join(" ");
        }
      } catch { /* non-critical */ }

      await db.collection("cashPurchases").add(cashDoc);
    } catch (cashErr) {
      console.error("Non-critical: failed to write cashPurchases record:", cashErr);
    }

    sendJsonResponse(req, res, 200, { message: "Cash payment recorded and package credited successfully", paymentMethod: "cash", ...result });
  } catch (error) {
    console.error("Error recording cash payment:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const packagePurchases = functions.https.onRequest(app);
