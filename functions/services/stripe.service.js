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
        transfer_data: {
          destination: connectedAccountId,
        },
      },
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    // Add application fee if specified (platform fee)
    if (applicationFeeAmount && applicationFeeAmount > 0) {
      sessionParams.payment_intent_data.application_fee_amount = applicationFeeAmount;
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
        transfer_data: {
          destination: connectedAccountId,
        },
      },
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    // Add application fee if specified (platform fee)
    // Note: For subscriptions, we use application_fee_percent instead of application_fee_amount
    // This is calculated as a percentage of the subscription amount
    if (applicationFeeAmount && applicationFeeAmount > 0 && metadata.price) {
      const priceInCents = Math.round(metadata.price * 100);
      const feePercent = (applicationFeeAmount / priceInCents) * 100;
      sessionParams.subscription_data.application_fee_percent = feePercent;
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
};

