import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { getSecret } from "../utils/secret-manager";
import * as stripeService from "../services/stripe.service";
import bookingsService from "../services/bookings.service";
import notificationsService from "../services/notifications.service";
import { sendConfirmationEmail } from "../services/sendgrid.service";
import authService from "../services/auth.service";
import purchaseService from "../services/purchase.service";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";

const app = express();

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
app.use(express.json());
applySecurityMiddleware(app);
app.use(express.urlencoded({ extended: true }));

// GET /config/publishable-key
app.get("/config/publishable-key", async (req, res) => {
  try {
    const publishableKey = await stripeService.getStripePublishableKey();
    sendJsonResponse(req, res, 200, { publishableKey });
  } catch (error) {
    handleError(req, res, error);
  }
});

// GET /products
app.get("/products", async (req, res) => {
  try {
    console.log("[GET /products] Endpoint called");
    const products = await stripeService.getProducts() as unknown[];
    console.log(`[GET /products] Returning ${products.length} products`);
    sendJsonResponse(req, res, 200, { products });
  } catch (error) {
    console.error("[GET /products] Error:", error);
    handleError(req, res, error);
  }
});

// POST /create-account
app.post("/create-account", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (error) {
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

    const userDoc = userQuery.docs[0]!;
    const userData = userDoc.data() as Record<string, unknown>;

    if (!userData["email"]) {
      return sendErrorResponse(req, res, 400, "Validation Error", "User email not found");
    }

    if (userData["stripeAccountId"]) {
      const origin = (req.headers.origin as string | undefined) ||
        (req.headers.referer as string | undefined)?.split("/").slice(0, 3).join("/") ||
        process.env["FRONTEND_URL"] ||
        "https://studioowners.danceup.com";
      const returnUrl = `${origin}/register/stripe-callback?account_id=${userData["stripeAccountId"]}`;
      const refreshUrl = `${origin}/register/stripe-setup`;

      const accountLink = await stripeService.createAccountLink(
        userData["stripeAccountId"] as string, returnUrl, refreshUrl,
      ) as { url: string };

      return sendJsonResponse(req, res, 200, {
        accountLinkUrl: accountLink.url,
        accountId: userData["stripeAccountId"],
      });
    }

    const account = await stripeService.createConnectedAccount(
      userData["email"] as string,
      {
        userId: userDoc.id,
        authUid: user.uid,
        membership: (userData["membership"] as string) || "studio_owner",
      },
    ) as { id: string };

    await userDoc.ref.update({
      stripeAccountId: account.id,
      stripeAccountStatus: "pending",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const origin = (req.headers.origin as string | undefined) ||
      (req.headers.referer as string | undefined)?.split("/").slice(0, 3).join("/") ||
      process.env["FRONTEND_URL"] ||
      "https://studioowners.danceup.com";
    const returnUrl = `${origin}/register/stripe-callback?account_id=${account.id}`;
    const refreshUrl = `${origin}/register/stripe-setup`;

    const accountLink = await stripeService.createAccountLink(account.id, returnUrl, refreshUrl) as { url: string };

    sendJsonResponse(req, res, 200, { accountLinkUrl: accountLink.url, accountId: account.id });
  } catch (error) {
    console.error("Create Stripe account error:", error);
    handleError(req, res, error);
  }
});

// GET /account/:accountId
app.get("/account/:accountId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const accountId = req.params["accountId"] as string;

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .where("stripeAccountId", "==", accountId)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Account not found");
    }

    const account = await stripeService.getAccount(accountId) as unknown as Record<string, unknown>;

    sendJsonResponse(req, res, 200, {
      accountId: account["id"],
      chargesEnabled: account["charges_enabled"],
      payoutsEnabled: account["payouts_enabled"],
      detailsSubmitted: account["details_submitted"],
      email: account["email"],
    });
  } catch (error) {
    console.error("Get Stripe account error:", error);
    handleError(req, res, error);
  }
});

