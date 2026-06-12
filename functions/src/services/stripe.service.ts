import Stripe from "stripe";
import { getSecret } from "../utils/secret-manager";

export function platformFeeCents(amountCents: number): number {
  return 30 + Math.round(amountCents * 0.015);
}

export function platformFeePercent(amountCents: number): number {
  return Math.round((1 + (25 / amountCents) * 100) * 100) / 100;
}

let stripeClient: Stripe | null = null;

export async function getStripeClient(): Promise<Stripe> {
  if (stripeClient) return stripeClient;

  try {
    const projectId = process.env["GCLOUD_PROJECT"] || process.env["GCP_PROJECT"] || "";
    const isProduction = projectId.includes("production");
    const secretName = isProduction ? "stripe-secret-key-prod" : "stripe-secret-key-test";
    const secretKey = await getSecret(secretName);
    if (!secretKey) throw new Error("Stripe secret key not found in Secret Manager");
    const trimmedSecretKey = secretKey.trim();
    if (!trimmedSecretKey.startsWith("sk_test_") && !trimmedSecretKey.startsWith("sk_live_")) {
      throw new Error("Invalid Stripe secret key format");
    }
    stripeClient = new Stripe(trimmedSecretKey);
    return stripeClient;
  } catch (error) {
    console.error("Error initializing Stripe client:", error);
    throw new Error(`Failed to initialize Stripe: ${(error as Error).message}`);
  }
}

export async function createConnectedAccount(
  email: string,
  metadata: Record<string, string> = {},
): Promise<Stripe.Account> {
  const stripe = await getStripeClient();
  try {
    return await stripe.accounts.create({
      type: "express",
      country: "US",
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata,
    });
  } catch (error) {
    const err = error as Error & { type?: string; code?: string; raw?: unknown };
    console.error("Error creating Stripe Connect account:", error);
    if (err.type) console.error("Stripe error type:", err.type);
    if (err.code) console.error("Stripe error code:", err.code);
    if (err.raw) console.error("Stripe raw error:", JSON.stringify(err.raw, null, 2));
    throw new Error(`Failed to create Stripe account: ${err.message}`);
  }
}

export async function createAccountLink(
  accountId: string,
  returnUrl: string,
  refreshUrl: string,
): Promise<Stripe.AccountLink> {
  const stripe = await getStripeClient();
  try {
    return await stripe.accountLinks.create({
      account: accountId,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: "account_onboarding",
    });
  } catch (error) {
    throw new Error(`Failed to create account link: ${(error as Error).message}`);
  }
}

export async function getAccount(accountId: string): Promise<Stripe.Account> {
  const stripe = await getStripeClient();
  try {
    return await stripe.accounts.retrieve(accountId);
  } catch (error) {
    throw new Error(`Failed to retrieve account: ${(error as Error).message}`);
  }
}

export async function updateAccountMetadata(
  accountId: string,
  metadata: Record<string, string>,
): Promise<Stripe.Account> {
  const stripe = await getStripeClient();
  try {
    return await stripe.accounts.update(accountId, { metadata });
  } catch (error) {
    throw new Error(`Failed to update account metadata: ${(error as Error).message}`);
  }
}

export async function createLoginLink(accountId: string): Promise<Stripe.LoginLink> {
  const stripe = await getStripeClient();
  try {
    return await stripe.accounts.createLoginLink(accountId);
  } catch (error) {
    throw new Error(`Failed to create login link: ${(error as Error).message}`);
  }
}

interface TierPattern {
  tier: string;
  patterns: string[];
}

