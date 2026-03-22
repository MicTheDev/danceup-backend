const Stripe = require("stripe");
const {getSecret} = require("../utils/secret-manager");

let stripeClient = null;

/**
 * Get or initialize Stripe client
 * @returns {Promise<Stripe>} Stripe client instance
 */
async function getStripeClient() {
  if (stripeClient) {
    return stripeClient;
  }

  try {
    // Get secret key from Secret Manager
    // Determine environment from project ID or use test by default
    const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
    const isProduction = projectId.includes("production");
    const secretName = isProduction
      ? "stripe-secret-key-prod"
      : "stripe-secret-key-test";

    const secretKey = await getSecret(secretName);

    if (!secretKey) {
      throw new Error("Stripe secret key not found in Secret Manager");
    }

    // Trim whitespace and newlines from the secret key
    const trimmedSecretKey = secretKey.trim();

    // Validate the key format (should start with sk_test_ or sk_live_)
    if (!trimmedSecretKey.startsWith("sk_test_") && !trimmedSecretKey.startsWith("sk_live_")) {
      throw new Error("Invalid Stripe secret key format");
    }

    // Initialize Stripe client - let it use default API version
    stripeClient = new Stripe(trimmedSecretKey);

    return stripeClient;
  } catch (error) {
    console.error("Error initializing Stripe client:", error);
    throw new Error(`Failed to initialize Stripe: ${error.message}`);
  }
}

/**
 * Create a Stripe Connect account
 * @param {string} email - User's email address
 * @param {Object} metadata - Additional metadata to store with the account
 * @returns {Promise<Stripe.Account>} Created Stripe account
 */
async function createConnectedAccount(email, metadata = {}) {
  const stripe = await getStripeClient();

  try {
    const account = await stripe.accounts.create({
      type: "express",
      country: "US", // Default to US, can be made configurable
      email,
      capabilities: {
        card_payments: {requested: true},
        transfers: {requested: true},
      },
      metadata,
    });

    return account;
  } catch (error) {
    console.error("Error creating Stripe Connect account:", error);
    // Log more details about the error
    if (error.type) {
      console.error("Stripe error type:", error.type);
    }
    if (error.code) {
      console.error("Stripe error code:", error.code);
    }
    if (error.raw) {
      console.error("Stripe raw error:", JSON.stringify(error.raw, null, 2));
    }
    throw new Error(`Failed to create Stripe account: ${error.message}`);
  }
}

/**
 * Create an account link for onboarding
 * @param {string} accountId - Stripe account ID
 * @param {string} returnUrl - URL to redirect to after onboarding
 * @param {string} refreshUrl - URL to redirect to if user needs to refresh
 * @returns {Promise<Stripe.AccountLink>} Account link object
 */
async function createAccountLink(accountId, returnUrl, refreshUrl) {
  const stripe = await getStripeClient();

  try {
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: "account_onboarding",
    });

    return accountLink;
  } catch (error) {
    console.error("Error creating Stripe account link:", error);
    throw new Error(`Failed to create account link: ${error.message}`);
  }
}

/**
 * Get Stripe account details
 * @param {string} accountId - Stripe account ID
 * @returns {Promise<Stripe.Account>} Stripe account object
 */
async function getAccount(accountId) {
  const stripe = await getStripeClient();

  try {
    const account = await stripe.accounts.retrieve(accountId);
    return account;
  } catch (error) {
    console.error("Error retrieving Stripe account:", error);
    throw new Error(`Failed to retrieve account: ${error.message}`);
  }
}

/**
 * Update account metadata
 * @param {string} accountId - Stripe account ID
 * @param {Object} metadata - Metadata to update
 * @returns {Promise<Stripe.Account>} Updated Stripe account
 */
async function updateAccountMetadata(accountId, metadata) {
  const stripe = await getStripeClient();

  try {
    const account = await stripe.accounts.update(accountId, {
      metadata,
    });

    return account;
  } catch (error) {
    console.error("Error updating Stripe account metadata:", error);
    throw new Error(`Failed to update account metadata: ${error.message}`);
  }
}

