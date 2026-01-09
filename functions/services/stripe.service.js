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
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.service.js:getProducts:entry',message:'Starting getProducts',data:{timestamp:Date.now()},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,B,C,D'})}).catch(()=>{});
    // #endregion

    // Fetch all active products
    const products = await stripe.products.list({
      active: true,
      limit: 100,
    });

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.service.js:getProducts:after-products-list',message:'Products fetched from Stripe',data:{totalProducts:products.data.length,productIds:products.data.map(p=>p.id),productNames:products.data.map(p=>p.name),productMetadata:products.data.map(p=>({id:p.id,metadata:p.metadata}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,B,C'})}).catch(()=>{});
    // #endregion

    // Fetch all active prices
    const prices = await stripe.prices.list({
      active: true,
      limit: 100,
    });

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.service.js:getProducts:after-prices-list',message:'Prices fetched from Stripe',data:{totalPrices:prices.data.length,recurringPrices:prices.data.filter(p=>p.recurring).length,priceProductIds:prices.data.map(p=>p.product)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion

    // Map membership tiers to product metadata
    const tierMapping = {
      individual_instructor: "individual_instructor",
      studio_owner: "studio_owner",
      studio_owner_pro_plus: "studio_owner_pro_plus",
    };

    // #region agent log
    const productsBeforeFilter = products.data.length;
    const productsWithMetadata = products.data.filter(p => p.metadata?.membership_tier).length;
    const productsWithMatchingTier = products.data.filter(p => {
      const tier = p.metadata?.membership_tier;
      return tier && tierMapping[tier];
    }).length;
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.service.js:getProducts:before-filter',message:'Product filtering stats',data:{totalProducts:productsBeforeFilter,productsWithMetadata,productsWithMatchingTier,allMetadata:products.data.map(p=>({id:p.id,metadata:p.metadata}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    // Combine products with their prices
    const productsWithPrices = products.data
        .filter((product) => {
          // Check if product has a matching tier in metadata
          const tier = product.metadata?.membership_tier;
          return tier && tierMapping[tier];
        })
        .map((product) => {
          const tier = product.metadata?.membership_tier;
          const productPrices = prices.data.filter(
              (price) => price.product === product.id && price.active,
          );

          // Get the recurring price (subscription)
          const recurringPrice = productPrices.find((p) => p.recurring);

          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.service.js:getProducts:product-mapping',message:'Mapping product to result',data:{productId:product.id,productName:product.name,tier,hasPrices:productPrices.length>0,hasRecurringPrice:!!recurringPrice},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
          // #endregion

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

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.service.js:getProducts:return',message:'Returning products with prices',data:{finalCount:productsWithPrices.length,products:productsWithPrices.map(p=>({id:p.id,name:p.name,tier:p.membershipTier,hasPrice:!!p.price}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A,B,C,D'})}).catch(()=>{});
    // #endregion

    return productsWithPrices;
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7fd20b2e-ef45-43ff-b3d3-6d49dee23d91',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'stripe.service.js:getProducts:error',message:'Error in getProducts',data:{errorMessage:error.message,errorStack:error.stack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    console.error("Error fetching Stripe products:", error);
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
) {
  const stripe = await getStripeClient();

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
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
  getCheckoutSession,
  verifyWebhookSignature,
};