export async function getProducts(): Promise<Array<Record<string, unknown>>> {
  const stripe = await getStripeClient();
  try {
    const products = await stripe.products.list({ active: true, limit: 100 });
    const prices = await stripe.prices.list({ active: true, limit: 100 });

    const tierPatterns: TierPattern[] = [
      { tier: "studio_owner_pro_plus", patterns: ["studio_owner_pro_plus", "studio owner pro+", "studio owner pro plus", "pro+"] },
      { tier: "studio_owner", patterns: ["studio_owner", "studio owner"] },
      { tier: "individual_instructor", patterns: ["individual_instructor", "individual instructor", "indivdual instructor"] },
      { tier: "event_host", patterns: ["event_host", "event host"] },
    ];

    const getTierFromProduct = (product: Stripe.Product): string | null => {
      const metadataTier = product.metadata?.["membership_tier"];
      if (metadataTier) {
        for (const { tier, patterns } of tierPatterns) {
          if (patterns.includes(metadataTier.toLowerCase())) return tier;
        }
      }
      const productName = product.name.toLowerCase();
      for (const { tier, patterns } of tierPatterns) {
        for (const pattern of patterns) {
          if (productName.includes(pattern.toLowerCase())) return tier;
        }
      }
      return null;
    };

    const productsByTier = new Map<string, Stripe.Product>();
    products.data.forEach((product) => {
      const tier = getTierFromProduct(product);
      if (!tier) return;
      const existing = productsByTier.get(tier);
      if (existing) {
        if (product.name.length > existing.name.length ||
            (product.metadata?.["membership_tier"] && !existing.metadata?.["membership_tier"])) {
          productsByTier.set(tier, product);
        }
      } else {
        productsByTier.set(tier, product);
      }
    });

    const order: Record<string, number> = { event_host: 0, individual_instructor: 1, studio_owner: 2, studio_owner_pro_plus: 3 };

    return Array.from(productsByTier.values())
      .map((product) => {
        const tier = getTierFromProduct(product);
        const productPrices = prices.data.filter((price) => price.product === product.id && price.active);
        const monthlyPrice = productPrices.find((p) => p.recurring?.interval === "month");
        const yearlyPrice = productPrices.find((p) => p.recurring?.interval === "year");
        // Fall back to any recurring price for backwards compat
        const anyRecurring = monthlyPrice ?? yearlyPrice ?? productPrices.find((p) => p.recurring);
        return {
          id: product.id,
          name: product.name,
          description: product.description,
          membershipTier: tier,
          // Legacy single-price field (monthly preferred)
          price: anyRecurring ? {
            id: anyRecurring.id,
            amount: anyRecurring.unit_amount,
            currency: anyRecurring.currency,
            interval: anyRecurring.recurring?.interval,
            intervalCount: anyRecurring.recurring?.interval_count,
          } : null,
          // Explicit monthly price
          monthlyPrice: monthlyPrice ? {
            id: monthlyPrice.id,
            amount: monthlyPrice.unit_amount,
            currency: monthlyPrice.currency,
            interval: "month",
          } : null,
          // Explicit yearly price (total annual amount)
          yearlyPrice: yearlyPrice ? {
            id: yearlyPrice.id,
            amount: yearlyPrice.unit_amount,
            currency: yearlyPrice.currency,
            interval: "year",
          } : null,
          images: product.images,
          metadata: product.metadata,
        };
      })
      .sort((a, b) => (order[a.membershipTier as string] ?? 99) - (order[b.membershipTier as string] ?? 99));
  } catch (error) {
    throw new Error(`Failed to fetch products: ${(error as Error).message}`);
  }
}

// Derives the DanceUp membership tier from a Stripe priceId by inspecting the
// associated product's metadata. Returns null if the price is unknown/inactive.
export async function getMembershipForPriceId(priceId: string): Promise<string | null> {
  const stripe = await getStripeClient();
  try {
    const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    if (!price.active) return null;
    const product = price.product as Stripe.Product;
    if (!product || typeof product === "string" || !product.active) return null;

    const tierPatterns: TierPattern[] = [
      { tier: "studio_owner_pro_plus", patterns: ["studio_owner_pro_plus", "studio owner pro+", "studio owner pro plus", "pro+"] },
      { tier: "studio_owner", patterns: ["studio_owner", "studio owner"] },
      { tier: "individual_instructor", patterns: ["individual_instructor", "individual instructor", "indivdual instructor"] },
      { tier: "event_host", patterns: ["event_host", "event host"] },
    ];

    const metadataTier = product.metadata?.["membership_tier"];
    if (metadataTier) {
      for (const { tier, patterns } of tierPatterns) {
        if (patterns.includes(metadataTier.toLowerCase())) return tier;
      }
    }
    const productName = product.name.toLowerCase();
    for (const { tier, patterns } of tierPatterns) {
      for (const pattern of patterns) {
        if (productName.includes(pattern)) return tier;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function createCustomer(email: string, metadata: Record<string, string> = {}): Promise<Stripe.Customer> {
  const stripe = await getStripeClient();
  try {
    const existingCustomers = await stripe.customers.list({ email, limit: 1 });
    const firstCustomer = existingCustomers.data[0];
    if (firstCustomer) {
      return await stripe.customers.update(firstCustomer.id, {
        metadata: { ...firstCustomer.metadata, ...metadata },
      });
    }
    return await stripe.customers.create({ email, metadata });
  } catch (error) {
    throw new Error(`Failed to create customer: ${(error as Error).message}`);
  }
}

export async function createCheckoutSession(
  customerId: string,
  priceId: string,
  userId: string,
  membership: string,
  successUrl: string,
  cancelUrl: string,
  uiMode: "custom" | "embedded" | "hosted" = "custom",
): Promise<Stripe.Checkout.Session> {
  const stripe = await getStripeClient();
  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId, membership },
      subscription_data: { metadata: { userId, membership } },
      payment_method_types: ["card"],
    };

    if (uiMode === "custom" || uiMode === "embedded") {
      (sessionParams as Record<string, unknown>)["ui_mode"] = uiMode;
      (sessionParams as Record<string, unknown>)["return_url"] = successUrl;
    } else {
      sessionParams.success_url = successUrl;
      sessionParams.cancel_url = cancelUrl;
    }

    return await stripe.checkout.sessions.create(sessionParams);
  } catch (error) {
    throw new Error(`Failed to create checkout session: ${(error as Error).message}`);
  }
}

export async function getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  const stripe = await getStripeClient();
  try {
    return await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });
  } catch (error) {
    throw new Error(`Failed to retrieve checkout session: ${(error as Error).message}`);
  }
}

