const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const {verifyToken} = require("./utils/auth");
const {getFirestore} = require("./utils/firestore");
const stripeService = require("./services/stripe.service");
const {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
} = require("./utils/http");

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

// Initialize Express app
const app = express();

// Handle OPTIONS preflight requests FIRST
app.options("*", (req, res) => {
  const origin = req.headers.origin || "*";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");

  return res.status(204).send();
});

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");

  next();
});

app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
  exposedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));
// Middleware setup
// Note: Webhook endpoint needs raw body, so we'll handle it separately
app.use(express.json());
app.use(express.urlencoded({extended: true}));

/**
 * OPTIONS /products
 * Handle CORS preflight
 */
app.options("/products", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * GET /products
 * Fetch all products and prices from Stripe
 * Public endpoint (no auth required for product listing)
 */
app.get("/products", async (req, res) => {
  try {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.js:/products:entry',message:'GET /products endpoint called',data:{timestamp:Date.now()},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,B,C,D'})}).catch(()=>{});
    // #endregion
    const products = await stripeService.getProducts();
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.js:/products:before-response',message:'Products retrieved, sending response',data:{productsCount:products.length,products:products},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,B,C,D'})}).catch(()=>{});
    // #endregion
    sendJsonResponse(req, res, 200, {products});
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.js:/products:error',message:'Error in /products endpoint',data:{errorMessage:error.message,errorStack:error.stack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    console.error("Get products error:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /create-account
 * Handle CORS preflight
 */
