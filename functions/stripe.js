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
  corsOptions,
  isAllowedOrigin,
} = require("./utils/http");

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

// Initialize Express app
const app = express();

// CORS — only reflect origin if it is in the allowlist
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization");
  next();
});

app.use(cors(corsOptions));
// Middleware setup
// Note: Firebase Functions pre-parses req.body; for webhooks we use req.rawBody for signature verification
app.use(express.json());
app.use(express.urlencoded({extended: true}));


/**
 * GET /products
 * Fetch all products and prices from Stripe
 * Public endpoint (no auth required for product listing)
 */
/**
 * GET /config/publishable-key
 * Public endpoint — returns the Stripe publishable key.
 * No auth required; publishable keys are safe to expose to the browser.
 */
app.get("/config/publishable-key", async (req, res) => {
  try {
    const publishableKey = await stripeService.getStripePublishableKey();
    sendJsonResponse(req, res, 200, {publishableKey});
  } catch (error) {
    handleError(req, res, error);
  }
});


app.get("/products", async (req, res) => {
  try {
    console.log("[GET /products] Endpoint called");
    const products = await stripeService.getProducts();
    console.log(`[GET /products] Returning ${products.length} products`);
    sendJsonResponse(req, res, 200, {products});
  } catch (error) {
    console.error("[GET /products] Error:", error);
    handleError(req, res, error);
  }
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
 * POST /account-session
 * Create a Stripe Connect Account Session for embedded components
 */
app.post("/account-session", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User profile not found");
    }

    const userData = userQuery.docs[0].data();

    if (!userData.stripeAccountId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Stripe account not set up. Please complete your Stripe setup first.");
    }

    const accountSession = await stripeService.createAccountSession(userData.stripeAccountId);

    sendJsonResponse(req, res, 200, {
      clientSecret: accountSession.client_secret,
    });
  } catch (error) {
    console.error("Create account session error:", error);
    handleError(req, res, error);
  }
});