export async function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
): Promise<Stripe.Event> {
  const stripe = await getStripeClient();
  try {
    return stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (error) {
    throw new Error(`Webhook signature verification failed: ${(error as Error).message}`);
  }
}

export async function createPaymentLink(
  priceId: string,
  _customerEmail: string,
  metadata: Record<string, string>,
  successUrl: string,
  _cancelUrl: string,
): Promise<Stripe.PaymentLink> {
  const stripe = await getStripeClient();
  try {
    return await stripe.paymentLinks.create({
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata },
      metadata,
      after_completion: { type: "redirect", redirect: { url: successUrl } },
    });
  } catch (error) {
    throw new Error(`Failed to create Payment Link: ${(error as Error).message}`);
  }
}

/**
 * Direct charge: create a one-time checkout session on the connected account.
 * The price and customer must already exist on the connected account.
 */
export async function createDirectCheckoutSession(
  priceId: string,
  connectedCustomerId: string,
  connectedAccountId: string,
  applicationFeeAmount: number,
  metadata: Record<string, string>,
  successUrl: string,
  cancelUrl: string,
): Promise<Stripe.Checkout.Session> {
  const stripe = await getStripeClient();
  try {
    return await stripe.checkout.sessions.create(
      {
        customer: connectedCustomerId,
        mode: "payment",
        line_items: [{ price: priceId, quantity: 1 }],
        metadata,
        payment_intent_data: {
          application_fee_amount: applicationFeeAmount,
          metadata,
        },
        payment_method_types: ["card"],
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      { stripeAccount: connectedAccountId },
    );
  } catch (error) {
    throw new Error(`Failed to create direct checkout session: ${(error as Error).message}`);
  }
}

/**
 * Direct charge: create a recurring subscription checkout session on the connected account.
 * The price and customer must already exist on the connected account.
 */
export async function createDirectSubscriptionSession(
  priceId: string,
  connectedCustomerId: string,
  connectedAccountId: string,
  applicationFeePercent: number,
  metadata: Record<string, string>,
  successUrl: string,
  cancelUrl: string,
): Promise<Stripe.Checkout.Session> {
  const stripe = await getStripeClient();
  try {
    return await stripe.checkout.sessions.create(
      {
        customer: connectedCustomerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        metadata,
        subscription_data: {
          application_fee_percent: applicationFeePercent,
          metadata,
        },
        payment_method_types: ["card"],
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      { stripeAccount: connectedAccountId },
    );
  } catch (error) {
    throw new Error(`Failed to create direct subscription session: ${(error as Error).message}`);
  }
}

/**
 * Direct charge: create a PaymentIntent on the connected account for self-hosted checkout.
 * Returns the full PaymentIntent (frontend reads clientSecret from it).
 */
export async function createDirectPaymentIntent(
  amountCents: number,
  connectedAccountId: string,
  applicationFeeAmount: number,
  metadata: Record<string, string>,
): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripeClient();
  try {
    return await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        application_fee_amount: applicationFeeAmount,
        automatic_payment_methods: { enabled: true },
        metadata,
      },
      { stripeAccount: connectedAccountId },
    );
  } catch (error) {
    throw new Error(`Failed to create payment intent: ${(error as Error).message}`);
  }
}

/**
 * Retrieve a PaymentIntent from a connected account (needed for /success verification).
 */
export async function retrieveConnectedPaymentIntent(
  paymentIntentId: string,
  connectedAccountId: string,
): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripeClient();
  return stripe.paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: connectedAccountId });
}

/**
 * Create a customer on a connected account.
 * Stores the platform customer ID in metadata so the relationship is traceable.
 */