/**
 * Create a login link for Stripe Express dashboard
 * @param {string} accountId - Stripe account ID
 * @returns {Promise<Stripe.LoginLink>} Login link object
 */
async function createLoginLink(accountId) {
  const stripe = await getStripeClient();

  try {
    const loginLink = await stripe.accounts.createLoginLink(accountId);
    return loginLink;
  } catch (error) {
    console.error("Error creating Stripe login link:", error);
    throw new Error(`Failed to create login link: ${error.message}`);
  }
}

/**
 * Get all products and their prices from Stripe
 * Maps products to membership tiers
 * @returns {Promise<Array>} Array of products with prices
 */
async function getProducts() {
  const stripe = await getStripeClient();

  try {
    // Fetch all active products
    const products = await stripe.products.list({
      active: true,
      limit: 100,
    });

    console.log(`[getProducts] Found ${products.data.length} active products from Stripe`);
    products.data.forEach((p) => {
      console.log(`[getProducts] Product: ${p.id} - ${p.name}, metadata:`, p.metadata);
    });

    // Fetch all active prices
    const prices = await stripe.prices.list({
      active: true,
      limit: 100,
    });

    console.log(`[getProducts] Found ${prices.data.length} active prices from Stripe`);
    const recurringPrices = prices.data.filter((p) => p.recurring);
    console.log(`[getProducts] Found ${recurringPrices.length} recurring prices`);

    // Map membership tiers to product metadata or name patterns
    // Order matters: more specific patterns should come first
    const tierPatterns = [
      {
        tier: "studio_owner_pro_plus",
        patterns: ["studio_owner_pro_plus", "studio owner pro+", "studio owner pro plus", "pro+"],
      },
      {
        tier: "studio_owner",
        patterns: ["studio_owner", "studio owner"],
      },
      {
        tier: "individual_instructor",
        patterns: ["individual_instructor", "individual instructor", "indivdual instructor"],
      },
    ];

    // Helper function to determine tier from product
    const getTierFromProduct = (product) => {
      // First, check metadata
      const metadataTier = product.metadata?.membership_tier;
      if (metadataTier) {
        for (const {tier, patterns} of tierPatterns) {
          if (patterns.includes(metadataTier.toLowerCase())) {
            return tier;
          }
        }
      }

      // Fallback: check product name (check more specific patterns first)
      const productName = product.name.toLowerCase();
      for (const {tier, patterns} of tierPatterns) {
        for (const pattern of patterns) {
          if (productName.includes(pattern.toLowerCase())) {
            return tier;
          }
        }
      }

      return null;
    };

    const productsBeforeFilter = products.data.length;
    const productsWithMetadata = products.data.filter(p => p.metadata?.membership_tier).length;
    const productsWithMatchingTier = products.data.filter(p => {
      const tier = getTierFromProduct(p);
      return tier !== null;
    }).length;
    
    console.log(`[getProducts] Filtering stats:`, {
      totalProducts: productsBeforeFilter,
      productsWithMetadata,
      productsWithMatchingTier,
    });

    // Combine products with their prices
    // Group by tier and keep only one product per tier (prefer products with more specific names)
    const productsByTier = new Map();

    products.data.forEach((product) => {
      const tier = getTierFromProduct(product);
      if (!tier) {
        console.log(`[getProducts] Product ${product.id} (${product.name}) filtered out - no matching tier`);
        return;
      }

      // If we already have a product for this tier, keep the one with the more specific name
      const existing = productsByTier.get(tier);
      if (existing) {
        // Prefer product with longer name (more specific) or with metadata
        if (product.name.length > existing.name.length || 
            (product.metadata?.membership_tier && !existing.metadata?.membership_tier)) {
          productsByTier.set(tier, product);
        }
      } else {
        productsByTier.set(tier, product);
      }
    });

    const productsWithPrices = Array.from(productsByTier.values())
        .map((product) => {
          const tier = getTierFromProduct(product);
          const productPrices = prices.data.filter(
              (price) => price.product === product.id && price.active,
          );

          // Get the recurring price (subscription)
          const recurringPrice = productPrices.find((p) => p.recurring);

          console.log(`[getProducts] Mapping product ${product.id}:`, {
            name: product.name,
            tier,
            hasPrices: productPrices.length > 0,
            hasRecurringPrice: !!recurringPrice,
            priceCount: productPrices.length,
          });

          return {
            id: product.id,
            name: product.name,
            description: product.description,
            membershipTier: tier,
            price: recurringPrice
              ? {
                id: recurringPrice.id,
                amount: recurringPrice.unit_amount,
                currency: recurringPrice.currency,
                interval: recurringPrice.recurring?.interval,
                intervalCount: recurringPrice.recurring?.interval_count,
              }
              : null,
            images: product.images,
            metadata: product.metadata,
          };
        })
        .sort((a, b) => {
          // Sort by tier order
          const order = {
            individual_instructor: 1,
            studio_owner: 2,
            studio_owner_pro_plus: 3,
          };
          return (order[a.membershipTier] || 99) - (order[b.membershipTier] || 99);
        });

    console.log(`[getProducts] Returning ${productsWithPrices.length} products with prices`);
    productsWithPrices.forEach((p) => {
      console.log(`[getProducts] Final product: ${p.name} (${p.membershipTier}) - Price: ${p.price ? `$${p.price.amount / 100} ${p.price.currency}` : 'N/A'}`);
    });

    return productsWithPrices;
  } catch (error) {
    console.error("[getProducts] Error fetching Stripe products:", error);
    throw new Error(`Failed to fetch products: ${error.message}`);
  }
}