// POST /complete-setup
app.post("/complete-setup", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const body = req.body as Record<string, unknown>;
    const accountId = body["accountId"] as string | undefined;

    if (!accountId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Account ID is required");
    }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .where("stripeAccountId", "==", accountId)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Account not found for this user");
    }

    const userDoc = userQuery.docs[0]!;

    const account = await stripeService.getAccount(accountId) as unknown as Record<string, unknown>;

    const updateData: Record<string, unknown> = {
      stripeAccountStatus: account["charges_enabled"] && account["payouts_enabled"] ? "active" : "pending",
      stripeSetupCompleted: account["details_submitted"],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (account["details_submitted"]) {
      updateData["stripeSetupCompletedAt"] = admin.firestore.FieldValue.serverTimestamp();
    }

    await userDoc.ref.update(updateData);

    sendJsonResponse(req, res, 200, {
      message: "Stripe setup completed successfully",
      accountId: account["id"],
      status: updateData["stripeAccountStatus"],
      detailsSubmitted: account["details_submitted"],
    });
  } catch (error) {
    console.error("Complete Stripe setup error:", error);
    handleError(req, res, error);
  }
});

// POST /login-link
app.post("/login-link", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (error) {
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

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;

    if (!userData["stripeAccountId"]) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Stripe account not set up. Please complete your Stripe setup first.");
    }

    const loginLink = await stripeService.createLoginLink(userData["stripeAccountId"] as string) as { url: string };

    sendJsonResponse(req, res, 200, { url: loginLink.url });
  } catch (error) {
    console.error("Create login link error:", error);
    handleError(req, res, error);
  }
});

// POST /account-session
app.post("/account-session", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (error) {
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

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;

    if (!userData["stripeAccountId"]) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Stripe account not set up. Please complete your Stripe setup first.");
    }

    const accountSession = await stripeService.createAccountSession(userData["stripeAccountId"] as string) as { client_secret: string };

    sendJsonResponse(req, res, 200, { clientSecret: accountSession.client_secret });
  } catch (error) {
    console.error("Create account session error:", error);
    handleError(req, res, error);
  }
});

// POST /create-checkout-session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const membership = body["membership"] as string | undefined;
    const priceId = body["priceId"] as string | undefined;
    let userEmail = body["email"] as string | undefined;

    if (!membership || !priceId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Membership and priceId are required");
    }

    let userId: string | null = null;
    let authUid: string | null = null;

    let user: { uid: string } | null = null;
    try {
      user = await verifyToken(req);
      authUid = user.uid;
      console.log("[create-checkout-session] Authenticated request from user:", authUid);
    } catch (error) {
      console.log("[create-checkout-session] Unauthenticated request (sign-up flow)");
    }

    const db = getFirestore();

    if (!userEmail) {
      if (user && authUid) {
        const userQuery = await db.collection("users")
          .where("authUid", "==", authUid)
          .limit(1)
          .get();

        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0]!;
          const userData = userDoc.data() as Record<string, unknown>;
          userEmail = userData["email"] as string;
          userId = userDoc.id;
        }
      }

      if (!userEmail) {
        return sendErrorResponse(req, res, 400, "Validation Error", "Email is required");
      }
    } else {
      const userQuery = await db.collection("users")
        .where("email", "==", userEmail.toLowerCase())
        .limit(1)
        .get();

      if (!userQuery.empty) {
        const userDoc = userQuery.docs[0]!;
        userId = userDoc.id;
        const userData = userDoc.data() as Record<string, unknown>;
        authUid = userData["authUid"] as string;
      }
    }

    const customer = await stripeService.createCustomer(userEmail, {
      userId: userId ?? "",
      authUid: authUid ?? "",
      membership,
    }) as { id: string };

    if (userId) {
      const userRef = db.collection("users").doc(userId);
      const userDoc = await userRef.get();

      if (userDoc.exists) {
        const userData = userDoc.data() as Record<string, unknown>;
        if (!userData["stripeCustomerId"]) {
          await userRef.update({
            stripeCustomerId: customer.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }

    const { subscriptionId, paymentIntentId, clientSecret } =
      await stripeService.createSubscriptionCheckout(
        customer.id,
        priceId,
        userId || null,
        membership,
      ) as { subscriptionId: string; paymentIntentId: string; clientSecret: string };

    if (userId) {
      await db.collection("users").doc(userId).update({
        pendingSubscriptionId: subscriptionId,
        pendingPaymentIntentId: paymentIntentId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    sendJsonResponse(req, res, 200, { subscriptionId, paymentIntentId, clientSecret });
  } catch (error) {
    console.error("Create checkout session error:", error);
    handleError(req, res, error);
  }
});

// POST /create-payment-link
app.post("/create-payment-link", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const membership = body["membership"] as string | undefined;
    const priceId = body["priceId"] as string | undefined;
    const email = body["email"] as string | undefined;

    if (!membership || !priceId || !email) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Membership, priceId, and email are required");
    }

    let userId: string | null = null;
    let authUid: string | null = null;

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("email", "==", email.toLowerCase())
      .limit(1)
      .get();

    if (!userQuery.empty) {
      const userDoc = userQuery.docs[0]!;
      userId = userDoc.id;
      const userData = userDoc.data() as Record<string, unknown>;
      authUid = userData["authUid"] as string;
    }

    const origin = (req.headers.origin as string | undefined) ||
      (req.headers.referer as string | undefined)?.split("/").slice(0, 3).join("/") ||
      process.env["FRONTEND_URL"] ||
      "https://studioowners.danceup.com";
    const successUrl = `${origin}/login?payment=success`;
    const cancelUrl = `${origin}/login?payment=canceled`;

    const metadata = {
      userId: userId || "",
      authUid: authUid || "",
      membership,
      email: email.toLowerCase(),
    };

    const paymentLink = await stripeService.createPaymentLink(
      priceId,
      email,
      metadata,
      successUrl,
      cancelUrl,
    ) as { url: string; id: string };

    sendJsonResponse(req, res, 200, { url: paymentLink.url, id: paymentLink.id });
  } catch (error) {
    console.error("Create Payment Link error:", error);
    handleError(req, res, error);
  }
});

// GET /subscription
app.get("/subscription", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;
    if (!userData["stripeSubscriptionId"]) {
      return sendJsonResponse(req, res, 200, null);
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const subscription = await stripe.subscriptions.retrieve(userData["stripeSubscriptionId"] as string, {
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
      planName: typeof product === "object" && product !== null ? ((product as { name?: string }).name ?? "Platform Subscription") : "Platform Subscription",
      amount: price?.unit_amount ?? 0,
      currency: price?.currency ?? "usd",
      interval: price?.recurring?.interval ?? "month",
    });
  } catch (error) {
    handleError(req, res, error);
  }
});