export async function createConnectedCustomer(
  email: string,
  platformCustomerId: string,
  connectedAccountId: string,
  name?: string,
): Promise<Stripe.Customer> {
  const stripe = await getStripeClient();
  try {
    return await stripe.customers.create(
      { email, name: name || undefined, metadata: { platformCustomerId } },
      { stripeAccount: connectedAccountId },
    );
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeAuthenticationError ||
      error instanceof Stripe.errors.StripePermissionError ||
      (error as Stripe.errors.StripeError).message?.includes("does not have access to account")
    ) {
      const appError = new Error(
        "This studio's Stripe account is no longer accessible. The studio owner needs to reconnect their Stripe account.",
      ) as Error & { status?: number; error?: string };
      appError.status = 400;
      appError.error = "Studio Payment Setup Error";
      throw appError;
    }
    throw new Error(`Failed to create connected customer: ${(error as Error).message}`);
  }
}

/**
 * Find an existing customer on a connected account by the platform customer ID
 * stored in metadata. Returns null if no match is found.
 * This is the source-of-truth lookup that prevents duplicate connected customers
 * even when the Firestore stripeConnectedCustomers map is stale or missing.
 */
export async function findConnectedCustomerByPlatformId(
  platformCustomerId: string,
  connectedAccountId: string,
): Promise<Stripe.Customer | null> {
  const stripe = await getStripeClient();
  try {
    const results = await stripe.customers.search(
      { query: `metadata['platformCustomerId']:'${platformCustomerId}'`, limit: 1 },
      { stripeAccount: connectedAccountId },
    );
    return results.data[0] ?? null;
  } catch (error) {
    // Re-throw auth/permission errors — silently swallowing them causes a second
    // identical failure in createConnectedCustomer.
    if (
      error instanceof Stripe.errors.StripeAuthenticationError ||
      error instanceof Stripe.errors.StripePermissionError ||
      (error as Stripe.errors.StripeError).message?.includes("does not have access to account")
    ) {
      throw error;
    }
    // search API may not be available on all accounts — fall through to create
    return null;
  }
}

/**
 * Find or create a customer on a connected account.
 * Search order:
 *   1. Firestore stripeConnectedCustomers map (fast path)
 *   2. Stripe customer search by metadata.platformCustomerId (dedup guard)
 *   3. Create new customer (only if neither lookup succeeds)
 * Returns { customer, isNew } so the caller can persist the ID to Firestore when needed.
 */
export async function findOrCreateConnectedCustomer(
  email: string,
  platformCustomerId: string,
  connectedAccountId: string,
  name?: string,
  existingConnectedCustomerId?: string | null,
): Promise<{ customer: Stripe.Customer; isNew: boolean }> {
  // 1. Firestore fast path
  if (existingConnectedCustomerId) {
    const stripe = await getStripeClient();
    try {
      const existing = await stripe.customers.retrieve(
        existingConnectedCustomerId,
        { stripeAccount: connectedAccountId },
      );
      if (existing && !(existing as Stripe.DeletedCustomer).deleted) {
        return { customer: existing as Stripe.Customer, isNew: false };
      }
    } catch (error) {
      // Re-throw auth errors — the connected account is inaccessible
      if (
        error instanceof Stripe.errors.StripeAuthenticationError ||
        error instanceof Stripe.errors.StripePermissionError ||
        (error as Stripe.errors.StripeError).message?.includes("does not have access to account")
      ) {
        const appError = new Error(
          "This studio's Stripe account is no longer accessible. The studio owner needs to reconnect their Stripe account.",
        ) as Error & { status?: number; error?: string };
        appError.status = 400;
        appError.error = "Studio Payment Setup Error";
        throw appError;
      }
      // Customer may have been deleted — fall through
    }
  }

  // 2. Stripe metadata search — prevents duplicates when Firestore map is stale
  const found = await findConnectedCustomerByPlatformId(platformCustomerId, connectedAccountId);
  if (found) {
    return { customer: found, isNew: false };
  }

  // 3. Create
  const created = await createConnectedCustomer(email, platformCustomerId, connectedAccountId, name);
  return { customer: created, isNew: true };
}

/**
 * Find a payment method on a connected account that matches the fingerprint of a
 * platform payment method. Returns null if no match is found.
 */