/**
 * Create or retrieve a Stripe customer
 * @param {string} email - Customer email
 * @param {Object} metadata - Customer metadata
 * @returns {Promise<Stripe.Customer>} Stripe customer object
 */
async function createCustomer(email, metadata = {}) {
  const stripe = await getStripeClient();

  try {
    // Check if customer already exists
    const existingCustomers = await stripe.customers.list({
      email,
      limit: 1,
    });

    if (existingCustomers.data.length > 0) {
      // Update existing customer metadata
      const customer = await stripe.customers.update(existingCustomers.data[0].id, {
        metadata: {
          ...existingCustomers.data[0].metadata,
          ...metadata,
        },
      });
      return customer;
    }

    // Create new customer
    const customer = await stripe.customers.create({
      email,
      metadata,
    });

    return customer;
  } catch (error) {
    console.error("Error creating Stripe customer:", error);
    throw new Error(`Failed to create customer: ${error.message}`);
  }
}

/**
 * Create a Stripe Checkout Session
 * @param {string} customerId - Stripe customer ID
 * @param {string} priceId - Stripe price ID
 * @param {string} userId - User ID from Firestore
 * @param {string} membership - Membership tier
 * @param {string} successUrl - URL to redirect after successful payment
 * @param {string} cancelUrl - URL to redirect after cancelled payment
 * @returns {Promise<Stripe.Checkout.Session>} Checkout session object
 */
async function createCheckoutSession(
    customerId,
    priceId,
    userId,
    membership,
    successUrl,
    cancelUrl,
    useEmbedded = true,
) {
  const stripe = await getStripeClient();

  try {
    const sessionParams = {
      customer: customerId,
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        userId,
        membership,
      },
      subscription_data: {
        metadata: {
          userId,
          membership,
        },
      },
      payment_method_types: ["card"],
    };

    if (useEmbedded) {
      // For Embedded Checkout, use ui_mode and return_url
      sessionParams.ui_mode = "embedded";
      sessionParams.return_url = successUrl;
    } else {
      // For redirect-based Checkout, use success_url and cancel_url
      sessionParams.success_url = successUrl;
      sessionParams.cancel_url = cancelUrl;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`[createCheckoutSession] Created ${useEmbedded ? 'embedded' : 'redirect'} checkout session:`, {
      id: session.id,
      client_secret: session.client_secret ? 'present' : 'missing',
      url: session.url,
    });

    return session;
  } catch (error) {
    console.error("Error creating Stripe checkout session:", error);
    throw new Error(`Failed to create checkout session: ${error.message}`);
  }
}

