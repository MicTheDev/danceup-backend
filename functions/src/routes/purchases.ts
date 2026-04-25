import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import * as stripeService from "../services/stripe.service";
import purchaseService from "../services/purchase.service";
import creditTrackingService from "../services/credit-tracking.service";
import authService from "../services/auth.service";
import { sendConfirmationEmail } from "../services/sendgrid.service";
import classesService from "../services/classes.service";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";
import rateLimit from "express-rate-limit";

// Limit payment-creation endpoints to 20 requests per 15 minutes per IP
const paymentCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many payment requests. Please wait and try again." });
  },
});

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

// POST /create-payment-link
app.post("/create-payment-link", paymentCreationLimiter, async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const purchaseType = body["purchaseType"] as string | undefined;
    const itemId = body["itemId"] as string | undefined;
    const selectedTiers = body["selectedTiers"];
    const guestInfo = body["guestInfo"];

    if (!purchaseType || !itemId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "purchaseType and itemId are required");
    }

    if (!["class", "event", "workshop", "package"].includes(purchaseType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid purchaseType. Must be 'class', 'event', 'workshop', or 'package'");
    }

    let user: import("../types/api").DecodedToken | null = null;
    try {
      user = await verifyToken(req);
    } catch (error) {
      if (purchaseType === "package") {
        return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to purchase packages.");
      }
    }

    const db = getFirestore();

    let studentDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    if (user) {
      const studentQuery = await db.collection("students")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();
      if (!studentQuery.empty) {
        studentDoc = studentQuery.docs[0] ?? null;
      }
    }

    const itemDetails = await purchaseService.getItemDetails(purchaseType as "class" | "event" | "workshop" | "package", itemId);

    const studioOwnerRef = db.collection("users").doc(itemDetails.studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();

    if (!studioOwnerDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const studioOwnerData = studioOwnerDoc.data() as Record<string, unknown>;
    const connectedAccountId = (studioOwnerData["stripeAccountId"] as string) || null;

    // ── Resolve/create platform customer ─────────────────────────────────────
    let platformCustomerId: string | null = null;
    let userDocRef: FirebaseFirestore.DocumentReference | null = null;
    let connectedCustomers: Record<string, string> = {};
    let userEmail = "";

    if (user) {
      // Use the verified email from the auth token as the authoritative source
      userEmail = user.email;

      const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

      if (!userQuery.empty) {
        const userDoc = userQuery.docs[0]!;
        const userData = userDoc.data() as Record<string, unknown>;
        userDocRef = userDoc.ref;
        // Prefer Firestore email if present, but token email is always the fallback
        userEmail = (userData["email"] as string) || user.email;
        connectedCustomers = (userData["stripeConnectedCustomers"] as Record<string, string>) || {};

        if (userData["stripeCustomerId"]) {
          platformCustomerId = userData["stripeCustomerId"] as string;
        } else {
          const customer = await stripeService.createCustomer(userEmail, {
            userId: userDoc.id,
            authUid: user.uid,
          }) as { id: string };
          platformCustomerId = customer.id;
          await userDoc.ref.update({
            stripeCustomerId: customer.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } else {
        const profileDoc = await authService.getStudentProfileByAuthUid(user.uid);
        if (profileDoc) {
          const profileData = profileDoc.data() as Record<string, unknown>;
          userEmail = (profileData["email"] as string) || user.email;
        }
        const customer = await stripeService.createCustomer(userEmail, { authUid: user.uid }) as { id: string };
        platformCustomerId = customer.id;
      }
    }

    // ── Require connected account for direct charges ───────────────────────
    if (!connectedAccountId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "This studio has not completed Stripe Connect setup.");
    }

    // ── Find or create customer on connected account (dedup-safe) ─────────
    const studentName = studentDoc
      ? `${(studentDoc.data()["firstName"] as string) || ""} ${(studentDoc.data()["lastName"] as string) || ""}`.trim()
      : "";
    let connectedCustomerId: string;
    if (platformCustomerId) {
      const { customer: connectedCustomer, isNew } = await stripeService.findOrCreateConnectedCustomer(
        userEmail,
        platformCustomerId,
        connectedAccountId,
        studentName || undefined,
        connectedCustomers[connectedAccountId] ?? null,
      );
      connectedCustomerId = connectedCustomer.id;
      if (isNew && userDocRef) {
        await userDocRef.update({
          [`stripeConnectedCustomers.${connectedAccountId}`]: connectedCustomerId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else if (!connectedCustomers[connectedAccountId] && userDocRef) {
        // Found via Stripe search — backfill Firestore so the next call is instant
        await userDocRef.update({
          [`stripeConnectedCustomers.${connectedAccountId}`]: connectedCustomerId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } else {
      // Guest checkout (no platform customer) — connectedCustomerId not needed for one-time charges
      connectedCustomerId = "";
    }

    const isRecurring = purchaseType === "package" && itemDetails.isRecurring === true;

    const origin = (req.headers.origin as string | undefined) ||
      (req.headers.referer as string | undefined)?.split("/").slice(0, 3).join("/") ||
      process.env["FRONTEND_URL"] ||
      "https://users.danceup.com";
    const successUrl = `${origin}/purchases/confirmation?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/purchases/confirmation?canceled=true`;

    const metadata: Record<string, string> = {
      purchaseType,
      itemId,
      itemName: itemDetails.itemName || "",
      studioOwnerId: itemDetails.studioOwnerId,
      studioName: itemDetails.studioName || "",
      studentId: studentDoc ? studentDoc.id : "guest",
      authUid: user ? user.uid : "guest",
    };

    const applicationFeeAmount = 25 + Math.round(itemDetails.price * 100 * 0.01);

    let checkoutSession: { url: string; id: string };

    // ── Create price on connected account, then open checkout ─────────────
    const stripe = await stripeService.getStripeClient() as import("stripe").default;

    if (isRecurring) {
      const intervalMap: Record<string, string> = { monthly: "month", weekly: "week", daily: "day", yearly: "year" };
      const interval = (intervalMap[itemDetails.billingFrequency as string] || "month") as import("stripe").default.PriceCreateParams.Recurring.Interval;
      const intervalCount = (itemDetails.billingInterval as number) || 1;

      const price = await stripe.prices.create(
        {
          unit_amount: Math.round(itemDetails.price * 100),
          currency: "usd",
          recurring: { interval, interval_count: intervalCount },
          ...(itemDetails.stripeProductId
            ? { product: itemDetails.stripeProductId }
            : { product_data: { name: itemDetails.itemName, metadata: { purchaseType, itemId, studioOwnerId: itemDetails.studioOwnerId } } }
          ),
        },
        { stripeAccount: connectedAccountId },
      );

      const appFeePercent = stripeService.platformFeePercent(Math.round(itemDetails.price * 100));
      const subscriptionMetadata: Record<string, string> = {
        ...metadata,
        price: String(itemDetails.price),
        billingFrequency: String(itemDetails.billingFrequency || ""),
        billingInterval: String(itemDetails.billingInterval || ""),
        subscriptionDuration: String(itemDetails.subscriptionDuration || ""),
      };

      checkoutSession = await stripeService.createDirectSubscriptionSession(
        price.id,
        connectedCustomerId,
        connectedAccountId,
        appFeePercent,
        subscriptionMetadata,
        successUrl,
        cancelUrl,
      ) as unknown as { url: string; id: string };
    } else {
      const price = await stripe.prices.create(
        {
          unit_amount: Math.round(itemDetails.price * 100),
          currency: "usd",
          ...(itemDetails.stripeProductId
            ? { product: itemDetails.stripeProductId }
            : { product_data: { name: itemDetails.itemName, metadata: { purchaseType, itemId, studioOwnerId: itemDetails.studioOwnerId } } }
          ),
        },
        { stripeAccount: connectedAccountId },
      );

      checkoutSession = await stripeService.createDirectCheckoutSession(
        price.id,
        connectedCustomerId,
        connectedAccountId,
        applicationFeeAmount,
        metadata,
        successUrl,
        cancelUrl,
      ) as unknown as { url: string; id: string };
    }

    void selectedTiers;
    void guestInfo;

    sendJsonResponse(req, res, 200, { url: checkoutSession.url, id: checkoutSession.id });
  } catch (error) {
    console.error("Create Payment Link error:", error);
    handleError(req, res, error);
  }
});

// POST /charge-saved
app.post("/charge-saved", paymentCreationLimiter, async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const body = req.body as Record<string, unknown>;
    const purchaseType = body["purchaseType"] as string | undefined;
    const itemId = body["itemId"] as string | undefined;
    const paymentMethodId = body["paymentMethodId"] as string | undefined;

    if (!purchaseType || !itemId || !paymentMethodId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "purchaseType, itemId, and paymentMethodId are required");
    }
    if (!["class", "event", "workshop", "package"].includes(purchaseType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid purchaseType. Must be 'class', 'event', 'workshop', or 'package'");
    }
    if (typeof itemId !== "string" || itemId.trim().length === 0 || itemId.length > 128) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid itemId");
    }
    if (typeof paymentMethodId !== "string" || !paymentMethodId.startsWith("pm_")) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid paymentMethodId format");
    }

    const db = getFirestore();

    const studentQuery = await db.collection("students")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (studentQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found. Please enroll in a studio first.");
    }

    const studentDoc = studentQuery.docs[0]!;
    const studentData = studentDoc.data() as Record<string, unknown>;

    // ── Resolve user doc and connected customer ────────────────────────────
    let platformCustomerId: string | null = null;
    let connectedCustomers: Record<string, string> = {};
    let userDocRef: FirebaseFirestore.DocumentReference | null = null;
    // Use verified auth token email as the authoritative source
    let userEmail = user.email;

    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();

    if (!userQuery.empty) {
      const userDoc = userQuery.docs[0]!;
      const userData = userDoc.data() as Record<string, unknown>;
      userDocRef = userDoc.ref;
      userEmail = (userData["email"] as string) || user.email;
      platformCustomerId = (userData["stripeCustomerId"] as string) || null;
      connectedCustomers = (userData["stripeConnectedCustomers"] as Record<string, string>) || {};
    }

    if (!platformCustomerId) {
      const profileDoc = await authService.getStudentProfileByAuthUid(user.uid);
      if (profileDoc) {
        platformCustomerId = ((profileDoc.data() as Record<string, unknown>)["stripeCustomerId"] as string) || null;
      }
    }

    if (!platformCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account. Please add a payment method first.");
    }

    // Verify the payment method belongs to the platform customer
    const savedMethods = await stripeService.listPaymentMethods(platformCustomerId) as Array<{ id: string }>;
    if (!savedMethods.some((pm) => pm.id === paymentMethodId)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    const itemDetails = await purchaseService.getItemDetails(purchaseType as "class" | "event" | "workshop" | "package", itemId);
    const studioOwnerId = itemDetails.studioOwnerId;

    // Verify the student is enrolled in the studio that owns this item
    if ((studentData["studioOwnerId"] as string) !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Forbidden", "You are not enrolled in this studio.");
    }

    const studioOwnerDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioOwnerData = studioOwnerDoc.exists ? (studioOwnerDoc.data() as Record<string, unknown>) : {};
    const connectedAccountId = (studioOwnerData["stripeAccountId"] as string) || null;

    if (!connectedAccountId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "This studio has not completed Stripe Connect setup.");
    }

    // ── Find or create connected customer (dedup-safe) ───────────────────
    const studentName = `${(studentData["firstName"] as string) || ""} ${(studentData["lastName"] as string) || ""}`.trim();
    const { customer: connectedCustomerObj, isNew: isNewCC } = await stripeService.findOrCreateConnectedCustomer(
      userEmail,
      platformCustomerId,
      connectedAccountId,
      studentName || undefined,
      connectedCustomers[connectedAccountId] ?? null,
    );
    const connectedCustomerId = connectedCustomerObj.id;
    if ((isNewCC || !connectedCustomers[connectedAccountId]) && userDocRef) {
      await userDocRef.update({
        [`stripeConnectedCustomers.${connectedAccountId}`]: connectedCustomerId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // ── Find or clone payment method on connected account ─────────────────
    // On first use at this studio the card hasn't been cloned yet — clone it now.
    let connectedPm = await stripeService.findConnectedPaymentMethod(
      paymentMethodId,
      connectedCustomerId,
      connectedAccountId,
    );
    if (!connectedPm) {
      connectedPm = await stripeService.clonePaymentMethodToConnectedAccount(
        paymentMethodId,
        platformCustomerId,
        connectedCustomerId,
        connectedAccountId,
      );
    }

    const isRecurring = purchaseType === "package" && itemDetails.isRecurring === true;
    const metadata: Record<string, string> = {
      purchaseType,
      itemId,
      itemName: String(itemDetails.itemName ?? ""),
      price: String(itemDetails.price ?? ""),
      studioOwnerId,
      studentId: studentDoc.id,
      authUid: user.uid,
    };
    // Stable idempotency key: same user + item combination always maps to the same key,
    // so network retries don't produce duplicate charges.
    const idempotencyKey = `charge:${user.uid}:${purchaseType}:${itemId}`;

    let paymentIntentId: string | null | undefined;
    let subscriptionId: string | null = null;
    let subscriptionStatus: string | null = null;

    if (isRecurring) {
      const intervalMap: Record<string, string> = { monthly: "month", weekly: "week", daily: "day", yearly: "year" };
      const interval = (intervalMap[itemDetails.billingFrequency as string] || "month") as import("stripe").default.PriceCreateParams.Recurring.Interval;
      const intervalCount = (itemDetails.billingInterval as number) || 1;

      const priceParams: import("stripe").default.PriceCreateParams = {
        unit_amount: Math.round(itemDetails.price * 100),
        currency: "usd",
        recurring: { interval, interval_count: intervalCount },
        ...(itemDetails.stripeProductId
          ? { product: itemDetails.stripeProductId }
          : { product_data: { name: itemDetails.itemName, metadata: { purchaseType, itemId, studioOwnerId } } }
        ),
      };

      const subscription = await stripeService.createSubscriptionWithSavedCard(
        connectedCustomerId,
        priceParams,
        connectedPm.id,
        { ...metadata, price: String(itemDetails.price), billingFrequency: String(itemDetails.billingFrequency || ""), billingInterval: String(itemDetails.billingInterval || "") },
        connectedAccountId,
        idempotencyKey,
      ) as unknown as Record<string, unknown>;

      const latestInvoice = subscription["latest_invoice"] as Record<string, unknown> | null;
      const latestInvoicePI = latestInvoice?.["payment_intent"] as Record<string, unknown> | null;

      if (latestInvoicePI?.["status"] === "requires_action") {
        return sendJsonResponse(req, res, 200, {
          requiresAction: true,
          clientSecret: latestInvoicePI["client_secret"],
          subscriptionId: subscription["id"],
        });
      }

      if (latestInvoicePI?.["status"] !== "succeeded" && subscription["status"] !== "active") {
        return sendErrorResponse(req, res, 402, "Payment Failed", "Subscription payment failed. Please try a different card.");
      }

      subscriptionId = subscription["id"] as string;
      subscriptionStatus = subscription["status"] as string;
      paymentIntentId = latestInvoicePI?.["id"] as string | undefined;
    } else {
      const paymentIntent = await stripeService.chargePaymentMethodDirectly(
        connectedCustomerId,
        connectedPm.id,
        Math.round(itemDetails.price * 100),
        metadata,
        connectedAccountId,
        idempotencyKey,
      ) as unknown as Record<string, unknown>;

      if (paymentIntent["status"] === "requires_action") {
        return sendJsonResponse(req, res, 200, {
          requiresAction: true,
          clientSecret: paymentIntent["client_secret"],
        });
      }

      if (paymentIntent["status"] !== "succeeded") {
        return sendErrorResponse(req, res, 402, "Payment Failed", "Payment could not be completed. Please try a different card.");
      }

      paymentIntentId = paymentIntent["id"] as string;
    }

    const creditResult = await purchaseService.grantCreditsForPurchase(
      purchaseType as "class" | "event" | "workshop" | "package",
      studentDoc.id,
      studioOwnerId,
      itemDetails,
    );

    const purchaseId = await purchaseService.createPurchaseRecord({
      studentId: studentDoc.id,
      authUid: user.uid,
      purchaseType,
      itemId,
      studioOwnerId,
      itemName: itemDetails.itemName,
      studioName: itemDetails.studioName,
      price: itemDetails.price,
      stripePaymentIntentId: paymentIntentId || null,
      stripeCustomerId: platformCustomerId,
      stripeSubscriptionId: subscriptionId,
      isRecurring,
      subscriptionStatus,
      status: "completed",
      creditGranted: creditResult.creditsGranted > 0,
      creditsGranted: creditResult.creditsGranted,
      creditIds: creditResult.creditIds,
      classId: purchaseType === "class" ? itemId : null,
      metadata: itemDetails.metadata,
    });

    try {
      await purchaseService.createPurchaseNotification({
        studioOwnerId,
        studentId: studentDoc.id,
        authUid: user.uid,
        itemId,
        studioName: itemDetails.studioName,
        price: itemDetails.price,
        studentName: `${(studentData["firstName"] as string) || ""} ${(studentData["lastName"] as string) || ""}`.trim() || (studentData["email"] as string),
        purchaseType,
        itemName: itemDetails.itemName,
      });
    } catch (notifyErr) {
      console.error("Error creating purchase notification:", notifyErr);
    }

    try {
      const profileDoc = await authService.getStudentProfileByAuthUid(user.uid);
      if (profileDoc) {
        const profileData = profileDoc.data() as Record<string, unknown>;
        const recipientEmail = profileData["email"] as string | undefined;

        if (recipientEmail) {
          const emailDetails: Record<string, unknown> = {
            itemName: itemDetails.itemName,
            studioName: itemDetails.studioName,
            amountPaid: itemDetails.price?.toFixed(2),
          };

          if (purchaseType === "package") {
            const expirationDays = itemDetails.metadata?.["expirationDays"] as number | undefined;
            emailDetails["packageName"] = itemDetails.itemName;
            emailDetails["creditsAdded"] = creditResult.creditsGranted;
            if (expirationDays) {
              const expirationDate = new Date();
              expirationDate.setDate(expirationDate.getDate() + expirationDays);
              emailDetails["expirationDate"] = expirationDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
            }
          }

          await sendConfirmationEmail(recipientEmail, purchaseType, emailDetails);
        }
      }
    } catch (emailErr) {
      console.error("Error sending purchase confirmation email:", emailErr);
    }

    sendJsonResponse(req, res, 200, {
      success: true,
      purchaseId,
      creditsGranted: creditResult.creditsGranted,
      isRecurring,
      subscriptionId,
    });
  } catch (error) {
    console.error("charge-saved error:", error);
    handleError(req, res, error);
  }
});

// POST /create-payment-intent
// Self-hosted checkout: creates a PaymentIntent on the connected account.
// Returns { clientSecret, paymentIntentId, connectedAccountId } for the frontend
// to mount a Stripe Payment Element without redirecting to stripe.com.
// Recurring packages are not supported here — use /create-payment-link for those.
app.post("/create-payment-intent", paymentCreationLimiter, async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const body = req.body as Record<string, unknown>;
    const purchaseType = body["purchaseType"] as string | undefined;
    const itemId = body["itemId"] as string | undefined;

    if (!purchaseType || !itemId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "purchaseType and itemId are required");
    }
    if (!["class", "event", "workshop", "package"].includes(purchaseType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid purchaseType");
    }

    const db = getFirestore();
    const itemDetails = await purchaseService.getItemDetails(
      purchaseType as "class" | "event" | "workshop" | "package", itemId,
    );

    // Recurring packages require a different flow (subscription) — not supported here
    if (purchaseType === "package" && itemDetails.isRecurring) {
      return sendErrorResponse(req, res, 400, "Unsupported", "Recurring packages cannot use the self-hosted checkout. Use /create-payment-link.");
    }

    const studioOwnerDoc = await db.collection("users").doc(itemDetails.studioOwnerId).get();
    if (!studioOwnerDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }
    const studioOwnerData = studioOwnerDoc.data() as Record<string, unknown>;
    const connectedAccountId = (studioOwnerData["stripeAccountId"] as string) || null;
    if (!connectedAccountId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "This studio has not completed Stripe Connect setup.");
    }

    // Resolve student doc
    const studentQuery = await db.collection("students")
      .where("authUid", "==", user.uid).limit(1).get();
    const studentDoc = studentQuery.empty ? null : studentQuery.docs[0]!;
    const studentId = studentDoc ? studentDoc.id : "guest";
    const studentName = studentDoc
      ? `${(studentDoc.data()["firstName"] as string) || ""} ${(studentDoc.data()["lastName"] as string) || ""}`.trim()
      : "";

    // Resolve/create platform customer
    let platformCustomerId: string | null = null;
    let userDocRef: FirebaseFirestore.DocumentReference | null = null;
    let connectedCustomers: Record<string, string> = {};
    // Use verified auth token email as the authoritative source
    let userEmail = user.email;

    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid).limit(1).get();
    if (!userQuery.empty) {
      const userDoc = userQuery.docs[0]!;
      const userData = userDoc.data() as Record<string, unknown>;
      userDocRef = userDoc.ref;
      userEmail = (userData["email"] as string) || user.email;
      connectedCustomers = (userData["stripeConnectedCustomers"] as Record<string, string>) || {};
      if (userData["stripeCustomerId"]) {
        platformCustomerId = userData["stripeCustomerId"] as string;
      } else {
        const customer = await stripeService.createCustomer(userEmail, { userId: userDoc.id, authUid: user.uid }) as { id: string };
        platformCustomerId = customer.id;
        await userDoc.ref.update({ stripeCustomerId: customer.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }

    // Find or create connected customer (dedup-safe)
    if (!platformCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account.");
    }
    const { customer: connectedCustomer, isNew: isNewConnectedCustomer } = await stripeService.findOrCreateConnectedCustomer(
      userEmail,
      platformCustomerId,
      connectedAccountId,
      studentName || undefined,
      connectedCustomers[connectedAccountId] ?? null,
    );
    const connectedCustomerId = connectedCustomer.id;
    if ((isNewConnectedCustomer || !connectedCustomers[connectedAccountId]) && userDocRef) {
      await userDocRef.update({
        [`stripeConnectedCustomers.${connectedAccountId}`]: connectedCustomerId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const amountCents = Math.round(itemDetails.price * 100);
    const applicationFeeAmount = 25 + Math.round(amountCents * 0.01);

    const metadata: Record<string, string> = {
      purchaseType,
      itemId,
      itemName: itemDetails.itemName || "",
      studioOwnerId: itemDetails.studioOwnerId,
      studioName: itemDetails.studioName || "",
      studentId,
      authUid: user.uid,
      connectedCustomerId,
    };

    const paymentIntent = await stripeService.createDirectPaymentIntent(
      amountCents,
      connectedAccountId,
      applicationFeeAmount,
      metadata,
    );

    // Store the mapping so /success can look up the connected account server-side
    // without relying on a client-supplied connectedAccountId.
    await db.collection("pendingPaymentIntents").doc(paymentIntent.id).set({
      connectedAccountId,
      studioOwnerId: itemDetails.studioOwnerId,
      authUid: user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      connectedAccountId,
    });
  } catch (error) {
    console.error("create-payment-intent error:", error);
    handleError(req, res, error);
  }
});

// POST /success
app.post("/success", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const body = req.body as Record<string, unknown>;
    const paymentIntentIdParam = body["paymentIntentId"] as string | undefined;
    const sessionId = body["sessionId"] as string | undefined;

    if (!paymentIntentIdParam && !sessionId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "paymentIntentId or sessionId is required");
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    let paymentIntent: import("stripe").default.PaymentIntent | null = null;
    let metadata: Record<string, string> = {};

    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent", "subscription", "line_items"],
      });

      if (session.payment_status !== "paid") {
        return sendErrorResponse(req, res, 400, "Validation Error", "Payment not completed");
      }

      metadata = (session.metadata as Record<string, string>) || {};

      if (session.mode === "subscription" && session.subscription) {
        const subscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription as { id: string }).id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        if (!metadata || Object.keys(metadata).length === 0) {
          metadata = (subscription.metadata as Record<string, string>) || {};
        }

        metadata["stripeSubscriptionId"] = subscriptionId;
      }

      if (session.payment_intent) {
        const piId = typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent as { id: string }).id;
        paymentIntent = await stripe.paymentIntents.retrieve(piId);

        if (!metadata || Object.keys(metadata).length === 0) {
          metadata = (paymentIntent.metadata as Record<string, string>) || {};
        }
      }

      if (!metadata || Object.keys(metadata).length === 0) {
        try {
          const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
            expand: ["data.price.product"],
          });
          const firstItem = lineItems.data[0];
          if (firstItem) {
            const product = firstItem.price?.product;
            if (typeof product === "object" && product !== null && "metadata" in product) {
              metadata = (product as { metadata: Record<string, string> }).metadata;
            }
          }
        } catch (lineItemsError) {
          console.warn("Error fetching line items:", lineItemsError);
        }
      }
    } else {
      // Direct-charge PaymentIntent: look up the connected account from Firestore
      // (stored by /create-payment-intent) — never trust a client-supplied account ID.
      const pendingDoc = await getFirestore()
        .collection("pendingPaymentIntents")
        .doc(paymentIntentIdParam!)
        .get();

      if (pendingDoc.exists) {
        const pendingData = pendingDoc.data() as Record<string, string>;
        const serverConnectedAccountId = pendingData["connectedAccountId"];
        if (!serverConnectedAccountId) {
          return sendErrorResponse(req, res, 500, "Internal Error", "Payment record is missing connected account reference");
        }
        paymentIntent = await stripeService.retrieveConnectedPaymentIntent(
          paymentIntentIdParam!, serverConnectedAccountId,
        );
        if (paymentIntent.status !== "succeeded") {
          return sendErrorResponse(req, res, 400, "Validation Error", "Payment not completed");
        }
        metadata = (paymentIntent.metadata as Record<string, string>) || {};
        // Clean up the pending record now that payment is confirmed
        await pendingDoc.ref.delete();
      } else {
        // Legacy: platform-account PaymentIntent (e.g., Checkout sessions before direct charge)
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentIdParam!);
        if (paymentIntent.status !== "succeeded") {
          return sendErrorResponse(req, res, 400, "Validation Error", "Payment not completed");
        }
        metadata = (paymentIntent.metadata as Record<string, string>) || {};
      }
    }

    console.log("[Purchase Success] Initial metadata:", {
      sessionId,
      paymentIntentId: paymentIntentIdParam,
      metadata,
      metadataKeys: Object.keys(metadata),
    });

    let purchaseType = metadata["purchaseType"];
    let itemId = metadata["itemId"];
    let studioOwnerId = metadata["studioOwnerId"];
    let studentId = metadata["studentId"];

    if (!purchaseType || !itemId || !studioOwnerId || !studentId) {
      console.log("[Purchase Success] Metadata missing from session/payment intent, checking product metadata");

      if (sessionId) {
        try {
          const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
            expand: ["data.price.product"],
          });

          console.log("[Purchase Success] Line items:", lineItems.data.length);

          const firstItem = lineItems.data[0];
          if (firstItem) {
            const product = firstItem.price?.product;

            console.log("[Purchase Success] Product:", {
              productType: typeof product,
              productId: typeof product === "object" ? (product as { id: string }).id : product,
              productMetadata: typeof product === "object" ? (product as { metadata?: unknown }).metadata : null,
            });

            if (typeof product === "object" && product !== null && "metadata" in product) {
              const productMeta = (product as { metadata: Record<string, string> }).metadata;
              console.log("[Purchase Success] Found metadata in product:", productMeta);
              purchaseType = purchaseType || productMeta["purchaseType"];
              itemId = itemId || productMeta["itemId"];
              studioOwnerId = studioOwnerId || productMeta["studioOwnerId"];
              studentId = studentId || productMeta["studentId"];
            }
          }
        } catch (error) {
          console.error("[Purchase Success] Error retrieving product metadata:", error);
        }
      }
    }

    if (!purchaseType || !itemId || !studioOwnerId || !studentId) {
      console.error("[Purchase Success] Missing purchase metadata after all attempts:", {
        purchaseType, itemId, studioOwnerId, studentId, sessionId, paymentIntentId: paymentIntentIdParam,
      });
      return sendErrorResponse(req, res, 400, "Validation Error", "Missing purchase metadata. Please contact support with your payment confirmation.");
    }

    const db = getFirestore();
    const existingPurchase = await db.collection("purchases")
      .where("stripePaymentIntentId", "==", paymentIntent?.id || sessionId)
      .limit(1)
      .get();

    if (!existingPurchase.empty) {
      const existingDoc = existingPurchase.docs[0]!;
      const existingData = existingDoc.data() as Record<string, unknown>;
      return sendJsonResponse(req, res, 200, {
        message: "Purchase already processed",
        purchaseId: existingDoc.id,
        creditsGranted: (existingData["creditsGranted"] as number) || 0,
      });
    }

    const studentRef = db.collection("students").doc(studentId);
    const studentDoc = await studentRef.get();

    if (!studentDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student record not found");
    }

    const studentData = studentDoc.data() as Record<string, unknown>;
    if (studentData["authUid"] !== user.uid) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Purchase does not belong to this user");
    }

    const studentProfileDoc = await authService.getStudentProfileByAuthUid(user.uid);
    let studentName: string | null = null;
    if (studentProfileDoc) {
      const profileData = studentProfileDoc.data() as Record<string, unknown>;
      const firstName = (profileData["firstName"] as string) || "";
      const lastName = (profileData["lastName"] as string) || "";
      studentName = `${firstName} ${lastName}`.trim() || null;
    }

    const studentInfo = {
      studentId,
      studentName: studentName || (studentData["email"] as string) || "Student",
    };

    const itemDetails = await purchaseService.getItemDetails(purchaseType as "class" | "event" | "workshop" | "package", itemId);

    if (itemDetails.studioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Studio owner ID mismatch");
    }

    const isRecurring = purchaseType === "package" && itemDetails.isRecurring === true;
    const stripeSubscriptionId = metadata["stripeSubscriptionId"] || null;
    let subscriptionStatus: string | null = null;

    if (isRecurring && stripeSubscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        subscriptionStatus = subscription.status;

        if (itemDetails.subscriptionDuration && (itemDetails.subscriptionDuration as number) > 0) {
          try {
            const currentPeriodEnd = subscription.current_period_end;
            const duration = itemDetails.subscriptionDuration as number;
            const billingFrequency = itemDetails.billingFrequency as string;
            const billingInterval = (itemDetails.billingInterval as number) || 1;

            const periodsToAdd = (duration - 1) * billingInterval;
            let millisecondsToAdd = 0;

            if (billingFrequency === "monthly") {
              const cancelDate = new Date(currentPeriodEnd * 1000);
              cancelDate.setMonth(cancelDate.getMonth() + periodsToAdd);
              millisecondsToAdd = cancelDate.getTime() - (currentPeriodEnd * 1000);
            } else if (billingFrequency === "weekly") {
              millisecondsToAdd = periodsToAdd * 7 * 24 * 60 * 60 * 1000;
            } else if (billingFrequency === "daily") {
              millisecondsToAdd = periodsToAdd * 24 * 60 * 60 * 1000;
            } else if (typeof billingFrequency === "number") {
              millisecondsToAdd = periodsToAdd * (billingFrequency as unknown as number) * 24 * 60 * 60 * 1000;
            } else {
              const cancelDate = new Date(currentPeriodEnd * 1000);
              cancelDate.setMonth(cancelDate.getMonth() + periodsToAdd);
              millisecondsToAdd = cancelDate.getTime() - (currentPeriodEnd * 1000);
            }

            const cancelAt = Math.floor((currentPeriodEnd * 1000 + millisecondsToAdd) / 1000);

            await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at: cancelAt });
            console.log(`[Purchase Success] Set subscription ${stripeSubscriptionId} to cancel at ${new Date(cancelAt * 1000).toISOString()}`);
          } catch (cancelError) {
            console.error("Error setting subscription cancel_at:", cancelError);
          }
        }
      } catch (error) {
        console.error("Error retrieving subscription:", error);
        subscriptionStatus = "active";
      }
    }

    const creditResult = await purchaseService.grantCreditsForPurchase(
      purchaseType as "class" | "event" | "workshop" | "package",
      studentId,
      studioOwnerId,
      itemDetails,
    );

    const purchaseId = await purchaseService.createPurchaseRecord({
      studentId,
      authUid: user.uid,
      purchaseType,
      itemId,
      studioOwnerId,
      itemName: itemDetails.itemName,
      studioName: itemDetails.studioName,
      price: itemDetails.price,
      stripePaymentIntentId: paymentIntent?.id || sessionId,
      stripeCustomerId: typeof paymentIntent?.customer === "string" ? paymentIntent.customer : null,
      stripeSubscriptionId: stripeSubscriptionId,
      isRecurring,
      subscriptionStatus,
      status: "completed",
      creditGranted: creditResult.creditsGranted > 0,
      creditsGranted: creditResult.creditsGranted,
      creditIds: creditResult.creditIds,
      classId: purchaseType === "class" ? itemId : null,
      metadata: itemDetails.metadata,
    });

    try {
      await purchaseService.createPurchaseNotification({
        studioOwnerId,
        studentId,
        authUid: user.uid,
        itemId,
        studioName: itemDetails.studioName,
        price: itemDetails.price,
        studentName: studentInfo.studentName,
        purchaseType,
        itemName: itemDetails.itemName,
      });
    } catch (notificationError) {
      console.error("Error creating notification:", notificationError);
    }

    sendJsonResponse(req, res, 200, {
      message: "Purchase completed successfully",
      purchaseId,
      creditsGranted: creditResult.creditsGranted,
      isRecurring,
      subscriptionId: stripeSubscriptionId,
    });
  } catch (error) {
    console.error("Purchase success error:", error);
    handleError(req, res, error);
  }
});