export async function findConnectedPaymentMethod(
  platformPmId: string,
  connectedCustomerId: string,
  connectedAccountId: string,
): Promise<Stripe.PaymentMethod | null> {
  const stripe = await getStripeClient();

  // Get the fingerprint of the platform payment method
  const platformPm = await stripe.paymentMethods.retrieve(platformPmId);
  const fingerprint = platformPm.card?.fingerprint;
  if (!fingerprint) return null;

  // List payment methods on the connected account customer and match by fingerprint
  const connectedPMs = await stripe.paymentMethods.list(
    { customer: connectedCustomerId, type: "card" },
    { stripeAccount: connectedAccountId },
  );

  const platformCard = platformPm.card;
  const allMatches = connectedPMs.data.filter((pm) => pm.card?.fingerprint === fingerprint);
  if (allMatches.length === 0) return null;

  // Separate clones whose expiry matches the current platform PM from stale ones.
  // A stale clone has a different exp_month/exp_year (e.g. card was re-saved after expiry
  // and re-cloned, but the old clone is still attached). Charging a stale clone produces
  // "Your card has expired." even when the platform card is valid.
  const freshClones = allMatches.filter(
    (pm) => pm.card?.exp_year === platformCard?.exp_year && pm.card?.exp_month === platformCard?.exp_month,
  );
  const staleClones = allMatches.filter(
    (pm) => pm.card?.exp_year !== platformCard?.exp_year || pm.card?.exp_month !== platformCard?.exp_month,
  );

  // Detach all stale clones so they can't be accidentally used in future requests.
  if (staleClones.length > 0) {
    await Promise.allSettled(
      staleClones.map((pm) =>
        stripe.paymentMethods.detach(pm.id, {}, { stripeAccount: connectedAccountId }),
      ),
    );
  }

  return freshClones[0] ?? null;
}

/**
 * Clone a platform payment method to a connected account and attach it to the
 * connected customer. Returns the cloned PaymentMethod on the connected account.
 * Used when a customer pays at a new studio for the first time with a saved card.
 */
export async function clonePaymentMethodToConnectedAccount(
  platformPmId: string,
  platformCustomerId: string,
  connectedCustomerId: string,
  connectedAccountId: string,
): Promise<Stripe.PaymentMethod> {
  const stripe = await getStripeClient();

  let cloned: Stripe.PaymentMethod;
  try {
    // Clone the platform PM onto the connected account
    cloned = await stripe.paymentMethods.create(
      { customer: platformCustomerId, payment_method: platformPmId },
      { stripeAccount: connectedAccountId },
    );
  } catch (error) {
    const err = error as Stripe.errors.StripeError;
    console.error("[clonePaymentMethod] create failed:", { platformPmId, connectedAccountId, type: err.type, code: err.code, message: err.message });
    throw new Error(`Failed to clone payment method to connected account: ${err.message}`);
  }

  try {
    // Attach it to the connected customer so it can be reused and found by fingerprint
    await stripe.paymentMethods.attach(
      cloned.id,
      { customer: connectedCustomerId },
      { stripeAccount: connectedAccountId },
    );
  } catch (error) {
    const err = error as Stripe.errors.StripeError;
    console.error("[clonePaymentMethod] attach failed:", { clonedId: cloned.id, connectedCustomerId, connectedAccountId, type: err.type, code: err.code, message: err.message });
    throw new Error(`Failed to attach cloned payment method: ${err.message}`);
  }

  return cloned;
}

/**
 * Direct charge: off-session charge on the connected account.
 * connectedCustomerId and connectedPmId must belong to the connected account.
 * Throws if connectedAccountId is null (studio/instructor must complete Stripe Connect setup).
 */
export async function chargePaymentMethodDirectly(
  connectedCustomerId: string,
  connectedPmId: string,
  amountCents: number,
  metadata: Record<string, string>,
  connectedAccountId: string | null,
  idempotencyKey?: string,
): Promise<Stripe.PaymentIntent> {
  if (!connectedAccountId) {
    throw new Error("Direct charges require a connected Stripe account. Please complete Stripe Connect setup.");
  }

  const stripe = await getStripeClient();
  const params: Stripe.PaymentIntentCreateParams = {
    amount: amountCents,
    currency: "usd",
    customer: connectedCustomerId,
    payment_method: connectedPmId,
    confirm: true,
    off_session: true,
    application_fee_amount: platformFeeCents(amountCents),
    metadata,
  };

  const requestOptions: Stripe.RequestOptions = { stripeAccount: connectedAccountId };
  if (idempotencyKey) requestOptions.idempotencyKey = idempotencyKey;

  try {
    return await stripe.paymentIntents.create(params, requestOptions);
  } catch (error) {
    const err = error as Stripe.errors.StripeError & { payment_intent?: Stripe.PaymentIntent };
    console.error("[chargePaymentMethodDirectly] Stripe error:", { type: err.type, code: err.code, message: err.message, connectedAccountId });
    if (err.code === "authentication_required" && err.payment_intent) {
      return err.payment_intent;
    }
    // Card errors (declined, insufficient funds, etc.) and invalid request errors should be 402/400, not 500
    if (error instanceof Stripe.errors.StripeCardError || error instanceof Stripe.errors.StripeInvalidRequestError) {
      const appError = new Error(err.message || "Payment could not be completed") as Error & { status?: number; error?: string };
      appError.status = error instanceof Stripe.errors.StripeCardError ? 402 : 400;
      appError.error = error instanceof Stripe.errors.StripeCardError ? "Payment Failed" : "Bad Request";
      throw appError;
    }
    throw new Error(`Failed to charge payment method: ${err.message}`);
  }
}