/**
 * Retrieve a Stripe Checkout Session
 * @param {string} sessionId - Checkout session ID
 * @returns {Promise<Stripe.Checkout.Session>} Checkout session object
 */
async function getCheckoutSession(sessionId) {
  const stripe = await getStripeClient();

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });
    return session;
  } catch (error) {
    console.error("Error retrieving Stripe checkout session:", error);
    throw new Error(`Failed to retrieve checkout session: ${error.message}`);
  }
}

/**
 * Verify Stripe webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - Stripe signature header
 * @param {string} secret - Webhook signing secret
 * @returns {Stripe.Event} Verified Stripe event
 */
async function verifyWebhookSignature(payload, signature, secret) {
  const stripe = await getStripeClient();

  try {
    const event = stripe.webhooks.constructEvent(payload, signature, secret);
    return event;
  } catch (error) {
    console.error("Error verifying webhook signature:", error);
    throw new Error(`Webhook signature verification failed: ${error.message}`);
  }
}

/**
 * Create a Payment Link for subscription checkout
 * @param {string} priceId - Stripe price ID for the subscription
 * @param {string} customerEmail - Customer email address
 * @param {Object} metadata - Metadata to include (userId, membership, etc.)
 * @param {string} successUrl - URL to redirect to on success
 * @param {string} cancelUrl - URL to redirect to on cancel
 * @returns {Promise<Stripe.PaymentLink>} Payment Link object
 */
async function createPaymentLink(priceId, customerEmail, metadata, successUrl, cancelUrl) {
  const stripe = await getStripeClient();

  try {
    console.log("[createPaymentLink] Creating Payment Link:", {
      priceId,
      customerEmail,
      metadata,
    });

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: metadata,
      },
      metadata: metadata,
      after_completion: {
        type: "redirect",
        redirect: {
          url: successUrl,
        },
      },
      // Payment Links automatically detect subscription mode from the price
      // No need to explicitly set mode for subscription prices
    });

    console.log("[createPaymentLink] Payment Link created:", {
      id: paymentLink.id,
      url: paymentLink.url,
    });

    return paymentLink;
  } catch (error) {
    console.error("Error creating Payment Link:", error);
    throw new Error(`Failed to create Payment Link: ${error.message}`);
  }
}

/**
 * Create a Checkout Session for one-time payment with Stripe Connect
 * @param {string} priceId - Stripe price ID
 * @param {string} customerId - Stripe customer ID
 * @param {string} connectedAccountId - Stripe Connect account ID (destination)
 * @param {Object} metadata - Metadata to include
 * @param {string} successUrl - URL to redirect after successful payment
 * @param {string} cancelUrl - URL to redirect after cancelled payment
 * @param {number} applicationFeeAmount - Application fee in cents (optional)
 * @returns {Promise<Stripe.Checkout.Session>} Checkout session object
 */