// GET / — purchase history for authenticated user
app.get("/", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const type = req.query["type"] as string | undefined;
    const limitParam = req.query["limit"] as string | undefined;
    const startAfterParam = req.query["startAfter"] as string | undefined;
    const limitNum = parseInt(limitParam || "50") || 50;
    const purchaseType = type && ["class", "event", "workshop", "package"].includes(type) ? type : null;

    const db = getFirestore();
    const studentSnapshot = await db.collection("students")
      .where("authUid", "==", user.uid)
      .get();

    if (studentSnapshot.empty) {
      return sendJsonResponse(req, res, 200, []);
    }

    let purchasesQuery = db.collection("purchases")
      .where("authUid", "==", user.uid)
      .orderBy("createdAt", "desc")
      .limit(limitNum) as FirebaseFirestore.Query;

    if (purchaseType) {
      purchasesQuery = purchasesQuery.where("purchaseType", "==", purchaseType);
    }

    if (startAfterParam) {
      const startAfterDoc = await db.collection("purchases").doc(startAfterParam).get();
      if (startAfterDoc.exists) {
        purchasesQuery = purchasesQuery.startAfter(startAfterDoc);
      }
    }

    const purchasesSnapshot = await purchasesQuery.get();
    const purchases = purchasesSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    sendJsonResponse(req, res, 200, purchases);
  } catch (error) {
    console.error("Get purchase history error:", error);
    handleError(req, res, error);
  }
});