/**
 * Destination charge: charge a platform-level customer/payment-method and transfer
 * funds to the studio's connected account. Use this when the customer and payment
 * method live on the platform (not the connected account) — the common case when a
 * studio owner charges a student's saved card on their behalf.
 *
 * Stripe docs: https://stripe.com/docs/connect/destination-charges
 */
export async function chargePlatformCardForConnectedAccount(
  platformCustomerId: string,
  platformPaymentMethodId: string,
  amountCents: number,
  metadata: Record<string, string>,
  connectedAccountId: string | null,
  idempotencyKey?: string,
): Promise<Stripe.PaymentIntent> {
  if (!connectedAccountId) {
    throw new Error("Connected Stripe account required. Please complete Stripe Connect setup.");
  }

  const stripe = await getStripeClient();
  const params: Stripe.PaymentIntentCreateParams = {
    amount: amountCents,
    currency: "usd",
    customer: platformCustomerId,
    payment_method: platformPaymentMethodId,
    confirm: true,
    off_session: true,
    application_fee_amount: platformFeeCents(amountCents),
    transfer_data: { destination: connectedAccountId },
    metadata,
  };

  const requestOptions: Stripe.RequestOptions | undefined = idempotencyKey ? { idempotencyKey } : undefined;

  try {
    return await stripe.paymentIntents.create(params, requestOptions);
  } catch (error) {
    const err = error as Stripe.errors.StripeError & { payment_intent?: Stripe.PaymentIntent };
    console.error("[chargePlatformCardForConnectedAccount] Stripe error:", {
      type: err.type, code: err.code, message: err.message, connectedAccountId,
    });
    if (err.code === "authentication_required" && err.payment_intent) {
      return err.payment_intent;
    }
    if (error instanceof Stripe.errors.StripeCardError || error instanceof Stripe.errors.StripeInvalidRequestError) {
      const appError = new Error(err.message || "Payment could not be completed") as Error & { status?: number; error?: string };
      appError.status = error instanceof Stripe.errors.StripeCardError ? 402 : 400;
      appError.error = error instanceof Stripe.errors.StripeCardError ? "Payment Failed" : "Bad Request";
      throw appError;
    }
    throw new Error(`Failed to charge payment method: ${err.message}`);
  }
}

/**
 * Direct charge: create a subscription with a saved card on the connected account.
 * connectedCustomerId and connectedPmId must belong to the connected account.
 * priceParams will be used to create the price on the connected account.
 */
export async function createSubscriptionWithSavedCard(
  connectedCustomerId: string,
  priceParams: Stripe.PriceCreateParams,
  connectedPmId: string,
  metadata: Record<string, string>,
  connectedAccountId: string,
  idempotencyKey?: string,
): Promise<Stripe.Subscription> {
  const stripe = await getStripeClient();

  // Create the price on the connected account
  const price = await stripe.prices.create(priceParams, { stripeAccount: connectedAccountId });

  const subParams: Stripe.SubscriptionCreateParams = {
    customer: connectedCustomerId,
    items: [{ price: price.id }],
    default_payment_method: connectedPmId,
    application_fee_percent: priceParams.unit_amount && priceParams.unit_amount > 0
      ? platformFeePercent(priceParams.unit_amount)
      : undefined,
    metadata,
    expand: ["latest_invoice.payment_intent"],
  };

  const requestOptions: Stripe.RequestOptions = { stripeAccount: connectedAccountId };
  // Append the dynamic price ID so each new price generates a unique key.
  // A network retry of the exact same call reuses the same price → same key → idempotent.
  // A fresh retry that creates a new price gets a different key, preventing the
  // "same key, different params" collision that Stripe throws when price IDs differ.
  if (idempotencyKey) requestOptions.idempotencyKey = `${idempotencyKey}:${price.id}`;

  try {
    return await stripe.subscriptions.create(subParams, requestOptions);
  } catch (error) {
    throw new Error(`Failed to create subscription: ${(error as Error).message}`);
  }
}

export async function detachPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
  const stripe = await getStripeClient();
  try {
    return await stripe.paymentMethods.detach(paymentMethodId);
  } catch (error) {
    throw new Error(`Failed to delete payment method: ${(error as Error).message}`);
  }
}