async function createConnectCheckoutSession(
    priceId,
    customerId,
    connectedAccountId,
    metadata,
    successUrl,
    cancelUrl,
    applicationFeeAmount = null,
) {
  const stripe = await getStripeClient();

  try {
    const sessionParams = {
      customer: customerId,
      mode: "payment", // One-time payment
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: metadata,
      payment_intent_data: {
        metadata: metadata,
      },
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    // Only route to connected account if one is provided
    if (connectedAccountId) {
      sessionParams.payment_intent_data.transfer_data = {destination: connectedAccountId};

      // Add application fee if specified (platform fee)
      if (applicationFeeAmount && applicationFeeAmount > 0) {
        sessionParams.payment_intent_data.application_fee_amount = applicationFeeAmount;
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log("[createConnectCheckoutSession] Created Connect checkout session:", {
      sessionId: session.id,
      connectedAccountId,
      applicationFeeAmount,
    });

    return session;
  } catch (error) {
    console.error("Error creating Connect Checkout Session:", error);
    throw new Error(`Failed to create Checkout Session: ${error.message}`);
  }
}

/**
 * Create a Checkout Session for subscription with Stripe Connect
 * @param {string} priceId - Stripe price ID (recurring price)
 * @param {string} customerId - Stripe customer ID
 * @param {string} connectedAccountId - Stripe Connect account ID (destination)
 * @param {Object} metadata - Metadata to include
 * @param {string} successUrl - URL to redirect after successful payment
 * @param {string} cancelUrl - URL to redirect after cancelled payment
 * @param {number} applicationFeeAmount - Application fee in cents (optional)
 * @returns {Promise<Stripe.Checkout.Session>} Checkout session object
 */
async function createConnectSubscriptionSession(
    priceId,
    customerId,
    connectedAccountId,
    metadata,
    successUrl,
    cancelUrl,
    applicationFeeAmount = null,
) {
  const stripe = await getStripeClient();

  try {
    const sessionParams = {
      customer: customerId,
      mode: "subscription", // Subscription mode
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: metadata,
      subscription_data: {
        metadata: metadata,
      },
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    // Only route to connected account if one is provided
    if (connectedAccountId) {
      sessionParams.subscription_data.transfer_data = {destination: connectedAccountId};

      // Add application fee if specified
      if (applicationFeeAmount && applicationFeeAmount > 0 && metadata.price) {
        const priceInCents = Math.round(metadata.price * 100);
        const feePercent = (applicationFeeAmount / priceInCents) * 100;
        sessionParams.subscription_data.application_fee_percent = feePercent;
      }
    }

    // Note: cancel_after cannot be set in checkout session subscription_data
    // It must be set on the subscription after creation via webhook

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log("[createConnectSubscriptionSession] Created Connect subscription checkout session:", {
      sessionId: session.id,
      connectedAccountId,
      applicationFeeAmount,
    });

    return session;
  } catch (error) {
    console.error("Error creating Connect Subscription Checkout Session:", error);
    throw new Error(`Failed to create Subscription Checkout Session: ${error.message}`);
  }
}

/**
 * Charge a saved payment method directly (off-session) without a Checkout redirect.
 * Returns the PaymentIntent. If status is 'requires_action', the client must complete 3DS.
 * @param {string} customerId - Stripe customer ID
 * @param {string} paymentMethodId - Stripe PaymentMethod ID to charge
 * @param {number} amountCents - Amount in cents
 * @param {Object} metadata - Metadata to attach
 * @param {string|null} connectedAccountId - Optional Stripe Connect destination account
 * @returns {Promise<Stripe.PaymentIntent>}
 */
async function chargePaymentMethodDirectly(customerId, paymentMethodId, amountCents, metadata, connectedAccountId) {
  const stripe = await getStripeClient();

  const params = {
    amount: amountCents,
    currency: "usd",
    customer: customerId,
    payment_method: paymentMethodId,
    confirm: true,
    off_session: true,
    metadata,
  };

  if (connectedAccountId) {
    params.transfer_data = {destination: connectedAccountId};
  }

  try {
    return await stripe.paymentIntents.create(params);
  } catch (error) {
    // Stripe throws when authentication is required — surface the payment_intent so the
    // client can call stripe.handleCardAction(clientSecret) to complete 3DS.
    if (error.code === "authentication_required" && error.payment_intent) {
      return error.payment_intent;
    }
    console.error("Error charging payment method directly:", error);
    throw new Error(`Failed to charge payment method: ${error.message}`);
  }
}

/**
 * Create a subscription using a saved payment method without a Checkout redirect.
 * Expands latest_invoice.payment_intent so the caller can check whether 3DS is needed.
 * @param {string} customerId - Stripe customer ID
 * @param {Object} priceParams - Parameters for stripe.prices.create()
 * @param {string} paymentMethodId - Default payment method for the subscription
 * @param {Object} metadata - Metadata to attach to the subscription
 * @param {string|null} connectedAccountId - Optional Stripe Connect destination account
 * @returns {Promise<Stripe.Subscription>}
 */
async function createSubscriptionWithSavedCard(customerId, priceParams, paymentMethodId, metadata, connectedAccountId) {
  const stripe = await getStripeClient();

  // Create a one-off price for this subscription
  const price = await stripe.prices.create(priceParams);

  const subParams = {
    customer: customerId,
    items: [{price: price.id}],
    default_payment_method: paymentMethodId,
    metadata,
    expand: ["latest_invoice.payment_intent"],
  };

  if (connectedAccountId) {
    subParams.transfer_data = {destination: connectedAccountId};
  }

  try {
    return await stripe.subscriptions.create(subParams);
  } catch (error) {
    console.error("Error creating subscription with saved card:", error);
    throw new Error(`Failed to create subscription: ${error.message}`);
  }
}

/**
 * Detach a payment method from a customer (effectively deletes it)
 * @param {string} paymentMethodId - Stripe PaymentMethod ID
 * @returns {Promise<Stripe.PaymentMethod>} Detached payment method
 */
async function detachPaymentMethod(paymentMethodId) {
  const stripe = await getStripeClient();
  try {
    return await stripe.paymentMethods.detach(paymentMethodId);
  } catch (error) {
    console.error("Error detaching payment method:", error);
    throw new Error(`Failed to delete payment method: ${error.message}`);
  }
}

/**
 * Update a saved card's expiration date
 * @param {string} paymentMethodId - Stripe PaymentMethod ID
 * @param {number} expMonth - New expiration month (1–12)
 * @param {number} expYear - New expiration year (4-digit)
 * @returns {Promise<Stripe.PaymentMethod>} Updated payment method
 */
async function updatePaymentMethod(paymentMethodId, expMonth, expYear) {
  const stripe = await getStripeClient();
  try {
    return await stripe.paymentMethods.update(paymentMethodId, {
      card: {exp_month: expMonth, exp_year: expYear},
    });
  } catch (error) {
    console.error("Error updating payment method:", error);
    throw new Error(`Failed to update payment method: ${error.message}`);
  }
}

/**
 * Get the Stripe publishable key from Secret Manager
 * @returns {Promise<string>} Stripe publishable key
 */
async function getStripePublishableKey() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
  const isProduction = projectId.includes("production");
  const secretName = isProduction
    ? "stripe-publishable-key-prod"
    : "stripe-publishable-key-test";

  const key = await getSecret(secretName);
  if (!key) {
    throw new Error("Stripe publishable key not found in Secret Manager");
  }
  return key.trim();
}

/**
 * Create a Stripe SetupIntent to save a payment method for a customer
 * @param {string} customerId - Stripe customer ID
 * @returns {Promise<Stripe.SetupIntent>} SetupIntent object
 */
async function createSetupIntent(customerId) {
  const stripe = await getStripeClient();

  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
    });
    return setupIntent;
  } catch (error) {
    console.error("Error creating SetupIntent:", error);
    throw new Error(`Failed to create setup intent: ${error.message}`);
  }
}