// GET /student/:studentId — purchase history for a specific student (studio owners)
app.get("/student/:studentId", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const studentId = req.params["studentId"] as string;
    const type = req.query["type"] as string | undefined;
    const limitParam = req.query["limit"] as string | undefined;
    const startAfterParam = req.query["startAfter"] as string | undefined;
    const limitNum = parseInt(limitParam || "50") || 50;
    const purchaseType = type && ["class", "event", "workshop", "package"].includes(type) ? type : null;

    const studioOwnerId = await classesService.getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    const db = getFirestore();
    const studentRef = db.collection("students").doc(studentId);
    const studentDoc = await studentRef.get();

    if (!studentDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    const studentData = studentDoc.data() as Record<string, unknown>;
    if (studentData["studioOwnerId"] !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Student does not belong to this studio");
    }

    let purchasesQuery = db.collection("purchases")
      .where("studentId", "==", studentId)
      .orderBy("createdAt", "desc")
      .limit(limitNum) as FirebaseFirestore.Query;

    if (purchaseType) {
      purchasesQuery = purchasesQuery.where("purchaseType", "==", purchaseType);
    }

    if (startAfterParam) {
      const startAfterDoc = await db.collection("purchases").doc(startAfterParam).get();
      if (startAfterDoc.exists) {
        purchasesQuery = purchasesQuery.startAfter(startAfterDoc);
      }
    }

    const purchasesSnapshot = await purchasesQuery.get();
    const purchases = purchasesSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    sendJsonResponse(req, res, 200, purchases);
  } catch (error) {
    console.error("Get student purchase history error:", error);
    handleError(req, res, error);
  }
});