app.options("/create-account", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * POST /create-account
 * Create Stripe Connect account and return account link
 */
app.post("/create-account", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    // Get user document to retrieve email and membership
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    if (!userData.email) {
      return sendErrorResponse(req, res, 400, "Validation Error", "User email not found");
    }

    // Check if user already has a Stripe account
    if (userData.stripeAccountId) {
      // Get existing account link
      const origin = req.headers.origin || req.headers.referer?.split("/").slice(0, 3).join("/") || process.env.FRONTEND_URL || "https://studioowners.danceup.com";
      const returnUrl = `${origin}/register/stripe-callback?account_id=${userData.stripeAccountId}`;
      const refreshUrl = `${origin}/register/stripe-setup`;

      const accountLink = await stripeService.createAccountLink(
          userData.stripeAccountId,
          returnUrl,
          refreshUrl,
      );

      return sendJsonResponse(req, res, 200, {
        accountLinkUrl: accountLink.url,
        accountId: userData.stripeAccountId,
      });
    }

    // Create new Stripe Connect account
    const account = await stripeService.createConnectedAccount(
        userData.email,
        {
          userId: userDoc.id,
          authUid: user.uid,
          membership: userData.membership || "studio_owner",
        },
    );

    // Store account ID in user document
    await userDoc.ref.update({
      stripeAccountId: account.id,
      stripeAccountStatus: "pending",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Create account link for onboarding
    // Get origin from request headers or use environment variable
    const origin = req.headers.origin || req.headers.referer?.split("/").slice(0, 3).join("/") || process.env.FRONTEND_URL || "https://studioowners.danceup.com";
    const returnUrl = `${origin}/register/stripe-callback?account_id=${account.id}`;
    const refreshUrl = `${origin}/register/stripe-setup`;

    const accountLink = await stripeService.createAccountLink(
        account.id,
        returnUrl,
        refreshUrl,
    );

    sendJsonResponse(req, res, 200, {
      accountLinkUrl: accountLink.url,
      accountId: account.id,
    });
  } catch (error) {
    console.error("Create Stripe account error:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /account/:accountId
 * Handle CORS preflight
 */
app.options("/account/:accountId", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * GET /account/:accountId
 * Get Stripe account status
 */
app.get("/account/:accountId", async (req, res) => {
  try {
    // Verify token
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const {accountId} = req.params;

    // Verify the account belongs to the user
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .where("stripeAccountId", "==", accountId)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Account not found");
    }

    // Get account from Stripe
    const account = await stripeService.getAccount(accountId);

    sendJsonResponse(req, res, 200, {
      accountId: account.id,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      email: account.email,
    });
  } catch (error) {
    console.error("Get Stripe account error:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /complete-setup
 * Handle CORS preflight
 */
app.options("/complete-setup", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * GET /complete-setup
 * Handle OAuth callback via GET (public endpoint, no auth required)
 * This is called when Stripe redirects back after onboarding
 */
app.get("/complete-setup", async (req, res) => {
  try {
    const {account_id} = req.query;

    if (!account_id) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Account ID is required");
    }

    // Find user by Stripe account ID (no auth required for this callback)
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("stripeAccountId", "==", account_id)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Account not found");
    }

    const userDoc = userQuery.docs[0];

    // Get account status from Stripe
    const account = await stripeService.getAccount(account_id);

    // Update user document
    const updateData = {
      stripeAccountStatus: account.charges_enabled && account.payouts_enabled ? "active" : "pending",
      stripeSetupCompleted: account.details_submitted,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (account.details_submitted) {
      updateData.stripeSetupCompletedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await userDoc.ref.update(updateData);

    // Return success - frontend will handle redirect
    sendJsonResponse(req, res, 200, {
      message: "Stripe setup completed successfully",
      accountId: account.id,
      status: updateData.stripeAccountStatus,
      detailsSubmitted: account.details_submitted,
    });
  } catch (error) {
    console.error("Complete Stripe setup error:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /complete-setup
 * Handle OAuth callback and update user document (authenticated version)
 */
app.post("/complete-setup", async (req, res) => {
  try {
    // Verify token
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const {accountId} = req.body;

    if (!accountId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Account ID is required");
    }

    // Verify the account belongs to the user
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .where("stripeAccountId", "==", accountId)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Account not found for this user");
    }

    const userDoc = userQuery.docs[0];

    // Get account status from Stripe
    const account = await stripeService.getAccount(accountId);

    // Update user document
    const updateData = {
      stripeAccountStatus: account.charges_enabled && account.payouts_enabled ? "active" : "pending",
      stripeSetupCompleted: account.details_submitted,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (account.details_submitted) {
      updateData.stripeSetupCompletedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await userDoc.ref.update(updateData);

    sendJsonResponse(req, res, 200, {
      message: "Stripe setup completed successfully",
      accountId: account.id,
      status: updateData.stripeAccountStatus,
      detailsSubmitted: account.details_submitted,
    });
  } catch (error) {
    console.error("Complete Stripe setup error:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /login-link
 * Handle CORS preflight
 */
app.options("/login-link", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * POST /login-link
 * Create a Stripe Express dashboard login link
 */
app.post("/login-link", async (req, res) => {
  try {
    // Verify token
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    // Get user document
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    if (!userData.stripeAccountId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Stripe account not set up. Please complete your Stripe setup first.");
    }

    // Create login link
    const loginLink = await stripeService.createLoginLink(userData.stripeAccountId);

    sendJsonResponse(req, res, 200, {
      url: loginLink.url,
    });
  } catch (error) {
    console.error("Create login link error:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /create-checkout-session
 * Handle CORS preflight
 */
app.options("/create-checkout-session", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * POST /create-checkout-session
 * Create a Stripe Checkout Session for subscription
 */
app.post("/create-checkout-session", async (req, res) => {
  try {
    // Verify token
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const {membership, priceId} = req.body;

    if (!membership || !priceId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Membership and priceId are required");
    }

    // Get user document
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    if (!userData.email) {
      return sendErrorResponse(req, res, 400, "Validation Error", "User email not found");
    }

    // Create or retrieve Stripe customer
    const customer = await stripeService.createCustomer(userData.email, {
      userId: userDoc.id,
      authUid: user.uid,
      membership,
    });

    // Store customer ID if not already stored
    if (!userData.stripeCustomerId) {
      await userDoc.ref.update({
        stripeCustomerId: customer.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Get origin for success/cancel URLs
    const origin = req.headers.origin || req.headers.referer?.split("/").slice(0, 3).join("/") || process.env.FRONTEND_URL || "https://studioowners.danceup.com";
    const successUrl = `${origin}/register/checkout-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/register/checkout?canceled=true`;

    // Create checkout session
    const session = await stripeService.createCheckoutSession(
        customer.id,
        priceId,
        userDoc.id,
        membership,
        successUrl,
        cancelUrl,
    );

    // Store checkout session ID temporarily
    await userDoc.ref.update({
      checkoutSessionId: session.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {
      sessionId: session.id,
      clientSecret: session.client_secret,
      url: session.url,
    });
  } catch (error) {
    console.error("Create checkout session error:", error);
    handleError(req, res, error);
  }
});

/**
 * OPTIONS /checkout-success
 * Handle CORS preflight
 */
app.options("/checkout-success", (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

/**
 * POST /checkout-success
 * Handle successful checkout and create Stripe Connect account
 * Returns Firebase custom token for auto-login
 */
app.post("/checkout-success", async (req, res) => {
  try {
    const {sessionId} = req.body;

    if (!sessionId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Session ID is required");
    }

    // Retrieve checkout session from Stripe
    const session = await stripeService.getCheckoutSession(sessionId);

    if (session.payment_status !== "paid") {
      return sendErrorResponse(req, res, 400, "Validation Error", "Payment not completed");
    }

    // Get user document
    const db = getFirestore();
    const userId = session.metadata?.userId;
    if (!userId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "User ID not found in session metadata");
    }

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userDoc.data();
    const membership = session.metadata?.membership || userData.membership;

    // Update user with subscription info
    const updateData = {
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription,
      stripeSubscriptionStatus: "active",
      membership,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Create Stripe Connect account if not already exists
    if (!userData.stripeAccountId) {
      const account = await stripeService.createConnectedAccount(
          userData.email,
          {
            userId: userDoc.id,
            authUid: userData.authUid,
            membership,
          },
      );

      updateData.stripeAccountId = account.id;
      updateData.stripeAccountStatus = "pending";
    }

    await userDoc.ref.update(updateData);

    // Create Firebase custom token for auto-login
    const customToken = await admin.auth().createCustomToken(userData.authUid);

    sendJsonResponse(req, res, 200, {
      message: "Checkout completed successfully",
      customToken,
      userId: userData.authUid,
      membership,
    });
  } catch (error) {
    console.error("Checkout success error:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /webhook
 * Handle Stripe webhooks
 * This endpoint should be configured in Stripe dashboard
 * Note: This endpoint uses raw body parsing for signature verification
 */
app.post("/webhook", express.raw({type: "application/json"}), async (req, res) => {
  const sig = req.headers["stripe-signature"];

  if (!sig) {
    return sendErrorResponse(req, res, 400, "Validation Error", "Missing stripe-signature header");
  }

  try {
    // Get webhook secret from Secret Manager
    const {getSecret} = require("./utils/secret-manager");
    const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
    const isProduction = projectId.includes("production");
    const secretName = isProduction
      ? "stripe-webhook-secret-prod"
      : "stripe-webhook-secret-test";

    let webhookSecret;
    try {
      webhookSecret = await getSecret(secretName);
    } catch (error) {
      console.warn(`Webhook secret not found: ${secretName}. Using default.`);
      // Fallback to environment variable if secret not found
      webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    }

    if (!webhookSecret) {
      console.error("Webhook secret not configured");
      return sendErrorResponse(req, res, 500, "Configuration Error", "Webhook secret not configured");
    }

    // Verify webhook signature
    const event = await stripeService.verifyWebhookSignature(
        req.body,
        sig,
        webhookSecret.trim(),
    );

    const db = getFirestore();

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.metadata?.userId;

        if (userId) {
          const userDoc = await db.collection("users").doc(userId).get();
          if (userDoc.exists) {
            await userDoc.ref.update({
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
              stripeSubscriptionStatus: "active",
              membership: session.metadata?.membership || userDoc.data().membership,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;

        if (userId) {
          const userDoc = await db.collection("users").doc(userId).get();
          if (userDoc.exists) {
            await userDoc.ref.update({
              stripeSubscriptionStatus: subscription.status,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;

        if (userId) {
          const userDoc = await db.collection("users").doc(userId).get();
          if (userDoc.exists) {
            await userDoc.ref.update({
              stripeSubscriptionStatus: "canceled",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Return 200 to acknowledge receipt
    res.status(200).json({received: true});
  } catch (error) {
    console.error("Webhook error:", error);
    return sendErrorResponse(req, res, 400, "Webhook Error", error.message);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.stripe = functions.https.onRequest(app);