/**
 * List all saved payment methods for a Stripe customer
 * @param {string} customerId - Stripe customer ID
 * @returns {Promise<Stripe.PaymentMethod[]>} Array of payment methods
 */
async function listPaymentMethods(customerId) {
  const stripe = await getStripeClient();

  try {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });
    return paymentMethods.data;
  } catch (error) {
    console.error("Error listing payment methods:", error);
    throw new Error(`Failed to list payment methods: ${error.message}`);
  }
}

/**
 * Create a Stripe Product for a dance studio package
 * @param {Object} packageData - Package data from the create request
 * @param {string} studioOwnerId - Studio owner's Firestore document ID
 * @param {string} studioName - Studio name for metadata
 * @returns {Promise<Stripe.Product>} Created Stripe product
 */
async function createStripeProduct(packageData, studioOwnerId, studioName) {
  const stripe = await getStripeClient();

  // Map billing frequency string to Stripe interval
  const intervalMap = {monthly: "month", weekly: "week", daily: "day"};

  // Build the core product params (direct Stripe fields)
  const productParams = {
    name: packageData.name,
    active: packageData.isActive !== undefined ? packageData.isActive : true,
  };

  // Optional direct Stripe product fields
  if (packageData.description) productParams.description = packageData.description;
  if (Array.isArray(packageData.images) && packageData.images.length > 0) {
    productParams.images = packageData.images;
  }
  if (packageData.url) productParams.url = packageData.url;
  if (packageData.statement_descriptor) {
    productParams.statement_descriptor = packageData.statement_descriptor;
  }
  if (packageData.tax_code) productParams.tax_code = packageData.tax_code;
  if (packageData.unit_label) productParams.unit_label = packageData.unit_label;
  if (packageData.shippable !== undefined) productParams.shippable = packageData.shippable;
  if (packageData.package_dimensions) {
    productParams.package_dimensions = packageData.package_dimensions;
  }

  // Build default_price_data from the package price
  if (packageData.price !== undefined) {
    const priceData = {
      currency: packageData.currency || "usd",
      unit_amount: Math.round(packageData.price * 100), // dollars → cents
    };

    if (packageData.isRecurring && packageData.billingFrequency !== undefined) {
      const freq = packageData.billingFrequency;
      const interval = typeof freq === "string"
        ? (intervalMap[freq] || "month")
        : "day";
      const intervalCount = typeof freq === "number"
        ? freq
        : (packageData.billingInterval || 1);

      priceData.recurring = {interval, interval_count: intervalCount};
    }

    if (packageData.tax_behavior) priceData.tax_behavior = packageData.tax_behavior;

    productParams.default_price_data = priceData;
  }

  // Metadata: non-Stripe fields + studio identifiers
  // All Stripe metadata values must be strings
  productParams.metadata = {
    studioId: studioOwnerId,
    studioName: studioName || "",
    credits: String(packageData.credits),
    expirationDays: String(packageData.expirationDays),
    classIds: JSON.stringify(packageData.classIds || []),
    isRecurring: String(packageData.isRecurring || false),
  };

  if (packageData.subscriptionDuration !== undefined && packageData.subscriptionDuration !== null) {
    productParams.metadata.subscriptionDuration = String(packageData.subscriptionDuration);
  }

  try {
    const product = await stripe.products.create(productParams);
    console.log(`[createStripeProduct] Created Stripe product ${product.id} for package "${packageData.name}"`);
    return product;
  } catch (error) {
    console.error("[createStripeProduct] Error creating Stripe product:", error);
    throw new Error(`Failed to create Stripe product: ${error.message}`);
  }
}