// GET /subscriptions
app.get("/subscriptions", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();

    const purchasesQuery = await db.collection("purchases")
      .where("authUid", "==", user.uid)
      .where("isRecurring", "==", true)
      .where("subscriptionStatus", "in", ["active", "trialing"])
      .get();

    const subscriptions: unknown[] = [];
    const stripe = await stripeService.getStripeClient() as import("stripe").default;

    for (const purchaseDoc of purchasesQuery.docs) {
      const purchaseData = purchaseDoc.data() as Record<string, unknown>;
      const subscriptionId = purchaseData["stripeSubscriptionId"] as string | undefined;

      if (!subscriptionId) continue;

      let allowCancellation = true;
      if (purchaseData["purchaseType"] === "package" && purchaseData["itemId"]) {
        try {
          const packageRef = db.collection("packages").doc(purchaseData["itemId"] as string);
          const packageDoc = await packageRef.get();
          if (packageDoc.exists) {
            const packageData = packageDoc.data() as Record<string, unknown>;
            allowCancellation = packageData["allowCancellation"] !== undefined ? (packageData["allowCancellation"] as boolean) : true;
          } else {
            const meta = purchaseData["metadata"] as Record<string, unknown> | undefined;
            allowCancellation = meta?.["allowCancellation"] !== undefined ? (meta["allowCancellation"] as boolean) : true;
          }
        } catch (packageError) {
          console.error(`Error retrieving package ${purchaseData["itemId"]}:`, packageError);
          const meta = purchaseData["metadata"] as Record<string, unknown> | undefined;
          allowCancellation = meta?.["allowCancellation"] !== undefined ? (meta["allowCancellation"] as boolean) : true;
        }
      } else {
        const meta = purchaseData["metadata"] as Record<string, unknown> | undefined;
        allowCancellation = meta?.["allowCancellation"] !== undefined ? (meta["allowCancellation"] as boolean) : true;
      }

      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const nextBillingDate = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null;
        const meta = purchaseData["metadata"] as Record<string, unknown> | undefined;

        subscriptions.push({
          id: purchaseDoc.id,
          purchaseId: purchaseDoc.id,
          subscriptionId,
          packageName: purchaseData["itemName"],
          studioName: purchaseData["studioName"],
          price: purchaseData["price"],
          status: subscription.status,
          nextBillingDate: nextBillingDate?.toISOString() || null,
          billingFrequency: meta?.["billingFrequency"] || null,
          billingInterval: meta?.["billingInterval"] || 1,
          allowCancellation,
          createdAt: purchaseData["createdAt"],
        });
      } catch (error) {
        console.error(`Error retrieving subscription ${subscriptionId}:`, error);
        const meta = purchaseData["metadata"] as Record<string, unknown> | undefined;
        subscriptions.push({
          id: purchaseDoc.id,
          purchaseId: purchaseDoc.id,
          subscriptionId,
          packageName: purchaseData["itemName"],
          studioName: purchaseData["studioName"],
          price: purchaseData["price"],
          status: (purchaseData["subscriptionStatus"] as string) || "unknown",
          nextBillingDate: null,
          billingFrequency: meta?.["billingFrequency"] || null,
          billingInterval: meta?.["billingInterval"] || 1,
          allowCancellation,
          createdAt: purchaseData["createdAt"],
        });
      }
    }

    sendJsonResponse(req, res, 200, subscriptions);
  } catch (error) {
    console.error("Error getting subscriptions:", error);
    handleError(req, res, error);
  }
});

