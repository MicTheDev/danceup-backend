import Stripe from "stripe";
import { getSecret } from "../utils/secret-manager";

export function platformFeeCents(amountCents: number): number {
  return 25 + Math.round(amountCents * 0.01);
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

    const order: Record<string, number> = { individual_instructor: 1, studio_owner: 2, studio_owner_pro_plus: 3 };

    return Array.from(productsByTier.values())
      .map((product) => {
        const tier = getTierFromProduct(product);
        const productPrices = prices.data.filter((price) => price.product === product.id && price.active);
        const recurringPrice = productPrices.find((p) => p.recurring);
        return {
          id: product.id,
          name: product.name,
          description: product.description,
          membershipTier: tier,
          price: recurringPrice ? {
            id: recurringPrice.id,
            amount: recurringPrice.unit_amount,
            currency: recurringPrice.currency,
            interval: recurringPrice.recurring?.interval,
            intervalCount: recurringPrice.recurring?.interval_count,
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

export async function createConnectCheckoutSession(
  priceId: string,
  customerId: string,
  connectedAccountId: string | null,
  metadata: Record<string, string>,
  successUrl: string,
  cancelUrl: string,
  applicationFeeAmount: number | null = null,
): Promise<Stripe.Checkout.Session> {
  const stripe = await getStripeClient();
  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      metadata,
      payment_intent_data: { metadata },
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    if (connectedAccountId) {
      const pid = sessionParams.payment_intent_data as Record<string, unknown>;
      pid["on_behalf_of"] = connectedAccountId;
      pid["transfer_data"] = { destination: connectedAccountId };
      if (applicationFeeAmount && applicationFeeAmount > 0) {
        pid["application_fee_amount"] = applicationFeeAmount;
      }
    }

    return await stripe.checkout.sessions.create(sessionParams);
  } catch (error) {
    throw new Error(`Failed to create Checkout Session: ${(error as Error).message}`);
  }
}

export async function createConnectSubscriptionSession(
  priceId: string,
  customerId: string,
  connectedAccountId: string | null,
  metadata: Record<string, unknown>,
  successUrl: string,
  cancelUrl: string,
  _applicationFeeAmount: number | null = null,
): Promise<Stripe.Checkout.Session> {
  const stripe = await getStripeClient();
  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: metadata as Record<string, string>,
      subscription_data: { metadata: metadata as Record<string, string> },
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    if (connectedAccountId) {
      (sessionParams as Record<string, unknown>)["on_behalf_of"] = connectedAccountId;
      const sub = sessionParams.subscription_data as Record<string, unknown>;
      sub["transfer_data"] = { destination: connectedAccountId };
      if (metadata["price"]) {
        const priceInCents = Math.round((metadata["price"] as number) * 100);
        sub["application_fee_percent"] = platformFeePercent(priceInCents);
      }
    }

    return await stripe.checkout.sessions.create(sessionParams);
  } catch (error) {
    throw new Error(`Failed to create Subscription Checkout Session: ${(error as Error).message}`);
  }
}

export async function chargePaymentMethodDirectly(
  customerId: string,
  paymentMethodId: string,
  amountCents: number,
  metadata: Record<string, string>,
  connectedAccountId: string | null,
): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripeClient();
  const params: Stripe.PaymentIntentCreateParams = {
    amount: amountCents,
    currency: "usd",
    customer: customerId,
    payment_method: paymentMethodId,
    confirm: true,
    off_session: true,
    metadata,
  };

  if (connectedAccountId) {
    (params as unknown as Record<string, unknown>)["on_behalf_of"] = connectedAccountId;
    (params as unknown as Record<string, unknown>)["transfer_data"] = { destination: connectedAccountId };
    (params as unknown as Record<string, unknown>)["application_fee_amount"] = platformFeeCents(amountCents);
  }

  try {
    return await stripe.paymentIntents.create(params);
  } catch (error) {
    const err = error as Error & { code?: string; payment_intent?: Stripe.PaymentIntent };
    if (err.code === "authentication_required" && err.payment_intent) {
      return err.payment_intent;
    }
    throw new Error(`Failed to charge payment method: ${err.message}`);
  }
}

export async function createSubscriptionWithSavedCard(
  customerId: string,
  priceParams: Stripe.PriceCreateParams,
  paymentMethodId: string,
  metadata: Record<string, string>,
  connectedAccountId: string | null,
): Promise<Stripe.Subscription> {
  const stripe = await getStripeClient();
  const price = await stripe.prices.create(priceParams);

  const subParams: Stripe.SubscriptionCreateParams = {
    customer: customerId,
    items: [{ price: price.id }],
    default_payment_method: paymentMethodId,
    metadata,
    expand: ["latest_invoice.payment_intent"],
  };

  if (connectedAccountId) {
    (subParams as unknown as Record<string, unknown>)["on_behalf_of"] = connectedAccountId;
    (subParams as unknown as Record<string, unknown>)["transfer_data"] = { destination: connectedAccountId };
    if (priceParams.unit_amount && priceParams.unit_amount > 0) {
      (subParams as unknown as Record<string, unknown>)["application_fee_percent"] = platformFeePercent(priceParams.unit_amount);
    }
  }

  try {
    return await stripe.subscriptions.create(subParams);
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

export async function createAccountSession(accountId: string): Promise<Stripe.AccountSession> {
  const stripe = await getStripeClient();
  return await stripe.accountSessions.create({
    account: accountId,
    components: {
      payments: {
        enabled: true,
        features: { refund_management: true, dispute_management: true, capture_payments: true },
      },
      payouts: { enabled: true, features: { instant_payouts: true } },
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

  if (connectedAccountId) {
    const pid = sessionParams.payment_intent_data as Record<string, unknown>;
    pid["on_behalf_of"] = connectedAccountId;
    pid["transfer_data"] = { destination: connectedAccountId };
    const fee = applicationFeeAmount ?? platformFeeCents(amountCents);
    if (fee > 0) pid["application_fee_amount"] = fee;
  }

  return await stripe.checkout.sessions.create(sessionParams);
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

export async function createRefund(paymentIntentId: string, reason: string): Promise<Stripe.Refund> {
  const stripe = await getStripeClient();
  return await stripe.refunds.create({
    payment_intent: paymentIntentId,
    reason: "requested_by_customer",
    metadata: { reason: reason || "" },
  });
}
