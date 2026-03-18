const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");
const packagePurchaseService = require("./services/package-purchase.service");
const packagesService = require("./services/packages.service");
const studentsService = require("./services/students.service");
const stripeService = require("./services/stripe.service");
const {getFirestore} = require("./utils/firestore");
const {verifyToken} = require("./utils/auth");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
} = require("./utils/http");

// Initialize Express app
const app = express();

// Explicit CORS handling - must be before other middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Set CORS headers
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  
  next();
});

// Apply CORS middleware (backup)
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({extended: true}));

/**
 * POST /
 * Purchase a package for the authenticated user
 */
app.post("/", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {packageId, studioOwnerId} = req.body;

    if (!packageId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Package ID is required");
    }

    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");
    }

    // Purchase the package
    const result = await packagePurchaseService.purchasePackageForUser(
      packageId,
      user.uid,
      studioOwnerId
    );

    sendJsonResponse(req, res, 200, {
      message: "Package purchased successfully",
      ...result,
    });
  } catch (error) {
    console.error("Error purchasing package:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found") || error.message?.includes("not enrolled")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("not active")) {
      return sendErrorResponse(req, res, 400, "Bad Request", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * POST /for-student
 * Purchase a package for a student (studio owner action)
 */
app.post("/for-student", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {packageId, studentId, studioOwnerId} = req.body;

    if (!packageId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Package ID is required");
    }

    if (!studentId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Student ID is required");
    }

    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Studio owner ID is required");
    }

    // Verify the authenticated user is the studio owner
    const authenticatedStudioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!authenticatedStudioOwnerId || authenticatedStudioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only purchase packages for students in your own studio");
    }

    // Purchase the package for the student
    const result = await packagePurchaseService.purchasePackageForStudent(
      packageId,
      studentId,
      studioOwnerId
    );

    sendJsonResponse(req, res, 200, {
      message: "Package purchased successfully for student",
      ...result,
    });
  } catch (error) {
    console.error("Error purchasing package for student:", error);
    
    // Handle specific error cases
    if (error.message?.includes("not found")) {
      return sendErrorResponse(req, res, 404, "Not Found", error.message);
    }

    if (error.message?.includes("not active")) {
      return sendErrorResponse(req, res, 400, "Bad Request", error.message);
    }

    if (error.message?.includes("Access denied")) {
      return sendErrorResponse(req, res, 403, "Access Denied", error.message);
    }

    handleError(req, res, error);
  }
});

/**
 * GET /student/:studentId/payment-methods
 * Studio owner fetches a student's saved Stripe payment methods
 */
app.get("/student/:studentId/payment-methods", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {studentId} = req.params;

    // Verify authenticated user is a studio owner and get their ID
    const studioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Only studio owners can access student payment methods");
    }

    // Verify the student belongs to this studio
    const student = await studentsService.getStudentById(studentId, studioOwnerId);
    if (!student) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    if (!student.authUid) {
      return sendJsonResponse(req, res, 200, []);
    }

    // Resolve student's Stripe customer ID from their profile
    const authService = require("./services/auth.service");
    const profileDoc = await authService.getStudentProfileByAuthUid(student.authUid);
    const stripeCustomerId = profileDoc ? profileDoc.data().stripeCustomerId : null;
    if (!stripeCustomerId) {
      return sendJsonResponse(req, res, 200, []);
    }

    const paymentMethods = await stripeService.listPaymentMethods(stripeCustomerId);
    sendJsonResponse(req, res, 200, paymentMethods.map((pm) => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    })));
  } catch (error) {
    console.error("Error fetching student payment methods:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /charge-card-for-student
 * Studio owner charges a student's saved Stripe card for a package
 * Body: { packageId, studentId, studioOwnerId, paymentMethodId }
 */
app.post("/charge-card-for-student", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {packageId, studentId, studioOwnerId, paymentMethodId} = req.body;
    if (!packageId || !studentId || !studioOwnerId || !paymentMethodId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "packageId, studentId, studioOwnerId, and paymentMethodId are required");
    }

    // Verify studio ownership
    const authenticatedStudioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!authenticatedStudioOwnerId || authenticatedStudioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only charge cards for students in your own studio");
    }

    // Get student and their Stripe customer ID
    const student = await studentsService.getStudentById(studentId, studioOwnerId);
    if (!student || !student.authUid) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    const authService = require("./services/auth.service");
    const profileDoc = await authService.getStudentProfileByAuthUid(student.authUid);
    const stripeCustomerId = profileDoc ? profileDoc.data().stripeCustomerId : null;
    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Student does not have a saved payment method. Please ask them to add one from their dashboard.");
    }

    // Verify the payment method belongs to this student
    const savedMethods = await stripeService.listPaymentMethods(stripeCustomerId);
    if (!savedMethods.some((pm) => pm.id === paymentMethodId)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this student");
    }

    // Get package details for the charge amount
    const packageData = await packagesService.getPackageById(packageId, studioOwnerId);
    if (!packageData || !packageData.isActive) {
      return sendErrorResponse(req, res, 404, "Not Found", "Package not found or not active");
    }

    // Optional Stripe Connect destination
    const db = getFirestore();
    const studioOwnerDoc = await db.collection("users").doc(studioOwnerId).get();
    const connectedAccountId = studioOwnerDoc.exists ? (studioOwnerDoc.data().stripeAccountId || null) : null;

    const paymentIntent = await stripeService.chargePaymentMethodDirectly(
        stripeCustomerId,
        paymentMethodId,
        Math.round(packageData.price * 100),
        {purchaseType: "package", itemId: packageId, studioOwnerId, studentId, chargedBy: "studio_owner"},
        connectedAccountId,
    );

    if (paymentIntent.status === "requires_action") {
      return sendErrorResponse(req, res, 402, "Authentication Required", "This card requires additional authentication. Please ask the student to update their payment method from their dashboard.");
    }

    if (paymentIntent.status !== "succeeded") {
      return sendErrorResponse(req, res, 402, "Payment Failed", "The card charge failed. Please try a different payment method.");
    }

    // Grant credits via the existing service
    const result = await packagePurchaseService.purchasePackageForStudent(packageId, studentId, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Card charged and package credited successfully",
      paymentMethod: "card",
      ...result,
    });
  } catch (error) {
    console.error("Error charging student card:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /cash-for-student
 * Studio owner records a cash payment and grants package credits
 * Body: { packageId, studentId, studioOwnerId }
 */
app.post("/cash-for-student", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {packageId, studentId, studioOwnerId} = req.body;
    if (!packageId || !studentId || !studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "packageId, studentId, and studioOwnerId are required");
    }

    const authenticatedStudioOwnerId = await packagesService.getStudioOwnerId(user.uid);
    if (!authenticatedStudioOwnerId || authenticatedStudioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You can only record payments for students in your own studio");
    }

    const result = await packagePurchaseService.purchasePackageForStudent(packageId, studentId, studioOwnerId);

    sendJsonResponse(req, res, 200, {
      message: "Cash payment recorded and package credited successfully",
      paymentMethod: "cash",
      ...result,
    });
  } catch (error) {
    console.error("Error recording cash payment:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.packagePurchases = functions.https.onRequest(app);