// POST /subscriptions/:subscriptionId/cancel
app.post("/subscriptions/:subscriptionId/cancel", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const subscriptionId = req.params["subscriptionId"] as string;

    if (!subscriptionId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Subscription ID is required");
    }

    const db = getFirestore();
    const purchaseQuery = await db.collection("purchases")
      .where("authUid", "==", user.uid)
      .where("stripeSubscriptionId", "==", subscriptionId)
      .limit(1)
      .get();

    if (purchaseQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Subscription not found");
    }

    const stripe = await stripeService.getStripeClient() as import("stripe").default;
    const canceledSubscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    const purchaseDoc = purchaseQuery.docs[0]!;
    await purchaseDoc.ref.update({
      subscriptionStatus: "canceled",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {
      message: "Subscription will be canceled at the end of the billing period",
      subscriptionId: canceledSubscription.id,
      cancelAt: canceledSubscription.cancel_at
        ? new Date(canceledSubscription.cancel_at * 1000).toISOString()
        : null,
    });
  } catch (error) {
    console.error("Error canceling subscription:", error);
    handleError(req, res, error);
  }
});

// GET /cash
app.get("/cash", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();

    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();
    if (userQuery.empty) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }
    const studioOwnerId = userQuery.docs[0]!.id;

    const limitParam = Math.min(parseInt((req.query["limit"] as string) || "50") || 50, 200);
    const startDate = req.query["startDate"] as string | undefined;
    const endDate = req.query["endDate"] as string | undefined;

    let query = db.collection("cashPurchases")
      .where("studioOwnerId", "==", studioOwnerId)
      .orderBy("createdAt", "desc")
      .limit(limitParam) as FirebaseFirestore.Query;

    if (startDate) {
      query = query.where("createdAt", ">=", new Date(startDate));
    }
    if (endDate) {
      query = query.where("createdAt", "<=", new Date(endDate));
    }

    const snapshot = await query.get();
    const transactions = snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const createdAt = data["createdAt"] as { toDate?: () => Date } | null | undefined;
      return {
        id: doc.id,
        ...data,
        createdAt: createdAt?.toDate?.()?.toISOString() || null,
      };
    });

    sendJsonResponse(req, res, 200, { transactions, total: transactions.length });
  } catch (error) {
    console.error("Error fetching cash transactions:", error);
    handleError(req, res, error);
  }
});

