const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const {verifyToken} = require("./utils/auth");
const {getFirestore} = require("./utils/firestore");
const stripeService = require("./services/stripe.service");
const purchaseService = require("./services/purchase.service");
const creditTrackingService = require("./services/credit-tracking.service");
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

app.use(express.json());
app.use(express.urlencoded({extended: true}));


/**
 * POST /create-payment-link
 * Create a Stripe Payment Link for purchasing classes, events, workshops, or packages
 */
app.post("/create-payment-link", async (req, res) => {
  try {
    const {purchaseType, itemId, selectedTiers, guestInfo} = req.body;

    if (!purchaseType || !itemId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "purchaseType and itemId are required");
    }

    if (!["class", "event", "workshop", "package"].includes(purchaseType)) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid purchaseType. Must be 'class', 'event', 'workshop', or 'package'");
    }

    // Auth is required for packages; optional for classes, events, and workshops (guest checkout allowed)
    let user = null;
    try {
      user = await verifyToken(req);
    } catch (error) {
      if (purchaseType === "package") {
        return sendErrorResponse(req, res, 401, "Authentication Failed", "Login required to purchase packages.");
      }
      // classes / events / workshops continue as guest
    }

    const db = getFirestore();

    // Student profile — only looked up for authenticated users
    let studentDoc = null;
    if (user) {
      const studentQuery = await db.collection("students")
          .where("authUid", "==", user.uid)
          .limit(1)
          .get();
      if (!studentQuery.empty) {
        studentDoc = studentQuery.docs[0];
      }
    }

    // Get item details and price (studioOwnerId will be determined from the item)
    const itemDetails = await purchaseService.getItemDetails(purchaseType, itemId);

    // Get studio owner's Stripe connected account ID
    const studioOwnerRef = db.collection("users").doc(itemDetails.studioOwnerId);
    const studioOwnerDoc = await studioOwnerRef.get();

    if (!studioOwnerDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Studio owner not found");
    }

    const studioOwnerData = studioOwnerDoc.data();
    // May be null if studio owner hasn't completed Stripe Connect setup — charges will go to the platform account in that case
    const connectedAccountId = studioOwnerData.stripeAccountId || null;

    // Get or create Stripe customer — only for authenticated users
    let customerId = null;
    if (user) {
      const userQuery = await db.collection("users")
          .where("authUid", "==", user.uid)
          .limit(1)
          .get();

      if (!userQuery.empty) {
        const userDoc = userQuery.docs[0];
        const userData = userDoc.data();
        if (userData.stripeCustomerId) {
          customerId = userData.stripeCustomerId;
        } else {
          const customer = await stripeService.createCustomer(userData.email, {
            userId: userDoc.id,
            authUid: user.uid,
          });
          customerId = customer.id;
          await userDoc.ref.update({
            stripeCustomerId: customer.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } else {
        const studentProfileDoc = await require("./services/auth.service").getStudentProfileByAuthUid(user.uid);
        if (studentProfileDoc) {
          const profileData = studentProfileDoc.data();
          const email = profileData.email || `${user.uid}@temp.com`;
          const customer = await stripeService.createCustomer(email, {authUid: user.uid});
          customerId = customer.id;
        }
      }
    }

    // Check if this is a recurring package purchase
    const isRecurring = purchaseType === "package" && itemDetails.isRecurring === true;

    // Get origin for success/cancel URLs
    const origin = req.headers.origin || req.headers.referer?.split("/").slice(0, 3).join("/") || process.env.FRONTEND_URL || "https://users.danceup.com";
    const successUrl = `${origin}/purchases/confirmation?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/purchases/confirmation?canceled=true`;

    // Create metadata for the checkout session
    const metadata = {
      purchaseType,
      itemId,
      itemName: itemDetails.itemName || "",
      studioOwnerId: itemDetails.studioOwnerId,
      studioName: itemDetails.studioName || "",
      studentId: studentDoc ? studentDoc.id : "guest",
      authUid: user ? user.uid : "guest",
    };

    // Flat $0.50 platform fee on every credit card charge
    const applicationFeeAmount = 50;

    let checkoutSession;

    if (isRecurring) {
      // Create recurring price for subscription
      const stripe = await stripeService.getStripeClient();
      
      // Map billing frequency to Stripe interval
      let interval;
      let intervalCount = itemDetails.billingInterval || 1;
      
      if (itemDetails.billingFrequency === 'monthly') {
        interval = 'month';
      } else if (itemDetails.billingFrequency === 'weekly') {
        interval = 'week';
      } else if (itemDetails.billingFrequency === 'daily') {
        interval = 'day';
      } else if (typeof itemDetails.billingFrequency === 'number') {
        // Custom days - use day interval with the number as interval count
        interval = 'day';
        intervalCount = itemDetails.billingFrequency;
      } else {
        // Default to monthly
        interval = 'month';
      }

      const price = await stripe.prices.create({
        unit_amount: Math.round(itemDetails.price * 100), // Convert to cents
        currency: "usd",
        recurring: {
          interval: interval,
          interval_count: intervalCount,
        },
        product_data: {
          name: itemDetails.itemName,
          metadata: {
            purchaseType,
            itemId,
            studioOwnerId: itemDetails.studioOwnerId,
            studentId: studentDoc ? studentDoc.id : "guest",
          },
        },
      });

      // Create Subscription Checkout Session with Stripe Connect
      // Include billing information in metadata for webhook processing
      // Note: cancel_after cannot be set in checkout session, it will be set after subscription creation
      const subscriptionMetadata = {
        ...metadata,
        price: itemDetails.price,
        billingFrequency: itemDetails.billingFrequency,
        billingInterval: itemDetails.billingInterval,
        subscriptionDuration: itemDetails.subscriptionDuration,
      };
      
      checkoutSession = await stripeService.createConnectSubscriptionSession(
          price.id,
          customerId,
          connectedAccountId,
          subscriptionMetadata,
          successUrl,
          cancelUrl,
          applicationFeeAmount,
      );
    } else {
      // Create one-time price for regular purchase
      const stripe = await stripeService.getStripeClient();
      const price = await stripe.prices.create({
        unit_amount: Math.round(itemDetails.price * 100), // Convert to cents
        currency: "usd",
        product_data: {
          name: itemDetails.itemName,
          metadata: {
            purchaseType,
            itemId,
            studioOwnerId: itemDetails.studioOwnerId,
            studentId: studentDoc ? studentDoc.id : "guest",
          },
        },
      });

      // Create Checkout Session with Stripe Connect (payments go to studio owner's connected account)
      checkoutSession = await stripeService.createConnectCheckoutSession(
          price.id,
          customerId,
          connectedAccountId,
          metadata,
          successUrl,
          cancelUrl,
          applicationFeeAmount,
      );
    }

    sendJsonResponse(req, res, 200, {
      url: checkoutSession.url,
      id: checkoutSession.id,
    });
  } catch (error) {
    console.error("Create Payment Link error:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /charge-saved
 * Charge a user's saved Stripe payment method directly — no Checkout redirect needed.
 * Body: { purchaseType, itemId, paymentMethodId }
 * Returns: { success, purchaseId, creditsGranted, isRecurring, subscriptionId }
 *       or { requiresAction, clientSecret } when 3DS authentication is needed.
 */
app.post("/charge-saved", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const {purchaseType, itemId, paymentMethodId} = req.body;
    if (!purchaseType || !itemId || !paymentMethodId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "purchaseType, itemId, and paymentMethodId are required");
    }

    const db = getFirestore();

    // Get student from the `students` collection — this is the ID used by credit tracking
    const studentQuery = await db.collection("students")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (studentQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student profile not found. Please enroll in a studio first.");
    }

    const studentDoc = studentQuery.docs[0];
    const studentData = studentDoc.data();

    // Resolve Stripe customer ID — mirrors the lookup in /create-payment-link
    let stripeCustomerId = null;
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();

    if (!userQuery.empty) {
      stripeCustomerId = userQuery.docs[0].data().stripeCustomerId || null;
    }

    if (!stripeCustomerId) {
      // Fall back to usersStudentProfiles (users registered via the users-app)
      const authService = require("./services/auth.service");
      const profileDoc = await authService.getStudentProfileByAuthUid(user.uid);
      stripeCustomerId = profileDoc ? (profileDoc.data().stripeCustomerId || null) : null;
    }

    if (!stripeCustomerId) {
      return sendErrorResponse(req, res, 400, "Bad Request", "No Stripe customer linked to this account. Please add a payment method first.");
    }

    // Verify the payment method belongs to this customer
    const savedMethods = await stripeService.listPaymentMethods(stripeCustomerId);
    if (!savedMethods.some((pm) => pm.id === paymentMethodId)) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Payment method does not belong to this account");
    }

    // Get item details
    const itemDetails = await purchaseService.getItemDetails(purchaseType, itemId);
    const studioOwnerId = itemDetails.studioOwnerId;

    // Optional Stripe Connect destination
    const studioOwnerDoc = await db.collection("users").doc(studioOwnerId).get();
    const connectedAccountId = studioOwnerDoc.exists ? (studioOwnerDoc.data().stripeAccountId || null) : null;

    const isRecurring = purchaseType === "package" && itemDetails.isRecurring === true;
    const metadata = {
      purchaseType,
      itemId,
      studioOwnerId,
      studentId: studentDoc.id,
      authUid: user.uid,
    };

    let paymentIntentId;
    let subscriptionId = null;
    let subscriptionStatus = null;

    if (isRecurring) {
      // Build price params (mirrors the logic in /create-payment-link)
      let interval = "month";
      let intervalCount = itemDetails.billingInterval || 1;
      if (itemDetails.billingFrequency === "weekly") {
        interval = "week";
      } else if (itemDetails.billingFrequency === "daily") {
        interval = "day";
      } else if (typeof itemDetails.billingFrequency === "number") {
        interval = "day";
        intervalCount = itemDetails.billingFrequency;
      }

      const priceParams = {
        unit_amount: Math.round(itemDetails.price * 100),
        currency: "usd",
        recurring: {interval, interval_count: intervalCount},
        product_data: {
          name: itemDetails.itemName,
          metadata: {purchaseType, itemId, studioOwnerId, studentId: studentDoc.id},
        },
      };

      const subscription = await stripeService.createSubscriptionWithSavedCard(
          stripeCustomerId,
          priceParams,
          paymentMethodId,
          {...metadata, price: itemDetails.price, billingFrequency: itemDetails.billingFrequency, billingInterval: itemDetails.billingInterval},
          connectedAccountId,
      );

      const latestInvoicePI = subscription.latest_invoice?.payment_intent;

      if (latestInvoicePI?.status === "requires_action") {
        return sendJsonResponse(req, res, 200, {
          requiresAction: true,
          clientSecret: latestInvoicePI.client_secret,
          subscriptionId: subscription.id,
        });
      }

      if (latestInvoicePI?.status !== "succeeded" && subscription.status !== "active") {
        return sendErrorResponse(req, res, 402, "Payment Failed", "Subscription payment failed. Please try a different card.");
      }

      subscriptionId = subscription.id;
      subscriptionStatus = subscription.status;
      paymentIntentId = latestInvoicePI?.id;
    } else {
      // One-time payment
      const paymentIntent = await stripeService.chargePaymentMethodDirectly(
          stripeCustomerId,
          paymentMethodId,
          Math.round(itemDetails.price * 100),
          metadata,
          connectedAccountId,
      );

      if (paymentIntent.status === "requires_action") {
        return sendJsonResponse(req, res, 200, {
          requiresAction: true,
          clientSecret: paymentIntent.client_secret,
        });
      }

      if (paymentIntent.status !== "succeeded") {
        return sendErrorResponse(req, res, 402, "Payment Failed", "Payment could not be completed. Please try a different card.");
      }

      paymentIntentId = paymentIntent.id;
    }

    // Grant credits
    const creditResult = await purchaseService.grantCreditsForPurchase(
        purchaseType,
        studentDoc.id,
        studioOwnerId,
        itemDetails,
    );

    // Create purchase record
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
      stripeCustomerId,
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

    // Notify studio owner (non-fatal)
    try {
      await purchaseService.createPurchaseNotification({
        studioOwnerId,
        studentId: studentDoc.id,
        studentName: `${studentData.firstName || ""} ${studentData.lastName || ""}`.trim() || studentData.email,
        purchaseType,
        itemName: itemDetails.itemName,
      });
    } catch (notifyErr) {
      console.error("Error creating purchase notification:", notifyErr);
    }

    // Send confirmation email to the buyer (non-fatal)
    try {
      const sendgridService = require("./services/sendgrid.service");
      const authService = require("./services/auth.service");
      const profileDoc = await authService.getStudentProfileByAuthUid(user.uid);
      const recipientEmail = profileDoc ? profileDoc.data().email : null;

      if (recipientEmail) {
        const emailDetails = {
          itemName: itemDetails.itemName,
          studioName: itemDetails.studioName,
          amountPaid: itemDetails.price?.toFixed(2),
        };

        if (purchaseType === "package") {
          const expirationDays = itemDetails.metadata?.expirationDays;
          if (expirationDays) {
            const expirationDate = new Date();
            expirationDate.setDate(expirationDate.getDate() + expirationDays);
            emailDetails.packageName = itemDetails.itemName;
            emailDetails.creditsAdded = creditResult.creditsGranted;
            emailDetails.expirationDate = expirationDate.toLocaleDateString("en-US", {year: "numeric", month: "long", day: "numeric"});
          } else {
            emailDetails.packageName = itemDetails.itemName;
            emailDetails.creditsAdded = creditResult.creditsGranted;
          }
        }

        await sendgridService.sendConfirmationEmail(recipientEmail, purchaseType, emailDetails);
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


/**
 * POST /success
 * Handle successful payment completion
 * Called from frontend after Stripe redirect
 * Accepts either payment_intent or session_id (for Payment Links)
 */
app.post("/success", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const {paymentIntentId, sessionId} = req.body;

    if (!paymentIntentId && !sessionId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "paymentIntentId or sessionId is required");
    }

    const stripe = await stripeService.getStripeClient();
    let paymentIntent;
    let metadata = {};

    if (sessionId) {
      // Payment Link creates a checkout session
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['payment_intent', 'subscription', 'line_items']
      });
      
      if (session.payment_status !== "paid") {
        return sendErrorResponse(req, res, 400, "Validation Error", "Payment not completed");
      }
      
      // Try to get metadata from session first (Payment Links store metadata here)
      metadata = session.metadata || {};
      
      // Check if this is a subscription (recurring package)
      if (session.mode === "subscription" && session.subscription) {
        const subscriptionId = typeof session.subscription === 'string' 
          ? session.subscription 
          : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        
        // Get metadata from subscription if not in session
        if (!metadata || Object.keys(metadata).length === 0) {
          metadata = subscription.metadata || {};
        }
        
        // Store subscription ID in metadata for later use
        metadata.stripeSubscriptionId = subscriptionId;
      }
      
      // Get payment intent from session (for one-time payments)
      if (session.payment_intent) {
        const paymentIntentId = typeof session.payment_intent === 'string' 
          ? session.payment_intent 
          : session.payment_intent.id;
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        // If metadata not on session, try payment intent
        if (!metadata || Object.keys(metadata).length === 0) {
          metadata = paymentIntent.metadata || {};
        }
      }
      
      // If still no metadata, try to get from line items (product metadata)
      if ((!metadata || Object.keys(metadata).length === 0)) {
        try {
          const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
            expand: ['data.price.product']
          });
          if (lineItems.data.length > 0) {
            const product = lineItems.data[0].price?.product;
            if (typeof product === 'object' && product.metadata) {
              metadata = product.metadata;
            }
          }
        } catch (lineItemsError) {
          console.warn('Error fetching line items:', lineItemsError);
        }
      }
    } else {
      // Direct payment intent
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.status !== "succeeded") {
        return sendErrorResponse(req, res, 400, "Validation Error", "Payment not completed");
      }
      metadata = paymentIntent.metadata || {};
    }

    // Log metadata for debugging
    console.log('[Purchase Success] Initial metadata:', {
      sessionId,
      paymentIntentId,
      metadata,
      metadataKeys: Object.keys(metadata),
    });

    let purchaseType = metadata.purchaseType;
    let itemId = metadata.itemId;
    let studioOwnerId = metadata.studioOwnerId;
    let studentId = metadata.studentId;

    // If metadata is still missing, try to get from the product metadata (stored in price creation)
    if (!purchaseType || !itemId || !studioOwnerId || !studentId) {
      console.log('[Purchase Success] Metadata missing from session/payment intent, checking product metadata');
      
      if (sessionId) {
        try {
          // Get line items with expanded product to access product metadata
          const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
            expand: ['data.price.product']
          });
          
          console.log('[Purchase Success] Line items:', lineItems.data.length);
          
          if (lineItems.data.length > 0) {
            const lineItem = lineItems.data[0];
            const product = lineItem.price?.product;
            
            console.log('[Purchase Success] Product:', {
              productType: typeof product,
              productId: typeof product === 'object' ? product.id : product,
              productMetadata: typeof product === 'object' ? product.metadata : null,
            });
            
            if (typeof product === 'object' && product.metadata) {
              console.log('[Purchase Success] Found metadata in product:', product.metadata);
              purchaseType = purchaseType || product.metadata.purchaseType;
              itemId = itemId || product.metadata.itemId;
              studioOwnerId = studioOwnerId || product.metadata.studioOwnerId;
              studentId = studentId || product.metadata.studentId;
            }
          }
        } catch (error) {
          console.error('[Purchase Success] Error retrieving product metadata:', error);
        }
      }
    }

    if (!purchaseType || !itemId || !studioOwnerId || !studentId) {
      console.error('[Purchase Success] Missing purchase metadata after all attempts:', {
        purchaseType,
        itemId,
        studioOwnerId,
        studentId,
        sessionId,
        paymentIntentId,
      });
      return sendErrorResponse(req, res, 400, "Validation Error", "Missing purchase metadata. Please contact support with your payment confirmation.");
    }

    // Check if purchase already exists (idempotency)
    const db = getFirestore();
    const existingPurchase = await db.collection("purchases")
        .where("stripePaymentIntentId", "==", paymentIntent?.id || sessionId)
        .limit(1)
        .get();

    if (!existingPurchase.empty) {
      // Purchase already processed
      const existingDoc = existingPurchase.docs[0];
      return sendJsonResponse(req, res, 200, {
        message: "Purchase already processed",
        purchaseId: existingDoc.id,
        creditsGranted: existingDoc.data().creditsGranted || 0,
      });
    }

    // Verify the studentId in metadata matches a student record for this user
    // Students can purchase from any studio, so we just need to verify the studentId belongs to this user
    const studentRef = db.collection("students").doc(studentId);
    const studentDoc = await studentRef.get();
    
    if (!studentDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student record not found");
    }
    
    const studentData = studentDoc.data();
    if (studentData.authUid !== user.uid) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Purchase does not belong to this user");
    }
    
    // Get student info for notifications
    const studentProfileDoc = await require("./services/auth.service").getStudentProfileByAuthUid(user.uid);
    let studentName = null;
    if (studentProfileDoc) {
      const profileData = studentProfileDoc.data();
      const firstName = profileData.firstName || "";
      const lastName = profileData.lastName || "";
      studentName = `${firstName} ${lastName}`.trim() || null;
    }
    
    const studentInfo = {
      studentId: studentId,
      studentName: studentName || studentData.email || "Student",
    };

    // Get item details (studioOwnerId is determined from the item itself)
    const itemDetails = await purchaseService.getItemDetails(purchaseType, itemId);
    
    // Verify the studioOwnerId from metadata matches the item's studioOwnerId
    if (itemDetails.studioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Studio owner ID mismatch");
    }

    // Check if this is a subscription (recurring package)
    const isRecurring = purchaseType === "package" && itemDetails.isRecurring === true;
    const subscriptionId = metadata.stripeSubscriptionId || null;
    let subscriptionStatus = null;
    
    if (isRecurring && subscriptionId) {
      // Get subscription status from Stripe
      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        subscriptionStatus = subscription.status; // 'active', 'canceled', 'past_due', etc.
        
        // Set cancel_at if subscriptionDuration is specified
        // cancel_at is a Unix timestamp (seconds) specifying when to cancel
        // This must be done after subscription creation (not in checkout session)
        if (itemDetails.subscriptionDuration && itemDetails.subscriptionDuration > 0) {
          try {
            // Calculate cancel_at timestamp based on subscription duration and billing frequency
            // Start from current_period_end and add the appropriate number of periods
            // Note: The first payment already occurred, so we need (duration - 1) more periods
            // Example: For duration=6, we want payments 1-6, so we add 5 more periods after the first
            const currentPeriodEnd = subscription.current_period_end; // Unix timestamp in seconds
            const duration = itemDetails.subscriptionDuration;
            const billingFrequency = itemDetails.billingFrequency;
            const billingInterval = itemDetails.billingInterval || 1;
            
            // Calculate periods to add: (duration - 1) because first payment already occurred
            const periodsToAdd = (duration - 1) * billingInterval;
            
            // Calculate milliseconds to add based on billing frequency
            let millisecondsToAdd = 0;
            
            if (billingFrequency === 'monthly') {
              // Add months: periodsToAdd months
              const cancelDate = new Date(currentPeriodEnd * 1000);
              cancelDate.setMonth(cancelDate.getMonth() + periodsToAdd);
              millisecondsToAdd = cancelDate.getTime() - (currentPeriodEnd * 1000);
            } else if (billingFrequency === 'weekly') {
              // Add weeks: periodsToAdd weeks
              millisecondsToAdd = periodsToAdd * 7 * 24 * 60 * 60 * 1000;
            } else if (billingFrequency === 'daily') {
              // Add days: periodsToAdd days
              millisecondsToAdd = periodsToAdd * 24 * 60 * 60 * 1000;
            } else if (typeof billingFrequency === 'number') {
              // Custom days: periodsToAdd * billingFrequency days
              const daysToAdd = periodsToAdd * billingFrequency;
              millisecondsToAdd = daysToAdd * 24 * 60 * 60 * 1000;
            } else {
              // Default to monthly
              const cancelDate = new Date(currentPeriodEnd * 1000);
              cancelDate.setMonth(cancelDate.getMonth() + periodsToAdd);
              millisecondsToAdd = cancelDate.getTime() - (currentPeriodEnd * 1000);
            }
            
            // Calculate cancel_at timestamp (Unix timestamp in seconds)
            const cancelAt = Math.floor((currentPeriodEnd * 1000 + millisecondsToAdd) / 1000);
            
            await stripe.subscriptions.update(subscriptionId, {
              cancel_at: cancelAt,
            });
            console.log(`[Purchase Success] Set subscription ${subscriptionId} to cancel at ${new Date(cancelAt * 1000).toISOString()} (after ${duration} billing cycles)`);
          } catch (cancelError) {
            console.error("Error setting subscription cancel_at:", cancelError);
            // Don't fail the purchase if cancel_at setting fails
          }
        }
      } catch (error) {
        console.error("Error retrieving subscription:", error);
        subscriptionStatus = "active"; // Default to active if we can't retrieve
      }
    }

    // Grant credits (if applicable) - only on initial purchase, not renewals
    // Renewals will be handled by webhook
    const creditResult = await purchaseService.grantCreditsForPurchase(
        purchaseType,
        studentId,
        studioOwnerId,
        itemDetails
    );

    // Create purchase record
    const purchaseId = await purchaseService.createPurchaseRecord({
      studentId: studentId,
      authUid: user.uid,
      purchaseType,
      itemId,
      studioOwnerId,
      itemName: itemDetails.itemName,
      studioName: itemDetails.studioName,
      price: itemDetails.price,
      stripePaymentIntentId: paymentIntent?.id || sessionId,
      stripeCustomerId: paymentIntent?.customer || null,
      stripeSubscriptionId: subscriptionId,
      isRecurring: isRecurring,
      subscriptionStatus: subscriptionStatus,
      status: "completed",
      creditGranted: creditResult.creditsGranted > 0,
      creditsGranted: creditResult.creditsGranted,
      creditIds: creditResult.creditIds,
      classId: purchaseType === "class" ? itemId : null,
      metadata: itemDetails.metadata,
    });

    // Create notification for studio owner
    try {
      await purchaseService.createPurchaseNotification({
        studioOwnerId,
        studentId: studentId,
        studentName: studentInfo.studentName,
        purchaseType,
        itemName: itemDetails.itemName,
      });
    } catch (notificationError) {
      // Log but don't fail the purchase
      console.error("Error creating notification:", notificationError);
    }

    sendJsonResponse(req, res, 200, {
      message: "Purchase completed successfully",
      purchaseId,
      creditsGranted: creditResult.creditsGranted,
      isRecurring: isRecurring,
      subscriptionId: subscriptionId,
    });
  } catch (error) {
    console.error("Purchase success error:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /
 * Get purchase history for authenticated user
 */
app.get("/", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const {type, limit, startAfter} = req.query;
    const limitNum = parseInt(limit) || 50;
    const purchaseType = type && ["class", "event", "workshop", "package"].includes(type) ? type : null;

    // Get student documents for this user
    const db = getFirestore();
    const studentsRef = db.collection("students");
    const studentSnapshot = await studentsRef
        .where("authUid", "==", user.uid)
        .get();

    if (studentSnapshot.empty) {
      return sendJsonResponse(req, res, 200, []);
    }

    const studentIds = studentSnapshot.docs.map((doc) => doc.id);

    // Query purchases
    let purchasesQuery = db.collection("purchases")
        .where("authUid", "==", user.uid)
        .orderBy("createdAt", "desc")
        .limit(limitNum);

    if (purchaseType) {
      purchasesQuery = purchasesQuery.where("purchaseType", "==", purchaseType);
    }

    if (startAfter) {
      const startAfterDoc = await db.collection("purchases").doc(startAfter).get();
      if (startAfterDoc.exists) {
        purchasesQuery = purchasesQuery.startAfter(startAfterDoc);
      }
    }

    const purchasesSnapshot = await purchasesQuery.get();
    const purchases = purchasesSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    sendJsonResponse(req, res, 200, purchases);
  } catch (error) {
    console.error("Get purchase history error:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /student/:studentId
 * Get purchase history for a specific student (for studio owners)
 */
app.get("/student/:studentId", async (req, res) => {
  try {
    // Verify token and get user info
    let user;
    try {
      user = await verifyToken(req);
    } catch (error) {
      return sendErrorResponse(req, res, 401, "Authentication Failed", "Invalid or expired token");
    }

    const {studentId} = req.params;
    const {type, limit, startAfter} = req.query;
    const limitNum = parseInt(limit) || 50;
    const purchaseType = type && ["class", "event", "workshop", "package"].includes(type) ? type : null;

    // Verify studio owner
    const studioOwnerId = await require("./services/classes.service").getStudioOwnerId(user.uid);
    if (!studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }

    // Verify student belongs to studio owner
    const db = getFirestore();
    const studentRef = db.collection("students").doc(studentId);
    const studentDoc = await studentRef.get();

    if (!studentDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Student not found");
    }

    const studentData = studentDoc.data();
    if (studentData.studioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Student does not belong to this studio");
    }

    // Query purchases
    let purchasesQuery = db.collection("purchases")
        .where("studentId", "==", studentId)
        .orderBy("createdAt", "desc")
        .limit(limitNum);

    if (purchaseType) {
      purchasesQuery = purchasesQuery.where("purchaseType", "==", purchaseType);
    }

    if (startAfter) {
      const startAfterDoc = await db.collection("purchases").doc(startAfter).get();
      if (startAfterDoc.exists) {
        purchasesQuery = purchasesQuery.startAfter(startAfterDoc);
      }
    }

    const purchasesSnapshot = await purchasesQuery.get();
    const purchases = purchasesSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    sendJsonResponse(req, res, 200, purchases);
  } catch (error) {
    console.error("Get student purchase history error:", error);
    handleError(req, res, error);
  }
});


/**
 * GET /subscriptions
 * Get all active subscriptions for the authenticated user
 */
app.get("/subscriptions", async (req, res) => {
  try {
    const user = await verifyToken(req);

    const db = getFirestore();
    
    // Get all purchases that are recurring subscriptions
    const purchasesQuery = await db.collection("purchases")
        .where("authUid", "==", user.uid)
        .where("isRecurring", "==", true)
        .where("subscriptionStatus", "in", ["active", "trialing"])
        .get();

    const subscriptions = [];
    const stripe = await stripeService.getStripeClient();

    for (const purchaseDoc of purchasesQuery.docs) {
      const purchaseData = purchaseDoc.data();
      const subscriptionId = purchaseData.stripeSubscriptionId;

      if (!subscriptionId) {
        continue;
      }

      // For package purchases, look up the current package to get the latest allowCancellation setting
      let allowCancellation = true; // Default to true
      if (purchaseData.purchaseType === "package" && purchaseData.itemId) {
        try {
          const packageRef = db.collection("packages").doc(purchaseData.itemId);
          const packageDoc = await packageRef.get();
          if (packageDoc.exists) {
            const packageData = packageDoc.data();
            allowCancellation = packageData.allowCancellation !== undefined ? packageData.allowCancellation : true;
          } else {
            // Package not found, fall back to metadata value
            allowCancellation = purchaseData.metadata?.allowCancellation !== undefined ? purchaseData.metadata.allowCancellation : true;
          }
        } catch (packageError) {
          console.error(`Error retrieving package ${purchaseData.itemId}:`, packageError);
          // Fall back to metadata value if package lookup fails
          allowCancellation = purchaseData.metadata?.allowCancellation !== undefined ? purchaseData.metadata.allowCancellation : true;
        }
      } else {
        // For non-package purchases, use metadata value
        allowCancellation = purchaseData.metadata?.allowCancellation !== undefined ? purchaseData.metadata.allowCancellation : true;
      }

      try {
        // Get subscription details from Stripe
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        
        // Get next billing date
        const nextBillingDate = subscription.current_period_end 
          ? new Date(subscription.current_period_end * 1000)
          : null;

        subscriptions.push({
          id: purchaseDoc.id,
          purchaseId: purchaseDoc.id,
          subscriptionId: subscriptionId,
          packageName: purchaseData.itemName,
          studioName: purchaseData.studioName,
          price: purchaseData.price,
          status: subscription.status,
          nextBillingDate: nextBillingDate?.toISOString() || null,
          billingFrequency: purchaseData.metadata?.billingFrequency || null,
          billingInterval: purchaseData.metadata?.billingInterval || 1,
          allowCancellation: allowCancellation,
          createdAt: purchaseData.createdAt,
        });
      } catch (error) {
        console.error(`Error retrieving subscription ${subscriptionId}:`, error);
        // Include subscription even if Stripe retrieval fails
        subscriptions.push({
          id: purchaseDoc.id,
          purchaseId: purchaseDoc.id,
          subscriptionId: subscriptionId,
          packageName: purchaseData.itemName,
          studioName: purchaseData.studioName,
          price: purchaseData.price,
          status: purchaseData.subscriptionStatus || "unknown",
          nextBillingDate: null,
          billingFrequency: purchaseData.metadata?.billingFrequency || null,
          billingInterval: purchaseData.metadata?.billingInterval || 1,
          allowCancellation: allowCancellation,
          createdAt: purchaseData.createdAt,
        });
      }
    }

    sendJsonResponse(req, res, 200, subscriptions);
  } catch (error) {
    console.error("Error getting subscriptions:", error);
    handleError(req, res, error);
  }
});


/**
 * POST /subscriptions/:subscriptionId/cancel
 * Cancel a subscription
 */
app.post("/subscriptions/:subscriptionId/cancel", async (req, res) => {
  try {
    const user = await verifyToken(req);
    const {subscriptionId} = req.params;

    if (!subscriptionId) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Subscription ID is required");
    }

    // Verify the subscription belongs to this user
    const db = getFirestore();
    const purchaseQuery = await db.collection("purchases")
        .where("authUid", "==", user.uid)
        .where("stripeSubscriptionId", "==", subscriptionId)
        .limit(1)
        .get();

    if (purchaseQuery.empty) {
      return sendErrorResponse(req, res, 404, "Not Found", "Subscription not found");
    }

    // Cancel subscription in Stripe
    const stripe = await stripeService.getStripeClient();
    const canceledSubscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true, // Cancel at end of billing period
    });

    // Update purchase record
    const purchaseDoc = purchaseQuery.docs[0];
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

/**
 * GET /cash
 * List cash payments recorded by the authenticated studio owner
 * Query params: limit (default 50), startDate (ISO), endDate (ISO)
 */
app.get("/cash", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const db = getFirestore();

    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();
    if (userQuery.empty) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }
    const studioOwnerId = userQuery.docs[0].id;

    const limitParam = Math.min(parseInt(req.query.limit) || 50, 200);
    const {startDate, endDate} = req.query;

    let query = db.collection("cashPurchases")
        .where("studioOwnerId", "==", studioOwnerId)
        .orderBy("createdAt", "desc")
        .limit(limitParam);

    if (startDate) {
      query = query.where("createdAt", ">=", new Date(startDate));
    }
    if (endDate) {
      query = query.where("createdAt", "<=", new Date(endDate));
    }

    const snapshot = await query.get();
    const transactions = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
    }));

    sendJsonResponse(req, res, 200, {transactions, total: transactions.length});
  } catch (error) {
    console.error("Error fetching cash transactions:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /cash
 * Record a manual cash payment made outside of Stripe
 */
app.post("/cash", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const db = getFirestore();

    // Resolve studioOwnerId from the authenticated user
    const userQuery = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();
    if (userQuery.empty) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Studio owner not found");
    }
    const studioOwnerId = userQuery.docs[0].id;

    const {studentId, amount, description, itemType, itemId} = req.body;

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return sendErrorResponse(req, res, 400, "Validation Error", "amount must be a positive number");
    }

    const docData = {
      studioOwnerId,
      amount: parseFloat(amount),
      paymentMethod: "cash",
      status: "completed",
      source: "manual",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (studentId) docData.studentId = studentId;
    if (description) docData.description = description;
    if (itemType) docData.purchaseType = itemType;
    if (itemId) docData.itemId = itemId;

    // Optionally denormalize student name for display
    if (studentId) {
      try {
        const studentDoc = await db.collection("students").doc(studentId).get();
        if (studentDoc.exists) {
          const s = studentDoc.data();
          docData.studentName = [s.firstName, s.lastName].filter(Boolean).join(" ");
        }
      } catch (_) { /* non-critical */ }
    }

    const docRef = await db.collection("cashPurchases").add(docData);

    sendJsonResponse(req, res, 201, {id: docRef.id, message: "Cash payment recorded successfully"});
  } catch (error) {
    console.error("Error recording cash payment:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /:purchaseId/check-in
 * Mark an event or workshop purchase as checked in.
 * Studio owners can check in any attendee for their item.
 * Students can self-check-in for their own workshop/event purchase.
 */
app.post("/:purchaseId/check-in", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {purchaseId} = req.params;
    const db = getFirestore();

    const purchaseRef = db.collection("purchases").doc(purchaseId);
    const purchaseDoc = await purchaseRef.get();

    if (!purchaseDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Purchase not found");
    }

    const purchase = purchaseDoc.data();

    // Check if caller is the studio owner for this purchase
    const studioOwnerSnapshot = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();
    const isStudioOwner = !studioOwnerSnapshot.empty &&
      studioOwnerSnapshot.docs[0].id === purchase.studioOwnerId;

    // Or the student who owns this purchase
    const isOwnPurchase = purchase.authUid === user.uid;

    if (!isStudioOwner && !isOwnPurchase) {
      return sendErrorResponse(req, res, 403, "Access Denied", "You do not have permission to check in this attendee");
    }

    if (purchase.checkedIn) {
      return sendErrorResponse(req, res, 409, "Conflict", "Attendee is already checked in");
    }

    const checkedInBy = isStudioOwner ? "studio" : "student";

    await purchaseRef.update({
      checkedIn: true,
      checkedInAt: admin.firestore.FieldValue.serverTimestamp(),
      checkedInBy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {message: "Attendee checked in successfully"});
  } catch (error) {
    console.error("Error checking in attendee:", error);
    handleError(req, res, error);
  }
});

/**
 * POST /:purchaseId/check-out
 * Remove check-in for a purchase (studio owner only).
 */
app.post("/:purchaseId/check-out", async (req, res) => {
  try {
    let user;
    try {
      user = await verifyToken(req);
    } catch (authError) {
      return handleError(req, res, authError);
    }

    const {purchaseId} = req.params;
    const db = getFirestore();

    const purchaseRef = db.collection("purchases").doc(purchaseId);
    const purchaseDoc = await purchaseRef.get();

    if (!purchaseDoc.exists) {
      return sendErrorResponse(req, res, 404, "Not Found", "Purchase not found");
    }

    const purchase = purchaseDoc.data();

    // Only studio owner can remove a check-in
    const studioOwnerSnapshot = await db.collection("users")
        .where("authUid", "==", user.uid)
        .limit(1)
        .get();
    const isStudioOwner = !studioOwnerSnapshot.empty &&
      studioOwnerSnapshot.docs[0].id === purchase.studioOwnerId;

    if (!isStudioOwner) {
      return sendErrorResponse(req, res, 403, "Access Denied", "Only studio owners can remove a check-in");
    }

    await purchaseRef.update({
      checkedIn: false,
      checkedInAt: null,
      checkedInBy: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {message: "Check-in removed successfully"});
  } catch (error) {
    console.error("Error removing check-in:", error);
    handleError(req, res, error);
  }
});

// POST /:purchaseId/refund — refund a purchase (studio owner only)
app.post("/:purchaseId/refund", async (req, res) => {
  try {
    const decodedToken = await verifyToken(req);
    const authUid = decodedToken.uid;
    const {purchaseId} = req.params;
    const {reason} = req.body;

    const db = getFirestore();

    // Look up the studio owner record for the requesting user
    const studioOwnerSnapshot = await db
      .collection("studioOwners")
      .where("authUid", "==", authUid)
      .limit(1)
      .get();
    if (studioOwnerSnapshot.empty) {
      return sendErrorResponse(req, res, 403, "Not authorized");
    }
    const studioOwnerId = studioOwnerSnapshot.docs[0].id;

    // Fetch the purchase
    const purchaseRef = db.collection("purchases").doc(purchaseId);
    const purchaseSnap = await purchaseRef.get();
    if (!purchaseSnap.exists) {
      return sendErrorResponse(req, res, 404, "Purchase not found");
    }
    const purchase = purchaseSnap.data();

    // Verify ownership
    if (purchase.studioOwnerId !== studioOwnerId) {
      return sendErrorResponse(req, res, 403, "Not authorized to refund this purchase");
    }

    // Prevent double refund
    if (purchase.status === "refunded") {
      return sendErrorResponse(req, res, 400, "This purchase has already been refunded");
    }

    const {stripePaymentIntentId, creditIds, studentId, creditsGranted} = purchase;

    // Process Stripe refund if this was a card payment
    if (!stripePaymentIntentId || !stripePaymentIntentId.startsWith("pi_")) {
      return sendErrorResponse(req, res, 400, "This was a cash purchase and cannot be refunded through Stripe");
    }

    await stripeService.createRefund(stripePaymentIntentId, reason);

    // Revoke credits if this was a package purchase
    if (creditIds && creditIds.length > 0 && creditsGranted > 0) {
      await creditTrackingService.removeCredits(studentId, studioOwnerId, creditsGranted);
    }

    // Mark purchase as refunded
    await purchaseRef.update({
      status: "refunded",
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundReason: reason || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJsonResponse(req, res, 200, {message: "Refund processed successfully"});
  } catch (error) {
    console.error("Error processing refund:", error);
    handleError(req, res, error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  handleError(req, res, err);
});

// Export Express app as Firebase Function
exports.purchases = functions.https.onRequest(app);