// POST /subscription/pause
app.post("/subscription/pause", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) return sendErrorResponse(req, res, 404, "Not Found", "User not found");

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;
    if (!userData["stripeSubscriptionId"]) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const body = req.body as Record<string, unknown>;
    const pauseCollection = { behavior: "mark_uncollectible" as const, ...(body["resumeAt"] ? { resumes_at: body["resumeAt"] as number } : {}) };

    const updated = await stripe.subscriptions.update(userData["stripeSubscriptionId"] as string, {
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

// POST /subscription/resume
app.post("/subscription/resume", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) return sendErrorResponse(req, res, 404, "Not Found", "User not found");

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;
    if (!userData["stripeSubscriptionId"]) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const updated = await stripe.subscriptions.update(userData["stripeSubscriptionId"] as string, {
      pause_collection: "" as unknown as import("stripe").default.SubscriptionUpdateParams.PauseCollection,
    });

    sendJsonResponse(req, res, 200, { status: updated.status, pausedUntil: null });
  } catch (error) {
    handleError(req, res, error);
  }
});

// POST /subscription/cancel
app.post("/subscription/cancel", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) return sendErrorResponse(req, res, 404, "Not Found", "User not found");

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;
    if (!userData["stripeSubscriptionId"]) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const updated = await stripe.subscriptions.update(userData["stripeSubscriptionId"] as string, {
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

// POST /subscription/reactivate
app.post("/subscription/reactivate", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) return sendErrorResponse(req, res, 404, "Not Found", "User not found");

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;
    if (!userData["stripeSubscriptionId"]) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const updated = await stripe.subscriptions.update(userData["stripeSubscriptionId"] as string, {
      cancel_at_period_end: false,
    });

    sendJsonResponse(req, res, 200, { cancelAtPeriodEnd: updated.cancel_at_period_end });
  } catch (error) {
    handleError(req, res, error);
  }
});