// POST /cash
app.post("/cash", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const db = getFirestore();

    const userQuery = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();
    if (userQuery.empty) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }
    const studioOwnerId = userQuery.docs[0]!.id;

    const body = req.body as Record<string, unknown>;
    const studentId = body["studentId"] as string | undefined;
    const amount = body["amount"];
    const description = body["description"] as string | undefined;
    const itemType = body["itemType"] as string | undefined;
    const itemId = body["itemId"] as string | undefined;

    if (!amount || isNaN(parseFloat(String(amount))) || parseFloat(String(amount)) <= 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "amount must be a positive number");
    }

    const docData: Record<string, unknown> = {
      studioOwnerId,
      amount: parseFloat(String(amount)),
      paymentMethod: "cash",
      status: "completed",
      source: "manual",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (studentId) docData["studentId"] = studentId;
    if (description) docData["description"] = description;
    if (itemType) docData["purchaseType"] = itemType;
    if (itemId) docData["itemId"] = itemId;

    if (studentId) {
      try {
        const studentDoc = await db.collection("students").doc(studentId).get();
        if (studentDoc.exists) {
          const s = studentDoc.data() as Record<string, unknown>;
          docData["studentName"] = [s["firstName"], s["lastName"]].filter(Boolean).join(" ");
        }
      } catch (_) { /* non-critical */ }
    }

    const docRef = await db.collection("cashPurchases").add(docData);

    sendJsonResponse(req, res, 201, { id: docRef.id, message: "Cash payment recorded successfully" });
  } catch (error) {
    console.error("Error recording cash payment:", error);
    handleError(req, res, error);
  }
});