/**
 * POST /create-checkout-session
 * Create a Stripe Checkout Session for subscription
 */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const {membership, priceId, email} = req.body;

    if (!membership || !priceId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Membership and priceId are required");
    }

    let userEmail = email;
    let userId = null;
    let authUid = null;

    // Try to get authenticated user (for existing users)
    let user;
    try {
      user = await verifyToken(req);
      authUid = user.uid;
      console.log("[create-checkout-session] Authenticated request from user:", authUid);
    } catch (error) {
      // Not authenticated - this is OK during sign-up
      console.log("[create-checkout-session] Unauthenticated request (sign-up flow)");
    }

    // Get user email - from request body (sign-up) or from authenticated user
    if (!userEmail) {
      if (user && authUid) {
        // Get user document for authenticated user
        const db = getFirestore();
        const userQuery = await db.collection("users")
            .where("authUid", "==", authUid)
            .limit(1)
            .get();

        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userData = userDoc.data();
          userEmail = userData.email;
          userId = userDoc.id;
        }
      }

      if (!userEmail) {
        return sendErrorResponse(req, res, 400, "Validation Error", "Email is required");
      }
    } else {
      // Email provided in request - find user by email (for sign-up flow)
      const db = getFirestore();
      const userQuery = await db.collection("users")
          .where("email", "==", userEmail.toLowerCase())
          .limit(1)
          .get();

      if (!userQuery.empty) {
        const userDoc = userQuery.docs[0];
        userId = userDoc.id;
        const userData = userDoc.data();
        authUid = userData.authUid;
      }
    }

    // Create or retrieve Stripe customer
    const customer = await stripeService.createCustomer(userEmail, {
      userId: userId || null,
      authUid: authUid || null,
      membership,
    });

    // Store customer ID if user document exists
    if (userId) {
      const db = getFirestore();
      const userRef = db.collection("users").doc(userId);
      const userDoc = await userRef.get();
      
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (!userData.stripeCustomerId) {
          await userRef.update({
            stripeCustomerId: customer.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }

    // Create an incomplete subscription and return its PaymentIntent client_secret.
    // This avoids Checkout Sessions whose client_secret format (cs_xxx) is rejected
    // by Stripe.js validation when the secret contains base64 '/' characters.
    const { subscriptionId, paymentIntentId, clientSecret } =
      await stripeService.createSubscriptionCheckout(
          customer.id,
          priceId,
          userId || null,
          membership,
      );

    // Store subscription ID on the user document so the success handler can find it
    if (userId) {
      const db = getFirestore();
      await db.collection("users").doc(userId).update({
        pendingSubscriptionId: subscriptionId,
        pendingPaymentIntentId: paymentIntentId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    sendJsonResponse(req, res, 200, {
      subscriptionId,
      paymentIntentId,
      clientSecret,
    });
  } catch (error) {
    console.error("Create checkout session error:", error);
    handleError(req, res, error);
  }
});


/**
 * POST /create-payment-link
 * Create a Payment Link for subscription checkout (no-code solution)
 * No authentication required (for sign-up flow)
 */
app.post("/create-payment-link", async (req, res) => {
  try {
    const {membership, priceId, email} = req.body;

    if (!membership || !priceId || !email) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Membership, priceId, and email are required");
    }

    let userId = null;
    let authUid = null;

    // Try to find user by email
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("email", "==", email.toLowerCase())
        .limit(1)
        .get();

    if (!userQuery.empty) {
      const userDoc = userQuery.docs[0];
      userId = userDoc.id;
      const userData = userDoc.data();
      authUid = userData.authUid;
    }

    // Get origin for success/cancel URLs
    const origin = req.headers.origin || req.headers.referer?.split("/").slice(0, 3).join("/") || process.env.FRONTEND_URL || "https://studioowners.danceup.com";
    // Payment Links redirect to login page after completion
    // Webhook will handle account setup and subscription activation
    const successUrl = `${origin}/login?payment=success`;
    const cancelUrl = `${origin}/login?payment=canceled`;

    // Create metadata for Payment Link
    const metadata = {
      userId: userId || "",
      authUid: authUid || "",
      membership,
      email: email.toLowerCase(),
    };

    // Create Payment Link
    const paymentLink = await stripeService.createPaymentLink(
        priceId,
        email,
        metadata,
        successUrl,
        cancelUrl,
    );

    sendJsonResponse(req, res, 200, {
      url: paymentLink.url,
      id: paymentLink.id,
    });
  } catch (error) {
    console.error("Create Payment Link error:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /subscription
 * Return the authenticated studio owner's current platform subscription details.
 */
app.get("/subscription", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userQuery.docs[0].data();
    if (!userData.stripeSubscriptionId) {
      return sendJsonResponse(req, res, 200, null);
    }

    const stripe = await stripeService.getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(userData.stripeSubscriptionId, {
      expand: ["items.data.price.product"],
    });

    const item = subscription.items.data[0];
    const price = item?.price;
    const product = price?.product;

    sendJsonResponse(req, res, 200, {
      id: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      pausedUntil: subscription.pause_collection?.resumes_at ?? null,
      currentPeriodEnd: subscription.current_period_end,
      planName: typeof product === "object" ? (product.name ?? "Platform Subscription") : "Platform Subscription",
      amount: price?.unit_amount ?? 0,
      currency: price?.currency ?? "usd",
      interval: price?.recurring?.interval ?? "month",
    });
  } catch (error) {
    handleError(req, res, error);
  }
});

/**
 * POST /subscription/pause
 * Pause the studio owner's subscription collection until a given date (or indefinitely).
 * Body: { resumeAt?: unix_timestamp }
 */
app.post("/subscription/pause", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) return sendErrorResponse(req, res, 404, "Not Found", "User not found");

    const userData = userQuery.docs[0].data();
    if (!userData.stripeSubscriptionId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient();
    const pauseCollection = { behavior: "mark_uncollectible" };
    if (req.body.resumeAt) pauseCollection.resumes_at = req.body.resumeAt;

    const updated = await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      pause_collection: pauseCollection,
    });

    sendJsonResponse(req, res, 200, {
      status: updated.status,
      pausedUntil: updated.pause_collection?.resumes_at ?? null,
    });
  } catch (error) {
    handleError(req, res, error);
  }
});