/**
 * Create a Stripe Connect Account Session for embedded components
 * @param {string} accountId - Connected Stripe account ID
 * @returns {Promise<Object>} Stripe AccountSession object
 */
async function createAccountSession(accountId) {
  const stripe = await getStripeClient();
  return await stripe.accountSessions.create({
    account: accountId,
    components: {
      payments: {
        enabled: true,
        features: {
          refund_management: true,
          dispute_management: true,
          capture_payments: true,
        },
      },
      payouts: {
        enabled: true,
        features: {
          instant_payouts: true,
        },
      },
      balances: {
        enabled: true,
        features: {
          instant_payouts: true,
        },
      },
    },
  });
}

module.exports = {
  getStripeClient,
  createConnectedAccount,
  createAccountLink,
  getAccount,
  updateAccountMetadata,
  createLoginLink,
  getProducts,
  createCustomer,
  createCheckoutSession,
  createConnectCheckoutSession,
  createConnectSubscriptionSession,
  getCheckoutSession,
  verifyWebhookSignature,
  createPaymentLink,
  createStripeProduct,
  createSetupIntent,
  listPaymentMethods,
  detachPaymentMethod,
  updatePaymentMethod,
  getStripePublishableKey,
  chargePaymentMethodDirectly,
  createSubscriptionWithSavedCard,
  createAccountSession,
};