// POST /:purchaseId/check-in
app.post("/:purchaseId/check-in", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const purchaseId = req.params["purchaseId"] as string;
    const db = getFirestore();

    const purchaseRef = db.collection("purchases").doc(purchaseId);
    const purchaseDoc = await purchaseRef.get();

    if (!purchaseDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Purchase not found");
    }

    const purchase = purchaseDoc.data() as Record<string, unknown>;

    const studioOwnerSnapshot = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();
    const isStudioOwner = !studioOwnerSnapshot.empty &&
      studioOwnerSnapshot.docs[0]!.id === (purchase["studioOwnerId"] as string);

    const isOwnPurchase = purchase["authUid"] === user.uid;

    if (!isStudioOwner && !isOwnPurchase) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You do not have permission to check in this attendee");
    }

    if (purchase["checkedIn"]) {
      return sendErrorResponse(req, res, 409, "Conflict", "Attendee is already checked in");
    }

    const checkedInBy = isStudioOwner ? "studio" : "student";

    await purchaseRef.update({
      checkedIn: true,
      checkedInAt: admin.firestore.FieldValue.serverTimestamp(),
      checkedInBy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { message: "Attendee checked in successfully" });
  } catch (error) {
    console.error("Error checking in attendee:", error);
    handleError(req, res, error);
  }
});

