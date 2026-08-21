import * as functions from "firebase-functions";
import * as crypto from "crypto";
import * as admin from "firebase-admin";
import express, { Request, Response } from "express";
import cors from "cors";
import authService from "../services/auth.service";
import storageService from "../services/storage.service";
import * as stripeService from "../services/stripe.service";
import { sendStudioOwnerProvisionedEmail } from "../services/sendgrid.service";
import { verifyToken } from "../utils/auth";
import { getFirestore } from "../utils/firestore";
import { validateAdminOnboardStudioPayload, validateAdminSubscriptionPayload } from "../utils/validation";
import { logAuditEvent } from "../services/audit.service";
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  next();
});

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
applySecurityMiddleware(app);

function baseResetUrl(req: Request): string {
  return process.env["PASSWORD_RESET_URL"] || `${req.headers.origin || "https://studios.danceup.app"}/reset-password`;
}

async function sendProvisioningEmail(req: Request, email: string, firstName: string, studioName: string): Promise<void> {
  const oobCode = await authService.generatePasswordResetOobCode(email);
  const resetUrl = `${baseResetUrl(req)}?oobCode=${encodeURIComponent(oobCode)}`;
  await sendStudioOwnerProvisionedEmail(email, firstName, studioName, resetUrl);
}

// POST / — create a real, login-capable studio owner account on a studio's behalf
// (e.g. after a sales call). Same account shape self-serve registration produces,
// minus a password (a random one is generated and immediately discarded — the
// studio gets in via a password-reset email, never a credential we chose for them)
// and minus Stripe Connect onboarding, which stays the studio owner's own task once
// they log in (their own bank/KYC details, not something an admin can provide).
app.post("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateAdminOnboardStudioPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid studio data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const {
      email, firstName, lastName, studioName,
      studioAddressLine1, studioAddressLine2, city, state, zip,
      facebook, instagram, tiktok, youtube, studioImageFile,
    } = req.body as Record<string, string | undefined>;

    let userRecord: admin.auth.UserRecord | undefined;
    let studioImageUrl: string | null = null;

    try {
      const randomPassword = crypto.randomBytes(24).toString("base64url");
      userRecord = await authService.createUser(email as string, randomPassword);

      if (studioImageFile && typeof studioImageFile === "string") {
        try {
          const fileBuffer = storageService.base64ToBuffer(studioImageFile);
          const mimeType = storageService.getMimeTypeFromBase64(studioImageFile);
          const fileName = `studio-image-${userRecord.uid}.${mimeType.split("/")[1]}`;
          studioImageUrl = await storageService.uploadStudioImage(fileBuffer, fileName, mimeType);
        } catch (imageError) {
          console.error("Error uploading studio image:", imageError);
        }
      }

      const userData: Record<string, unknown> = {
        email: userRecord.email,
        firstName: (firstName as string).trim(),
        lastName: (lastName as string).trim(),
        studioName: (studioName as string).trim(),
        studioAddressLine1: (studioAddressLine1 as string).trim(),
        studioAddressLine2: studioAddressLine2 ? studioAddressLine2.trim() : null,
        city: (city as string).trim(),
        state: (state as string).trim().toUpperCase(),
        zip: (zip as string).trim(),
        roles: ["student", "studio_owner"],
        studioImageUrl,
        facebook: facebook ? facebook.trim() : null,
        instagram: instagram ? instagram.trim() : null,
        tiktok: tiktok ? tiktok.trim() : null,
        youtube: youtube ? youtube.trim() : null,
        onboardedByAdmin: true,
        createdByAdminUid: user.uid,
      };

      const studioOwnerId = await authService.createUserDocument(userRecord.uid, userData);

      await logAuditEvent(user.uid, studioOwnerId, "studio_admin_onboarded", "studio", studioOwnerId, {
        studioName: (studioName as string).trim(),
        email: userRecord.email,
      });

      sendJsonResponse(req, res, 201, { id: studioOwnerId, email: userRecord.email });

      sendProvisioningEmail(req, userRecord.email as string, firstName as string, studioName as string).catch((err) => {
        console.error("Failed to send studio owner provisioning email:", err);
      });
    } catch (error) {
      if (userRecord) {
        await authService.deleteUser(userRecord.uid);
        if (studioImageUrl) {
          await storageService.deleteFile(studioImageUrl);
        }
      }
      throw error;
    }
  } catch (error) {
    console.error("danceup-admin-onboarding create error:", error);
    handleError(req, res, {
      status: 400,
      error: "Onboarding Failed",
      message: (error as Error).message || "Failed to create studio account",
    });
  }
});

// POST /:id/resend-invite — re-send the password-reset email, for when the admin
// created the account but the studio never got (or lost) the original email.
app.post("/:id/resend-invite", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const studioOwnerId = req.params["id"] as string;
    const studioDoc = await getFirestore().collection("users").doc(studioOwnerId).get();
    if (!studioDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Studio not found");

    const d = studioDoc.data() as Record<string, unknown>;
    const email = d["email"] as string | undefined;
    if (!email) return sendErrorResponse(req, res, 400, "Validation Error", "Studio has no email on file");

    await sendProvisioningEmail(req, email, (d["firstName"] as string) || "", (d["studioName"] as string) || "");

    sendJsonResponse(req, res, 200, { message: "Invite email resent" });
  } catch (error) {
    console.error("danceup-admin-onboarding resend-invite error:", error);
    handleError(req, res, error);
  }
});