// POST /payment-methods/setup
app.post("/payment-methods/setup", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userDoc = userQuery.docs[0]!;
    const userData = userDoc.data() as Record<string, unknown>;

    let customerId = userData["stripeCustomerId"] as string | undefined;
    if (!customerId) {
      const customer = await stripeService.createCustomer(userData["email"] as string, {
        userId: userDoc.id,
        authUid: user.uid,
      }) as { id: string };
      customerId = customer.id;
      await userDoc.ref.update({
        stripeCustomerId: customerId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const setupIntent = await stripeService.createSetupIntent(customerId) as { client_secret: string };
    sendJsonResponse(req, res, 200, { clientSecret: setupIntent.client_secret });
  } catch (error) {
    handleError(req, res, error);
  }
});

// GET /payment-methods
app.get("/payment-methods", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;
    if (!userData["stripeCustomerId"]) {
      return sendJsonResponse(req, res, 200, []);
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const customerId = userData["stripeCustomerId"] as string;

    const [methods, customerRaw] = await Promise.all([
      stripeService.listPaymentMethods(customerId) as unknown as Promise<Array<Record<string, unknown>>>,
      stripe.customers.retrieve(customerId),
    ]);

    const customer = customerRaw as import("stripe").default.Customer;
    const defaultPmId = (customer.invoice_settings?.default_payment_method as string | null) ?? null;

    const result = methods.map((pm) => {
      const card = (pm["card"] as Record<string, unknown>) || {};
      return {
        id: pm["id"],
        brand: card["brand"],
        last4: card["last4"],
        expMonth: card["exp_month"],
        expYear: card["exp_year"],
        isDefault: pm["id"] === defaultPmId,
      };
    });
    sendJsonResponse(req, res, 200, result);
  } catch (error) {
    handleError(req, res, error);
  }
});

// POST /retry-invoice
app.post("/retry-invoice", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userDoc = userQuery.docs[0]!;
    const userData = userDoc.data() as Record<string, unknown>;

    if (!userData["stripeSubscriptionId"]) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No active subscription found");
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const subscription = await stripe.subscriptions.retrieve(userData["stripeSubscriptionId"] as string);

    if (!subscription.latest_invoice) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No invoice found for this subscription");
    }

    const invoiceId = typeof subscription.latest_invoice === "string"
      ? subscription.latest_invoice
      : (subscription.latest_invoice as { id: string }).id;

    const invoice = await stripe.invoices.retrieve(invoiceId);

    if (invoice.status === "paid") {
      return sendJsonResponse(req, res, 200, { alreadyPaid: true, message: "Invoice is already paid" });
    }

    const paidInvoice = await stripe.invoices.pay(invoiceId);

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
    const stripeError = ((error as Record<string, unknown>)["raw"] || error) as Record<string, unknown>;
    if (stripeError["type"] === "card_error" || stripeError["code"] === "card_declined") {
      return sendErrorResponse(req, res, 402, "Payment Failed", (stripeError["message"] as string) || "Card was declined. Please update your payment method.");
    }
    console.error("retry-invoice error:", error);
    handleError(req, res, error);
  }
});

// POST /payment-methods/:id/default
app.post("/payment-methods/:id/default", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userQuery.docs[0]!.data() as Record<string, unknown>;
    if (!userData["stripeCustomerId"]) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer found");
    }

    const methods = await stripeService.listPaymentMethods(userData["stripeCustomerId"] as string) as Array<{ id: string }>;
    if (!methods.some((pm) => pm.id === id)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    await stripeService.setDefaultPaymentMethod(userData["stripeCustomerId"] as string, id);
    sendJsonResponse(req, res, 200, { success: true, defaultPaymentMethodId: id });
  } catch (error) {
    handleError(req, res, error);
  }
});