// POST /:purchaseId/check-out
app.post("/:purchaseId/check-out", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const purchaseId = req.params["purchaseId"] as string;
    const db = getFirestore();

    const purchaseRef = db.collection("purchases").doc(purchaseId);
    const purchaseDoc = await purchaseRef.get();

    if (!purchaseDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Purchase not found");
    }

    const purchase = purchaseDoc.data() as Record<string, unknown>;

    const studioOwnerSnapshot = await db.collection("users")
      .where("authUid", "==", user.uid)
      .limit(1)
      .get();
    const isStudioOwner = !studioOwnerSnapshot.empty &&
      studioOwnerSnapshot.docs[0]!.id === (purchase["studioOwnerId"] as string);

    if (!isStudioOwner) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Only studio owners can remove a check-in");
    }

    await purchaseRef.update({
      checkedIn: false,
      checkedInAt: null,
      checkedInBy: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { message: "Check-in removed successfully" });
  } catch (error) {
    console.error("Error removing check-in:", error);
    handleError(req, res, error);
  }
});

// POST /:purchaseId/refund
app.post("/:purchaseId/refund", async (req, res) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    const authUid = user.uid;
    const purchaseId = req.params["purchaseId"] as string;
    const body = req.body as Record<string, unknown>;
    const reason = body["reason"] as string | undefined;

    const db = getFirestore();

    const studioOwnerSnapshot = await db.collection("studioOwners")
      .where("authUid", "==", authUid)
      .limit(1)
      .get();
    if (studioOwnerSnapshot.empty) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Not authorized");
    }
    const studioOwnerId = studioOwnerSnapshot.docs[0]!.id;

    const purchaseRef = db.collection("purchases").doc(purchaseId);
    const purchaseSnap = await purchaseRef.get();
    if (!purchaseSnap.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Purchase not found");
    }
    const purchase = purchaseSnap.data() as Record<string, unknown>;

    if (purchase["studioOwnerId"] !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Not authorized to refund this purchase");
    }

    if (purchase["status"] === "refunded") {
      return sendErrorResponse(req, res, 400, "Conflict", "This purchase has already been refunded");
    }

    const stripePaymentIntentId = purchase["stripePaymentIntentId"] as string | undefined;
    const creditIds = purchase["creditIds"] as string[] | undefined;
    const studentId = purchase["studentId"] as string;
    const creditsGranted = purchase["creditsGranted"] as number | undefined;

    if (!stripePaymentIntentId || !stripePaymentIntentId.startsWith("pi_")) {
      return sendErrorResponse(req, res, 400, "Validation Error", "This was a cash purchase and cannot be refunded through Stripe");
    }

    await stripeService.createRefund(stripePaymentIntentId, reason || "");

    if (creditIds && creditIds.length > 0 && creditsGranted && creditsGranted > 0) {
      await creditTrackingService.removeCredits(studentId, studioOwnerId, creditsGranted);
    }

    await purchaseRef.update({
      status: "refunded",
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundReason: reason || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, { message: "Refund processed successfully" });
  } catch (error) {
    console.error("Error processing refund:", error);
    handleError(req, res, error);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(_req, res, err));

export const purchases = functions.https.onRequest(app);