/**
 * POST /subscription/resume
 * Resume a paused subscription immediately.
 */
app.post("/subscription/resume", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) return sendErrorResponse(req, res, 404, "Not Found", "User not found");

    const userData = userQuery.docs[0].data();
    if (!userData.stripeSubscriptionId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient();
    const updated = await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      pause_collection: "",
    });

    sendJsonResponse(req, res, 200, { status: updated.status, pausedUntil: null });
  } catch (error) {
    handleError(req, res, error);
  }
});

/**
 * POST /subscription/cancel
 * Schedule the subscription to cancel at the end of the current billing period.
 */
app.post("/subscription/cancel", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) return sendErrorResponse(req, res, 404, "Not Found", "User not found");

    const userData = userQuery.docs[0].data();
    if (!userData.stripeSubscriptionId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient();
    const updated = await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    sendJsonResponse(req, res, 200, {
      cancelAtPeriodEnd: updated.cancel_at_period_end,
      currentPeriodEnd: updated.current_period_end,
    });
  } catch (error) {
    handleError(req, res, error);
  }
});

/**
 * POST /subscription/reactivate
 * Undo a scheduled cancellation — keeps the subscription active past the period end.
 */
app.post("/subscription/reactivate", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) return sendErrorResponse(req, res, 404, "Not Found", "User not found");

    const userData = userQuery.docs[0].data();
    if (!userData.stripeSubscriptionId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient();
    const updated = await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    sendJsonResponse(req, res, 200, { cancelAtPeriodEnd: updated.cancel_at_period_end });
  } catch (error) {
    handleError(req, res, error);
  }
});

/**
 * POST /payment-methods/setup
 * Create a SetupIntent so the studio owner can save a card without charging it.
 * Returns clientSecret for Stripe Elements confirmCardSetup().
 */
app.post("/payment-methods/setup", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    // Ensure the studio owner has a Stripe customer record
    let customerId = userData.stripeCustomerId;
    if (!customerId) {
      const customer = await stripeService.createCustomer(userData.email, {
        userId: userDoc.id,
        authUid: user.uid,
      });
      customerId = customer.id;
      await userDoc.ref.update({
        stripeCustomerId: customerId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const setupIntent = await stripeService.createSetupIntent(customerId);
    sendJsonResponse(req, res, 200, {clientSecret: setupIntent.client_secret});
  } catch (error) {
    handleError(req, res, error);
  }
});


/**
 * GET /payment-methods
 * List saved payment methods for the authenticated studio owner.
 */
app.get("/payment-methods", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userQuery.docs[0].data();
    if (!userData.stripeCustomerId) {
      return sendJsonResponse(req, res, 200, []);
    }

    const stripe = await stripeService.getStripeClient();
    const [methods, customer] = await Promise.all([
      stripeService.listPaymentMethods(userData.stripeCustomerId),
      stripe.customers.retrieve(userData.stripeCustomerId),
    ]);

    const defaultPmId = customer.invoice_settings?.default_payment_method ?? null;

    const result = methods.map((pm) => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
      isDefault: pm.id === defaultPmId,
    }));
    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    handleError(req, res, error);
  }
});


/**
 * DELETE /payment-methods/:id
 * Detach (remove) a saved payment method from the studio owner's Stripe customer.
 */
app.delete("/payment-methods/:id", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const {id} = req.params;

    // Verify the payment method belongs to this customer before detaching
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    await stripeService.detachPaymentMethod(id);
    sendJsonResponse(req, res, 200, {success: true});
  } catch (error) {
    handleError(req, res, error);
  }
});


/**
 * POST /retry-invoice
 * Manually retry the latest open invoice for the authenticated studio owner's subscription.
 * Called from the "payment required" page after the owner updates their card.
 */