// PUT /payment-methods/:id
app.put("/payment-methods/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;
    const body = req.body as Record<string, unknown>;
    const { expMonth, expYear } = body as { expMonth?: unknown; expYear?: unknown };

    if (!expMonth || !expYear) {
      return sendErrorResponse(req, res, 400, "Validation Error", "expMonth and expYear are required");
    }

    const month = parseInt(String(expMonth), 10);
    const year = parseInt(String(expYear), 10);

    if (isNaN(month) || month < 1 || month > 12) {
      return sendErrorResponse(req, res, 400, "Validation Error", "expMonth must be 1–12");
    }
    if (isNaN(year) || year < new Date().getFullYear()) {
      return sendErrorResponse(req, res, 400, "Validation Error", "expYear must be the current year or later");
    }

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const updated = await stripeService.updatePaymentMethod(id, month, year) as unknown as Record<string, unknown>;
    const card = (updated["card"] as Record<string, unknown>) || {};

    sendJsonResponse(req, res, 200, {
      id: updated["id"],
      brand: card["brand"],
      last4: card["last4"],
      expMonth: card["exp_month"],
      expYear: card["exp_year"],
    });
  } catch (error) {
    handleError(req, res, error);
  }
});

// DELETE /payment-methods/:id
app.delete("/payment-methods/:id", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const id = req.params["id"] as string;

    const db = getFirestore();
    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    await stripeService.detachPaymentMethod(id);
    sendJsonResponse(req, res, 200, { success: true });
  } catch (error) {
    handleError(req, res, error);
  }
});

// POST /subscription-payment-success
app.post("/subscription-payment-success", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const paymentIntentId = body["paymentIntentId"] as string | undefined;

    if (!paymentIntentId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "paymentIntentId is required");
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["invoice.subscription"],
    });

    if (pi.status !== "succeeded") {
      return sendErrorResponse(req, res, 400, "Validation Error", `Payment not completed (status: ${pi.status})`);
    }

    const invoice = pi.invoice as (import("stripe").default.Invoice & { subscription?: import("stripe").default.Subscription }) | null;
    const subscription = invoice?.subscription;
    if (!subscription) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Could not resolve subscription from payment intent");
    }

    const userId = (subscription as import("stripe").default.Subscription).metadata?.["userId"];
    const membership = (subscription as import("stripe").default.Subscription).metadata?.["membership"];

    if (!userId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "User ID not found in subscription metadata");
    }

    const db = getFirestore();
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "User not found");
    }

    const userData = userDoc.data() as Record<string, unknown>;

    const updateData: Record<string, unknown> = {
      stripeCustomerId: pi.customer,
      stripeSubscriptionId: (subscription as import("stripe").default.Subscription).id,
      stripeSubscriptionStatus: "active",
      membership: membership || userData["membership"],
      pendingSubscriptionId: admin.firestore.FieldValue.delete(),
      pendingPaymentIntentId: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!userData["stripeAccountId"]) {
      const account = await stripeService.createConnectedAccount(userData["email"] as string, {
        userId: userDoc.id,
        authUid: userData["authUid"] as string,
        membership: (membership || userData["membership"]) as string,
      }) as { id: string };
      updateData["stripeAccountId"] = account.id;
      updateData["stripeAccountStatus"] = "pending";
    }

    await userDoc.ref.update(updateData);

    const customToken = await admin.auth().createCustomToken(userData["authUid"] as string);

    sendJsonResponse(req, res, 200, {
      message: "Subscription activated successfully",
      customToken,
      userId: userData["authUid"],
      membership: membership || userData["membership"],
    });
  } catch (error) {
    console.error("Subscription payment success error:", error);
    handleError(req, res, error);
  }
});