export async function updatePaymentMethod(
  paymentMethodId: string,
  expMonth: number,
  expYear: number,
): Promise<Stripe.PaymentMethod> {
  const stripe = await getStripeClient();
  try {
    return await stripe.paymentMethods.update(paymentMethodId, {
      card: { exp_month: expMonth, exp_year: expYear },
    });
  } catch (error) {
    throw new Error(`Failed to update payment method: ${(error as Error).message}`);
  }
}

export async function getStripePublishableKey(): Promise<string> {
  const projectId = process.env["GCLOUD_PROJECT"] || process.env["GCP_PROJECT"] || "";
  const isProduction = projectId.includes("production");
  const secretName = isProduction ? "stripe-publishable-key-prod" : "stripe-publishable-key-test";
  const key = await getSecret(secretName);
  if (!key) throw new Error("Stripe publishable key not found in Secret Manager");
  return key.trim();
}

export async function createSetupIntent(customerId: string): Promise<Stripe.SetupIntent> {
  const stripe = await getStripeClient();
  try {
    return await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
    });
  } catch (error) {
    throw new Error(`Failed to create setup intent: ${(error as Error).message}`);
  }
}

export async function listPaymentMethods(customerId: string): Promise<Stripe.PaymentMethod[]> {
  const stripe = await getStripeClient();
  try {
    const result = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
    return result.data;
  } catch (error) {
    throw new Error(`Failed to list payment methods: ${(error as Error).message}`);
  }
}

export async function setDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string,
): Promise<Stripe.Customer> {
  const stripe = await getStripeClient();
  try {
    return await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  } catch (error) {
    throw new Error(`Failed to set default payment method: ${(error as Error).message}`);
  }
}