app.post("/retry-invoice", async (req, res) => {
  try {
    const user = await verifyToken(req);

    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    if (!userData.stripeSubscriptionId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient();

    // Retrieve the subscription to find the latest invoice
    const subscription = await stripe.subscriptions.retrieve(userData.stripeSubscriptionId);

    if (!subscription.latest_invoice) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No invoice found for this subscription");
    }

    const invoiceId = typeof subscription.latest_invoice === "string"
      ? subscription.latest_invoice
      : subscription.latest_invoice.id;

    const invoice = await stripe.invoices.retrieve(invoiceId);

    // Only retry open/uncollectible invoices — not already paid ones
    if (invoice.status === "paid") {
      return sendJsonResponse(req, res, 200, { alreadyPaid: true, message: "Invoice is already paid" });
    }

    const paidInvoice = await stripe.invoices.pay(invoiceId);

    // If payment succeeded immediately, restore access in Firestore
    if (paidInvoice.status === "paid") {
      await userDoc.ref.update({
        stripeSubscriptionStatus: "active",
        subscriptionActive: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    sendJsonResponse(req, res, 200, {
      status: paidInvoice.status,
      subscriptionActive: paidInvoice.status === "paid",
    });
  } catch (error) {
    // Stripe throws a card_error or invoice_payment_intent_requires_action when the card fails
    const stripeError = error?.raw || error;
    if (stripeError?.type === "card_error" || stripeError?.code === "card_declined") {
      return sendErrorResponse(req, res, 402, "Payment Failed", stripeError.message || "Card was declined. Please update your payment method.");
    }
    console.error("retry-invoice error:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /payment-methods/:id/default
 * Set a payment method as the default for the studio owner's subscription invoices.
 */
app.post("/payment-methods/:id/default", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const {id} = req.params;

    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userQuery.docs[0].data();
    if (!userData.stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer found");
    }

    // Verify the PM belongs to this customer before setting as default
    const methods = await stripeService.listPaymentMethods(userData.stripeCustomerId);
    if (!methods.some((pm) => pm.id === id)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    await stripeService.setDefaultPaymentMethod(userData.stripeCustomerId, id);
    sendJsonResponse(req, res, 200, {success: true, defaultPaymentMethodId: id});
  } catch (error) {
    handleError(req, res, error);
  }
});

/**
 * PUT /payment-methods/:id
 * Update the expiry date on a saved payment method for the studio owner.
 */
app.put("/payment-methods/:id", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const {id} = req.params;
    const {expMonth, expYear} = req.body;

    if (!expMonth || !expYear) {
      return sendErrorResponse(req, res, 400, "Validation Error", "expMonth and expYear are required");
    }

    const month = parseInt(expMonth, 10);
    const year = parseInt(expYear, 10);

    if (isNaN(month) || month < 1 || month > 12) {
      return sendErrorResponse(req, res, 400, "Validation Error", "expMonth must be 1–12");
    }
    if (isNaN(year) || year < new Date().getFullYear()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "expYear must be the current year or later");
    }

    // Verify ownership: ensure PM belongs to this customer before updating
    const db = getFirestore();
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const updated = await stripeService.updatePaymentMethod(id, month, year);

    sendJsonResponse(req, res, 200, {
      id: updated.id,
      brand: updated.card.brand,
      last4: updated.card.last4,
      expMonth: updated.card.exp_month,
      expYear: updated.card.exp_year,
    });
  } catch (error) {
    handleError(req, res, error);
  }
});

/**
 * POST /subscription-payment-success
 * Handle successful subscription payment via PaymentElement.
 * Called on the return leg after Stripe redirects back with ?payment_intent=pi_xxx.
 * Verifies the PaymentIntent succeeded, activates the user's subscription in Firestore,
 * creates a Stripe Connect account if not already present, and returns a Firebase custom
 * token so the frontend can sign in automatically.
 * No authentication required (sign-up flow).
 */
app.post("/subscription-payment-success", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "paymentIntentId is required");
    }

    const stripe = (await stripeService.getStripeClient());
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["invoice.subscription"],
    });

    if (pi.status !== "succeeded") {
      return sendErrorResponse(req, res, 400, "Validation Error", `Payment not completed (status: ${pi.status})`);
    }

    const subscription = pi.invoice?.subscription;
    if (!subscription) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Could not resolve subscription from payment intent");
    }

    const userId = subscription.metadata?.userId;
    const membership = subscription.metadata?.membership;

    if (!userId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "User ID not found in subscription metadata");
    }

    const db = getFirestore();
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userDoc.data();

    const updateData = {
      stripeCustomerId: pi.customer,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: "active",
      membership: membership || userData.membership,
      pendingSubscriptionId: admin.firestore.FieldValue.delete(),
      pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!userData.stripeAccountId) {
      const account = await stripeService.createConnectedAccount(userData.email, {
        userId: userDoc.id,
        authUid: userData.authUid,
        membership: membership || userData.membership,
      });
      updateData.stripeAccountId = account.id;
      updateData.stripeAccountStatus = "pending";
    }

    await userDoc.ref.update(updateData);

    const customToken = await admin.auth().createCustomToken(userData.authUid);

    sendJsonResponse(req, res, 200, {
      message: "Subscription activated successfully",
      customToken,
      userId: userData.authUid,
      membership: membership || userData.membership,
    });
  } catch (error) {
    console.error("Subscription payment success error:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /checkout-success
 * Handle successful checkout and create Stripe Connect account
 * Works with both regular Checkout Sessions and Payment Link sessions
 * Returns Firebase custom token for auto-login
 * No authentication required (for sign-up flow)
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

    // Get user document - Payment Links store metadata in session.metadata
    const db = getFirestore();
    let userId = session.metadata?.userId;
    
    // If userId is empty string from Payment Link, try to find by email
    if (!userId || userId === "") {
      const email = session.metadata?.email;
      if (email) {
        const userQuery = await db.collection("users")
            .where("email", "==", email.toLowerCase())
            .limit(1)
            .get();
        
        if (!userQuery.empty) {
          userId = userQuery.docs[0].id;
        }
      }
    }
    
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
app.post("/webhook", async (req, res) => {
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

    // Verify webhook signature using rawBody (Firebase Functions pre-parses req.body)
    const event = await stripeService.verifyWebhookSignature(
        req.rawBody,
        sig,
        webhookSecret.trim(),
    );

    const db = getFirestore();

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const purchaseType = session.metadata?.purchaseType;
        const sendgridService = require("./services/sendgrid.service");

        // --- Platform membership upgrade (no purchaseType set) ---
        if (!purchaseType) {
          let userId = session.metadata?.userId;
          if (!userId || userId === "") {
            const email = session.metadata?.email || session.customer_email;
            if (email) {
              const userQuery = await db.collection("users")
                  .where("email", "==", email.toLowerCase())
                  .limit(1)
                  .get();
              if (!userQuery.empty) userId = userQuery.docs[0].id;
            }
          }
          if (userId) {
            const userDoc = await db.collection("users").doc(userId).get();
            if (userDoc.exists) {
              const userData = userDoc.data();
              const updateData = {
                stripeCustomerId: session.customer,
                stripeSubscriptionId: session.subscription,
                stripeSubscriptionStatus: "active",
                membership: session.metadata?.membership || userData.membership,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              };

              // Create Connect account if not already exists (fallback in case
              // the /checkout-success HTTP call never fired)
              if (!userData.stripeAccountId) {
                try {
                  const account = await stripeService.createConnectedAccount(
                      userData.email,
                      {userId, authUid: userData.authUid, membership: updateData.membership},
                  );
                  updateData.stripeAccountId = account.id;
                  updateData.stripeAccountStatus = "pending";
                  console.log(`[webhook] Created Connect account ${account.id} for user ${userId}`);
                } catch (connectErr) {
                  console.error("[webhook] Failed to create Connect account:", connectErr);
                }
              }

              await userDoc.ref.update(updateData);
            }
          }
          break;
        }

        // --- App purchase: private_lesson ---
        if (purchaseType === "private_lesson") {
          try {
            const bookingsService = require("./services/bookings.service");
            await bookingsService.createConfirmedBookingFromSession(session);

            const recipientEmail = session.customer_details?.email || session.metadata?.contactEmail;
            if (recipientEmail) {
              const meta = session.metadata;
              await sendgridService.sendConfirmationEmail(recipientEmail, "private_lesson", {
                instructorName: meta.instructorName,
                studioName: meta.studioName,
                date: meta.date,
                timeSlot: `${meta.timeSlotStart} – ${meta.timeSlotEnd}`,
                amountPaid: meta.amountPaid,
              });
            }

            // Notify studio owner
            const notificationsService = require("./services/notifications.service");
            await notificationsService.createNotification(
                session.metadata.studioId,
                null,
                "private_lesson_booking",
                "New Private Lesson Booked & Paid",
                `A private lesson with ${session.metadata.instructorName} on ${session.metadata.date} was paid and confirmed.`,
            );
          } catch (err) {
            console.error("[webhook] Error handling private_lesson checkout:", err);
          }
          break;
        }

        // --- App purchase: class / event / workshop / package (send confirmation email) ---
        try {
          const recipientEmail = session.customer_details?.email;
          if (recipientEmail) {
            const meta = session.metadata;
            const amountCents = session.amount_total || 0;
            const amountPaid = (amountCents / 100).toFixed(2);

            await sendgridService.sendConfirmationEmail(recipientEmail, purchaseType, {
              itemName: meta.itemName || purchaseType,
              studioName: meta.studioName || "the studio",
              amountPaid,
            });
          }
        } catch (err) {
          console.error("[webhook] Error sending purchase confirmation email:", err);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;

        if (userId) {
          const userDoc = await db.collection("users").doc(userId).get();
          if (userDoc.exists) {
            const activeStatuses = ["active", "trialing"];
            await userDoc.ref.update({
              stripeSubscriptionStatus: subscription.status,
              subscriptionActive: activeStatuses.includes(subscription.status),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`[webhook] subscription.updated userId=${userId} status=${subscription.status}`);
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
              subscriptionActive: false,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`[webhook] subscription.deleted userId=${userId}`);
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        // Stripe's Smart Retries will keep retrying automatically.
        // We mark the studio as inactive so:
        //   (a) the dashboard guard redirects to the payment-required page
        //   (b) the studio's content is hidden from the users-app
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break;

        try {
          const stripe = await stripeService.getStripeClient();
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = subscription.metadata?.userId;

          if (userId) {
            const userDoc = await db.collection("users").doc(userId).get();
            if (userDoc.exists) {
              await userDoc.ref.update({
                stripeSubscriptionStatus: subscription.status, // e.g. "past_due"
                subscriptionActive: false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log(`[webhook] invoice.payment_failed userId=${userId} sub=${subscriptionId} status=${subscription.status}`);
            }
          }
        } catch (err) {
          console.error("[webhook] Error handling invoice.payment_failed:", err);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;

        if (!subscriptionId) {
          // Not a subscription invoice, skip
          break;
        }

        // Get subscription to extract metadata
        const stripe = await stripeService.getStripeClient();
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        // Check if this is a package subscription
        const purchaseType = subscription.metadata?.purchaseType;
        if (purchaseType !== "package") {
          // Could be a platform membership subscription — restore access if previously lapsed
          const userId = subscription.metadata?.userId;
          if (userId) {
            try {
              const userDoc = await db.collection("users").doc(userId).get();
              if (userDoc.exists) {
                await userDoc.ref.update({
                  stripeSubscriptionStatus: "active",
                  subscriptionActive: true,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                console.log(`[webhook] invoice.payment_succeeded (platform) userId=${userId} — access restored`);
              }
            } catch (err) {
              console.error("[webhook] Error restoring platform subscription access:", err);
            }
          }
          break;
        }

        const itemId = subscription.metadata?.itemId;
        const studioOwnerId = subscription.metadata?.studioOwnerId;
        const studentId = subscription.metadata?.studentId;
        const authUid = subscription.metadata?.authUid;

        if (!itemId || !studioOwnerId || !studentId || !authUid) {
          console.error("Missing metadata in subscription for invoice.payment_succeeded:", {
            subscriptionId,
            metadata: subscription.metadata,
          });
          break;
        }

        // Check if this is the first payment (initial purchase) or a renewal
        // First payment is handled by checkout.session.completed, so this is a renewal
        const isFirstPayment = invoice.billing_reason === "subscription_create";
        
        if (isFirstPayment) {
          // Initial payment already handled by checkout.session.completed
          break;
        }

        // This is a renewal - grant credits
        try {
          const purchaseService = require("./services/purchase.service");

          // Get package details
          const itemDetails = await purchaseService.getItemDetails("package", itemId);

          // Resolve student name for notifications and purchase record
          const studentProfileDoc = await require("./services/auth.service").getStudentProfileByAuthUid(authUid);
          let studentName = "Student";
          if (studentProfileDoc) {
            const profileData = studentProfileDoc.data();
            const firstName = profileData.firstName || "";
            const lastName = profileData.lastName || "";
            studentName = `${firstName} ${lastName}`.trim() || "Student";
          }

          // Grant credits for renewal
          const creditResult = await purchaseService.grantCreditsForPurchase(
              "package",
              studentId,
              studioOwnerId,
              itemDetails,
          );

          // Count how many renewals have already occurred for this subscription
          const existingRenewalsSnapshot = await db.collection("purchases")
              .where("stripeSubscriptionId", "==", subscriptionId)
              .where("isRenewal", "==", true)
              .get();
          const renewalNumber = existingRenewalsSnapshot.size + 1;

          // Derive the amount charged from the invoice
          const amountPaid = (invoice.amount_paid || 0) / 100;

          // Create a new purchase record for this renewal charge
          await purchaseService.createPurchaseRecord({
            studentId,
            authUid,
            purchaseType: "package",
            itemId,
            studioOwnerId,
            itemName: itemDetails.itemName,
            studioName: itemDetails.studioName,
            price: amountPaid,
            stripePaymentIntentId: typeof invoice.payment_intent === "string"
              ? invoice.payment_intent
              : (invoice.payment_intent?.id || null),
            stripeCustomerId: typeof invoice.customer === "string"
              ? invoice.customer
              : (invoice.customer?.id || null),
            stripeSubscriptionId: subscriptionId,
            isRecurring: true,
            isRenewal: true,
            renewalNumber,
            subscriptionStatus: subscription.status,
            status: "completed",
            creditGranted: creditResult.creditsGranted > 0,
            creditsGranted: creditResult.creditsGranted,
            creditIds: creditResult.creditIds,
            metadata: {
              packageId: itemId,
              credits: itemDetails.metadata?.credits,
              expirationDays: itemDetails.metadata?.expirationDays,
            },
          });

          // Also update the original purchase record's subscription status
          const originalPurchaseQuery = await db.collection("purchases")
              .where("stripeSubscriptionId", "==", subscriptionId)
              .where("studentId", "==", studentId)
              .where("isRenewal", "==", false)
              .limit(1)
              .get();

          if (!originalPurchaseQuery.empty) {
            await originalPurchaseQuery.docs[0].ref.update({
              subscriptionStatus: subscription.status,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          // Notify studio owner about the renewal charge
          await purchaseService.createPurchaseNotification({
            studioOwnerId,
            studentId,
            studentName,
            purchaseType: "package",
            itemName: `${itemDetails.itemName} (Renewal #${renewalNumber})`,
          });

          console.log("Subscription renewal processed:", {
            subscriptionId,
            studentId,
            renewalNumber,
            creditsGranted: creditResult.creditsGranted,
            amountPaid,
          });
        } catch (error) {
          console.error("Error processing subscription renewal:", error);
          // Don't throw - webhook should still return 200
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