// POST /checkout-success
app.post("/checkout-success", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const sessionId = body["sessionId"] as string | undefined;

    if (!sessionId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Session ID is required");
    }

    const session = await stripeService.getCheckoutSession(sessionId) as unknown as Record<string, unknown>;

    if (session["payment_status"] !== "paid") {
      return sendErrorResponse(req, res, 400, "Validation Error", "Payment not completed");
    }

    const db = getFirestore();
    const sessionMeta = (session["metadata"] as Record<string, string>) || {};
    let userId = sessionMeta["userId"];

    if (!userId || userId === "") {
      const email = sessionMeta["email"];
      if (email) {
        const userQuery = await db.collection("users")
          .where("email", "==", email.toLowerCase())
          .limit(1)
          .get();

        if (!userQuery.empty) {
          userId = userQuery.docs[0]!.id;
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

    const userData = userDoc.data() as Record<string, unknown>;
    const membership = sessionMeta["membership"] || (userData["membership"] as string);

    const updateData: Record<string, unknown> = {
      stripeCustomerId: session["customer"],
      stripeSubscriptionId: session["subscription"],
      stripeSubscriptionStatus: "active",
      membership,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!userData["stripeAccountId"]) {
      const account = await stripeService.createConnectedAccount(
        userData["email"] as string,
        {
          userId: userDoc.id,
          authUid: userData["authUid"] as string,
          membership,
        },
      ) as { id: string };

      updateData["stripeAccountId"] = account.id;
      updateData["stripeAccountStatus"] = "pending";
    }

    await userDoc.ref.update(updateData);

    const customToken = await admin.auth().createCustomToken(userData["authUid"] as string);

    sendJsonResponse(req, res, 200, {
      message: "Checkout completed successfully",
      customToken,
      userId: userData["authUid"],
      membership,
    });
  } catch (error) {
    console.error("Checkout success error:", error);
    handleError(req, res, error);
  }
});

// POST /webhook
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"] as string | undefined;

  if (!sig) {
    return sendErrorResponse(req, res, 400, "Validation Error", "Missing stripe-signature header");
  }

  try {
    const projectId = process.env["GCLOUD_PROJECT"] || process.env["GCP_PROJECT"] || "";
    const isProduction = projectId.includes("production");
    const secretName = isProduction
      ? "stripe-webhook-secret-prod"
      : "stripe-webhook-secret-test";

    let webhookSecret: string | undefined;
    try {
      webhookSecret = await getSecret(secretName);
    } catch (error) {
      if (isProduction) {
        // In production, Secret Manager is required — never fall back to env vars
        console.error(`Failed to load webhook secret from Secret Manager: ${secretName}`, error);
        return sendErrorResponse(req, res, 500, "Configuration Error", "Webhook secret unavailable");
      }
      console.warn(`Webhook secret not found in Secret Manager: ${secretName}. Falling back to env var (dev only).`);
      webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
    }

    if (!webhookSecret) {
      console.error("Webhook secret not configured");
      return sendErrorResponse(req, res, 500, "Configuration Error", "Webhook secret not configured");
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      return sendErrorResponse(req, res, 400, "Bad Request", "Missing raw request body for webhook verification");
    }

    const event = await stripeService.verifyWebhookSignature(
      rawBody,
      sig,
      webhookSecret.trim(),
    ) as import("stripe").default.Event;

    const db = getFirestore();

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as unknown as Record<string, unknown>;
        const sessionMeta = (session["metadata"] as Record<string, string>) || {};
        const purchaseType = sessionMeta["purchaseType"];

        if (!purchaseType) {
          let userId = sessionMeta["userId"];
          if (!userId || userId === "") {
            const emailVal = sessionMeta["email"] || (session["customer_email"] as string | undefined);
            if (emailVal) {
              const userQuery = await db.collection("users")
                .where("email", "==", emailVal.toLowerCase())
                .limit(1)
                .get();
              if (!userQuery.empty) userId = userQuery.docs[0]!.id;
            }
          }
          if (userId) {
            const userDoc = await db.collection("users").doc(userId).get();
            if (userDoc.exists) {
              const userData = userDoc.data() as Record<string, unknown>;
              const updateData: Record<string, unknown> = {
                stripeCustomerId: session["customer"],
                stripeSubscriptionId: session["subscription"],
                stripeSubscriptionStatus: "active",
                membership: sessionMeta["membership"] || userData["membership"],
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              };

              if (!userData["stripeAccountId"]) {
                try {
                  const account = await stripeService.createConnectedAccount(
                    userData["email"] as string,
                    { userId, authUid: userData["authUid"] as string, membership: updateData["membership"] as string },
                  ) as { id: string };
                  updateData["stripeAccountId"] = account.id;
                  updateData["stripeAccountStatus"] = "pending";
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

        if (purchaseType === "private_lesson") {
          try {
            await bookingsService.createConfirmedBookingFromSession(session);

            const customerDetails = session["customer_details"] as Record<string, unknown> | undefined;
            const recipientEmail = (customerDetails?.["email"] as string) || sessionMeta["contactEmail"];
            if (recipientEmail) {
              await sendConfirmationEmail(recipientEmail, "private_lesson", {
                instructorName: sessionMeta["instructorName"],
                studioName: sessionMeta["studioName"],
                date: sessionMeta["date"],
                timeSlot: `${sessionMeta["timeSlotStart"]} – ${sessionMeta["timeSlotEnd"]}`,
                amountPaid: sessionMeta["amountPaid"],
              });
            }

            await notificationsService.createNotification(
              sessionMeta["studioId"] || "",
              null,
              "private_lesson_booking",
              "New Private Lesson Booked & Paid",
              `A private lesson with ${sessionMeta["instructorName"]} on ${sessionMeta["date"]} was paid and confirmed.`,
            );
          } catch (err) {
            console.error("[webhook] Error handling private_lesson checkout:", err);
          }
          break;
        }

        try {
          const customerDetails = session["customer_details"] as Record<string, unknown> | undefined;
          const recipientEmail = customerDetails?.["email"] as string | undefined;
          if (recipientEmail) {
            const amountCents = (session["amount_total"] as number) || 0;
            const amountPaid = (amountCents / 100).toFixed(2);

            await sendConfirmationEmail(recipientEmail, purchaseType, {
              itemName: sessionMeta["itemName"] || purchaseType,
              studioName: sessionMeta["studioName"] || "the studio",
              amountPaid,
            });
          }
        } catch (err) {
          console.error("[webhook] Error sending purchase confirmation email:", err);
        }

        // Create a purchase record for guest checkouts — authenticated purchases
        // are recorded via /success after the redirect; guests have no way to call that.
        if (sessionMeta["authUid"] === "guest") {
          try {
            const customerDetails = session["customer_details"] as Record<string, unknown> | undefined;
            const guestEmail = (customerDetails?.["email"] as string | undefined) || null;
            const itemId = sessionMeta["itemId"];
            const studioOwnerId = sessionMeta["studioOwnerId"];
            const paymentIntentId = session["payment_intent"] as string | null | undefined;
            const stripeCustomerId = session["customer"] as string | null | undefined;

            if (itemId && studioOwnerId && guestEmail) {
              // Idempotency: skip if a record already exists for this session
              const existingQuery = await db.collection("purchases")
                .where("stripePaymentIntentId", "==", paymentIntentId || (session["id"] as string))
                .limit(1)
                .get();

              if (existingQuery.empty) {
                const itemDetails = await purchaseService.getItemDetails(
                  purchaseType as "class" | "event" | "workshop" | "package",
                  itemId,
                );
                await purchaseService.createPurchaseRecord({
                  studentId: "guest",
                  authUid: "guest",
                  guestEmail,
                  purchaseType,
                  itemId,
                  studioOwnerId,
                  itemName: itemDetails.itemName,
                  studioName: itemDetails.studioName,
                  price: itemDetails.price,
                  stripePaymentIntentId: paymentIntentId || (session["id"] as string),
                  stripeCustomerId: stripeCustomerId ?? null,
                  status: "completed",
                  creditGranted: false,
                  creditsGranted: 0,
                  creditIds: [],
                  classId: purchaseType === "class" ? itemId : null,
                  metadata: itemDetails.metadata,
                });
                console.log(`[webhook] Created guest purchase record for ${guestEmail} (${purchaseType}/${itemId})`);
              }
            }
          } catch (guestPurchaseErr) {
            console.error("[webhook] Error creating guest purchase record:", guestPurchaseErr);
          }
        }

        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as import("stripe").default.Subscription;
        const userId = subscription.metadata?.["userId"];

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
        const subscription = event.data.object as import("stripe").default.Subscription;
        const userId = subscription.metadata?.["userId"];

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
        const invoice = event.data.object as unknown as Record<string, unknown>;
        const subscriptionId = invoice["subscription"] as string | undefined;
        if (!subscriptionId) break;

        try {
          const stripe = await stripeService.getStripeClient() as import("stripe").default;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = subscription.metadata?.["userId"];

          if (userId) {
            const userDoc = await db.collection("users").doc(userId).get();
            if (userDoc.exists) {
              await userDoc.ref.update({
                stripeSubscriptionStatus: subscription.status,
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
        const invoice = event.data.object as unknown as Record<string, unknown>;
        const invoiceParent = invoice["parent"] as Record<string, unknown> | undefined;
        const subscriptionId = (invoice["subscription"] as string | undefined) ??
          (invoiceParent?.["subscription_details"] as Record<string, unknown> | undefined)?.["subscription"] as string | undefined;

        if (!subscriptionId) break;

        const stripe = await stripeService.getStripeClient() as import("stripe").default;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        const purchaseType = subscription.metadata?.["purchaseType"];
        if (purchaseType !== "package") {
          const userId = subscription.metadata?.["userId"];
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

        const itemId = subscription.metadata?.["itemId"];
        const studioOwnerId = subscription.metadata?.["studioOwnerId"];
        const studentId = subscription.metadata?.["studentId"];
        const authUid = subscription.metadata?.["authUid"];

        if (!itemId || !studioOwnerId || !studentId || !authUid) {
          console.error("Missing metadata in subscription for invoice.payment_succeeded:", {
            subscriptionId,
            metadata: subscription.metadata,
          });
          break;
        }

        const billingReason = invoice["billing_reason"] as string | undefined;
        const isFirstPayment = billingReason === "subscription_create";

        if (isFirstPayment) break;

        try {
          const itemDetailsRaw = await purchaseService.getItemDetails("package", itemId);
          const itemDetails = itemDetailsRaw as unknown as Record<string, unknown>;

          const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
          let studentName = "Student";
          if (studentProfileDoc) {
            const profileData = studentProfileDoc.data() as Record<string, unknown>;
            const firstName = (profileData["firstName"] as string) || "";
            const lastName = (profileData["lastName"] as string) || "";
            studentName = `${firstName} ${lastName}`.trim() || "Student";
          }

          const creditResult = await purchaseService.grantCreditsForPurchase(
            "package", studentId, studioOwnerId, itemDetailsRaw,
          ) as { creditsGranted: number; creditIds: string[] };

          const existingRenewalsSnapshot = await db.collection("purchases")
            .where("stripeSubscriptionId", "==", subscriptionId)
            .where("isRenewal", "==", true)
            .get();
          const renewalNumber = existingRenewalsSnapshot.size + 1;

          const amountPaid = ((invoice["amount_paid"] as number) || 0) / 100;

          const paymentIntentField = invoice["payment_intent"];
          const customerField = invoice["customer"];

          await purchaseService.createPurchaseRecord({
            studentId,
            authUid,
            purchaseType: "package",
            itemId,
            studioOwnerId,
            itemName: itemDetails["itemName"] as string,
            studioName: itemDetails["studioName"] as string,
            price: amountPaid,
            stripePaymentIntentId: (typeof paymentIntentField === "string"
              ? paymentIntentField
              : ((paymentIntentField as Record<string, unknown> | null)?.["id"] as string | null | undefined)) || null,
            stripeCustomerId: (typeof customerField === "string"
              ? customerField
              : ((customerField as Record<string, unknown> | null)?.["id"] as string | null | undefined)) || null,
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
              credits: (itemDetails["metadata"] as Record<string, unknown> | undefined)?.["credits"],
              expirationDays: (itemDetails["metadata"] as Record<string, unknown> | undefined)?.["expirationDays"],
            },
          });

          const originalPurchaseQuery = await db.collection("purchases")
            .where("stripeSubscriptionId", "==", subscriptionId)
            .where("studentId", "==", studentId)
            .where("isRenewal", "==", false)
            .limit(1)
            .get();

          if (!originalPurchaseQuery.empty) {
            await originalPurchaseQuery.docs[0]!.ref.update({
              subscriptionStatus: subscription.status,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          await purchaseService.createPurchaseNotification({
            studioOwnerId,
            studentId,
            authUid,
            itemId,
            studioName: itemDetails["studioName"] as string,
            price: amountPaid,
            studentName,
            purchaseType: "package",
            itemName: `${itemDetails["itemName"]} (Renewal #${renewalNumber})`,
          });

          console.log("Subscription renewal processed:", {
            subscriptionId, studentId, renewalNumber,
            creditsGranted: creditResult.creditsGranted, amountPaid,
          });
        } catch (error) {
          console.error("Error processing subscription renewal:", error);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return sendErrorResponse(req, res, 400, "Webhook Error", (error as Error).message);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const stripe = functions.https.onRequest(app);