export async function createStripeProduct(
  packageData: Record<string, unknown>,
  studioOwnerId: string,
  studioName: string,
): Promise<Stripe.Product> {
  const stripe = await getStripeClient();
  const intervalMap: Record<string, string> = { monthly: "month", weekly: "week", daily: "day", yearly: "year" };

  const productParams: Stripe.ProductCreateParams & Record<string, unknown> = {
    name: packageData["name"] as string,
    active: packageData["isActive"] !== undefined ? (packageData["isActive"] as boolean) : true,
  };

  if (packageData["description"]) productParams["description"] = packageData["description"] as string;
  if (Array.isArray(packageData["images"]) && (packageData["images"] as string[]).length > 0) {
    productParams["images"] = packageData["images"] as string[];
  }
  if (packageData["url"]) productParams["url"] = packageData["url"] as string;
  const rawDescriptor = (packageData["statement_descriptor"] as string) ||
    `${studioName} ${packageData["name"] as string}`.replace(/[<>"']/g, "");
  productParams["statement_descriptor"] = rawDescriptor.slice(0, 22).trim();
  if (packageData["tax_code"]) productParams["tax_code"] = packageData["tax_code"] as string;
  if (packageData["unit_label"]) productParams["unit_label"] = packageData["unit_label"] as string;
  if (packageData["shippable"] !== undefined) productParams["shippable"] = packageData["shippable"] as boolean;
  if (packageData["package_dimensions"]) productParams["package_dimensions"] = packageData["package_dimensions"] as Stripe.ProductCreateParams.PackageDimensions;

  if (packageData["price"] !== undefined) {
    const priceData: Record<string, unknown> = {
      currency: (packageData["currency"] as string) || "usd",
      unit_amount: Math.round((packageData["price"] as number) * 100),
    };

    if (packageData["isRecurring"] && packageData["billingFrequency"] !== undefined) {
      const freq = packageData["billingFrequency"];
      const interval = typeof freq === "string" ? (intervalMap[freq] || "month") : "day";
      const intervalCount = typeof freq === "number" ? freq : ((packageData["billingInterval"] as number) || 1);
      priceData["recurring"] = { interval, interval_count: intervalCount };
    }

    if (packageData["tax_behavior"]) priceData["tax_behavior"] = packageData["tax_behavior"];
    productParams["default_price_data"] = priceData as unknown as Stripe.ProductCreateParams.DefaultPriceData;
  }

  productParams["metadata"] = {
    studioId: studioOwnerId,
    studioName: studioName || "",
    credits: String(packageData["credits"]),
    expirationDays: String(packageData["expirationDays"]),
    classIds: JSON.stringify((packageData["classIds"] as string[]) || []),
    isRecurring: String(packageData["isRecurring"] || false),
    ...(packageData["subscriptionDuration"] !== undefined && packageData["subscriptionDuration"] !== null
      ? { subscriptionDuration: String(packageData["subscriptionDuration"]) }
      : {}),
  };

  try {
    return await stripe.products.create(productParams as Stripe.ProductCreateParams);
  } catch (error) {
    throw new Error(`Failed to create Stripe product: ${(error as Error).message}`);
  }
}

/**
 * Create a package product on the studio's connected Stripe account.
 * No default_price_data — prices are created dynamically at checkout.
 */
export async function createConnectedProduct(
  packageData: Record<string, unknown>,
  studioOwnerId: string,
  studioName: string,
  connectedAccountId: string,
): Promise<Stripe.Product> {
  const stripe = await getStripeClient();

  const rawDescriptor = `${studioName} ${packageData["name"] as string}`.replace(/[<>"']/g, "");
  const productParams: Stripe.ProductCreateParams = {
    name: packageData["name"] as string,
    active: packageData["isActive"] !== undefined ? (packageData["isActive"] as boolean) : true,
    statement_descriptor: rawDescriptor.slice(0, 22).trim(),
    metadata: {
      studioId: studioOwnerId,
      studioName: studioName || "",
      credits: String(packageData["credits"]),
      expirationDays: String(packageData["expirationDays"]),
      classIds: JSON.stringify((packageData["classIds"] as string[]) || []),
      isRecurring: String(packageData["isRecurring"] || false),
      ...(packageData["subscriptionDuration"] != null
        ? { subscriptionDuration: String(packageData["subscriptionDuration"]) }
        : {}),
    },
  };

  if (packageData["description"]) productParams.description = packageData["description"] as string;

  try {
    return await stripe.products.create(productParams, { stripeAccount: connectedAccountId });
  } catch (error) {
    throw new Error(`Failed to create connected product: ${(error as Error).message}`);
  }
}

export async function createAccountSession(accountId: string): Promise<Stripe.AccountSession> {
  const stripe = await getStripeClient();
  return await stripe.accountSessions.create({
    account: accountId,
    components: {
      payments: {
        enabled: true,
        features: { refund_management: true, dispute_management: true, capture_payments: true },
      },
      payouts: { enabled: true, features: { instant_payouts: true, standard_payouts: true } },
      balances: { enabled: true, features: { instant_payouts: true, standard_payouts: true } },
    },
  });
}

interface PrivateLessonCheckoutOpts {
  amountCents: number;
  instructorName: string;
  customerEmail?: string;
  connectedAccountId?: string | null;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  applicationFeeAmount?: number | null;
}

export async function createPrivateLessonCheckoutSession(opts: PrivateLessonCheckoutOpts): Promise<Stripe.Checkout.Session> {
  const { amountCents, instructorName, customerEmail, connectedAccountId, metadata, successUrl, cancelUrl, applicationFeeAmount = null } = opts;
  const stripe = await getStripeClient();

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        unit_amount: amountCents,
        product_data: {
          name: `Private Lesson — ${instructorName}`,
          description: "1-hour private lesson",
        },
      },
      quantity: 1,
    }],
    metadata,
    payment_intent_data: { metadata },
    payment_method_types: ["card"],
    success_url: successUrl,
    cancel_url: cancelUrl,
  };

  if (customerEmail) sessionParams.customer_email = customerEmail;

  const requestOptions: Stripe.RequestOptions = {};

  if (connectedAccountId) {
    const pid = sessionParams.payment_intent_data as Record<string, unknown>;
    const fee = applicationFeeAmount ?? platformFeeCents(amountCents);
    if (fee > 0) pid["application_fee_amount"] = fee;
    // Direct charge on the connected account — charges appear in the studio's
    // Payments dashboard and balance, consistent with package/subscription charges.
    requestOptions.stripeAccount = connectedAccountId;
  }

  return await stripe.checkout.sessions.create(sessionParams, requestOptions);
}

export async function createSubscriptionCheckout(
  customerId: string,
  priceId: string,
  userId: string | null,
  membership: string,
): Promise<{ subscriptionId: string; paymentIntentId: string; clientSecret: string }> {
  const stripe = await getStripeClient();
  try {
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
      metadata: { userId: userId || "", membership },
    });

    const invoice = subscription.latest_invoice as Stripe.Invoice & { payment_intent?: Stripe.PaymentIntent } | null;
    const paymentIntent = invoice?.payment_intent;
    if (!paymentIntent?.client_secret) {
      throw new Error("Subscription did not produce a pending PaymentIntent");
    }

    return {
      subscriptionId: subscription.id,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
    };
  } catch (error) {
    throw new Error(`Failed to create subscription: ${(error as Error).message}`);
  }
}

export async function createRefund(
  paymentIntentId: string,
  reason: string,
  connectedAccountId?: string,
): Promise<Stripe.Refund> {
  const stripe = await getStripeClient();
  const requestOptions: Stripe.RequestOptions = connectedAccountId ? { stripeAccount: connectedAccountId } : {};
  return await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      reason: "requested_by_customer",
      metadata: { reason: reason || "" },
    },
    requestOptions,
  );
}