// GET /tier-options — the same 3 real platform tiers the self-serve signup
// tier-picker shows (GET /stripe/products), reused unchanged: it already
// excludes anything that doesn't match a known tier pattern, which is exactly
// what an admin picker should show too.
app.get("/tier-options", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const products = await stripeService.getProducts();
    const options = products
      .filter((p) => p["monthlyPrice"])
      .map((p) => ({
        id: p["id"],
        name: p["name"],
        membershipTier: p["membershipTier"],
        description: p["description"] ?? null,
        monthlyPrice: p["monthlyPrice"],
        yearlyPrice: p["yearlyPrice"] ?? null,
      }));

    sendJsonResponse(req, res, 200, options);
  } catch (error) {
    console.error("danceup-admin-onboarding tier-options error:", error);
    handleError(req, res, error);
  }
});

// POST /:id/subscription — set up billing for a studio the admin already
// onboarded. Either a standard platform tier (priceId) or a one-off negotiated
// deal (customProduct). Billed via Stripe-hosted invoicing either way — no card
// ever touches danceup-admin; Stripe emails the studio a "Pay Now" page.
//
// customProduct.grantsTier is required and is what actually gets written as
// this studio's Firestore `membership` — studio-owners-app's route guard is a
// hard whitelist keyed on that exact field, so a synthetic "custom" value would
// leave the studio with a full-looking nav that 403s on almost every click. The
// Stripe product itself still gets metadata.membership_tier: "custom" so it
// never resolves as a real tier and stays out of the public signup picker —
// that's a separate concern from what Firestore says this studio can access.
app.post("/:id/subscription", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (!user.isAdmin) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const validation = validateAdminSubscriptionPayload(req.body);
    if (!validation.valid) {
      return sendErrorResponse(req, res, 400, "Validation Error", "Invalid subscription data", {
        errors: (validation as { valid: false; errors: unknown[] }).errors,
      });
    }

    const studioOwnerId = req.params["id"] as string;
    const studioDoc = await getFirestore().collection("users").doc(studioOwnerId).get();
    if (!studioDoc.exists) return sendErrorResponse(req, res, 404, "Not Found", "Studio not found");

    const studioData = studioDoc.data() as Record<string, unknown>;
    const email = studioData["email"] as string | undefined;
    const authUid = studioData["authUid"] as string | undefined;
    const studioName = (studioData["studioName"] as string) || "";
    if (!email) return sendErrorResponse(req, res, 400, "Validation Error", "Studio has no email on file");

    const body = req.body as { priceId?: string; customProduct?: { name: string; amountCents: number; interval: "month" | "year"; grantsTier: string } };

    let priceId: string;
    let membership: string;
    let isCustom = false;
    let createdProductId: string | null = null;

    if (body.customProduct) {
      isCustom = true;
      membership = body.customProduct.grantsTier;
      const { product, price } = await stripeService.createCustomMembershipProduct(
        body.customProduct.name,
        body.customProduct.amountCents,
        body.customProduct.interval,
        studioOwnerId,
        studioName,
        body.customProduct.grantsTier,
      );
      createdProductId = product.id;
      priceId = price.id;
    } else {
      const resolvedMembership = await stripeService.getMembershipForPriceId(body.priceId as string);
      if (!resolvedMembership) {
        return sendErrorResponse(req, res, 400, "Validation Error", "Invalid or unrecognized priceId");
      }
      membership = resolvedMembership;
      priceId = body.priceId as string;
    }

    try {
      const customer = await stripeService.createCustomer(email, {
        userId: studioOwnerId,
        authUid: authUid ?? "",
        membership,
      });

      const subscription = await stripeService.createInvoicedSubscription(customer.id, priceId, studioOwnerId, membership);

      const updateData: Record<string, unknown> = {
        membership,
        stripeCustomerId: customer.id,
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionStatus: subscription.status,
        subscriptionActive: subscription.status === "active",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (isCustom) updateData["hasCustomPricing"] = true;

      await studioDoc.ref.update(updateData);

      await logAuditEvent(user.uid, studioOwnerId, "studio_admin_subscription_created", "studio", studioOwnerId, {
        membership,
        priceId,
        isCustom,
        ...(isCustom ? { amountCents: body.customProduct?.amountCents } : {}),
      });

      sendJsonResponse(req, res, 200, {
        membership,
        stripeSubscriptionStatus: subscription.status,
        subscriptionActive: subscription.status === "active",
      });
    } catch (error) {
      if (createdProductId) {
        try {
          const stripe = await stripeService.getStripeClient() as import("stripe").default;
          await stripe.products.update(createdProductId, { active: false });
        } catch (cleanupError) {
          console.error("Failed to deactivate orphaned custom membership product:", cleanupError);
        }
      }
      throw error;
    }
  } catch (error) {
    console.error("danceup-admin-onboarding subscription error:", error);
    handleError(req, res, {
      status: 400,
      error: "Subscription Setup Failed",
      message: (error as Error).message || "Failed to set up subscription",
    });
  }
});

export const danceupAdminOnboarding = functions.https.onRequest(app);
