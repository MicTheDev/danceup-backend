import * as functions from "firebase-functions";
import express, { Request, Response } from "express";
import cors from "cors";
import Stripe from "stripe";
import { verifyToken } from "../utils/auth";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";
import { getFirestore } from "../utils/firestore";
import { getStripeClient } from "../services/stripe.service";

const ADMIN_EMAIL = "info@danceup.app";
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

const app = express();

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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
app.use(express.json());
applySecurityMiddleware(app);

function normalizeTxType(btType: string): "charge" | "refund" | "payout" | "other" {
  if (btType === "charge" || btType === "payment" || btType === "application_fee") return "charge";
  if (btType === "refund" || btType === "payment_refund" || btType === "application_fee_refund") return "refund";
  if (btType === "payout" || btType === "payout_failure") return "payout";
  return "other";
}

function cardMethodStr(charge: Stripe.Charge): string | null {
  const card = charge.payment_method_details?.card;
  if (!card || !card.last4) return null;
  const brand = card.brand
    ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1)
    : "Card";
  return `${brand} •• ${card.last4}`;
}

// For application_fee balance transactions the source is an ApplicationFee,
// and the underlying charge is nested at source.charge (expanded separately).
function resolveCharge(
  btType: string,
  source: Stripe.ApplicationFee | Stripe.Charge | Stripe.Refund | Stripe.Payout | string | null,
): Stripe.Charge | null {
  if (!source || typeof source === "string") return null;

  if (btType === "application_fee" || btType === "application_fee_refund") {
    const appFee = source as Stripe.ApplicationFee;
    const c = appFee.charge;
    return c && typeof c !== "string" ? (c as Stripe.Charge) : null;
  }

  if (btType === "charge" || btType === "payment") {
    return source as Stripe.Charge;
  }

  return null;
}

app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    if (user.email !== ADMIN_EMAIL) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const now = Math.floor(Date.now() / 1000);
    const since30d = now - THIRTY_DAYS_S;

    const [stripe, db] = await Promise.all([
      getStripeClient(),
      Promise.resolve(getFirestore()),
    ]);

    // Expand data.source to get ApplicationFee/Charge objects,
    // and data.source.charge to get the underlying charge nested inside ApplicationFee.
    const [balTxns, balance, disputes, payouts, studiosSnap] = await Promise.all([
      stripe.balanceTransactions.list({
        limit: 100,
        expand: ["data.source", "data.source.charge"],
      }),
      stripe.balance.retrieve(),
      stripe.disputes.list({ limit: 50, expand: ["data.charge"] }),
      stripe.payouts.list({ limit: 10 }),
      db.collection("users").where("roles", "array-contains", "studio_owner").get(),
    ]);

    // studioOwnerId (Firestore doc id) → studioName
    const studioNames = new Map<string, string>();
    for (const doc of studiosSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      studioNames.set(doc.id, (d["studioName"] as string) || "Unknown Studio");
    }

    // Normalize balance transactions
    const transactions = balTxns.data
      .map((bt) => {
        const type = normalizeTxType(bt.type);
        if (type === "other") return null;

        const source = bt.source as
          | Stripe.ApplicationFee
          | Stripe.Charge
          | Stripe.Refund
          | Stripe.Payout
          | string
          | null;

        let method: string | null = null;
        let studioName: string | null = null;
        let studioId: string | null = null;
        let stripeId = typeof source === "string" ? source : (source as { id?: string })?.id ?? "";

        // displayAmount:
        //  - For application_fee: show the gross charge amount (what the customer paid)
        //  - For charge/payment: show the charge amount
        //  - For refund/payout: bt.amount (negative)
        let displayAmount = bt.amount / 100;
        // platformFee: for application_fee, bt.amount IS the platform fee directly
        let platformFee = 0;

        if (type === "charge") {
          const charge = resolveCharge(bt.type, source);
          if (charge) {
            method = cardMethodStr(charge);
            const sid = charge.metadata?.["studioOwnerId"];
            if (sid) { studioId = sid; studioName = studioNames.get(sid) ?? null; }
            stripeId = charge.id;
            if (bt.type === "application_fee") {
              // bt.amount = the application fee (platform's cut)
              // charge.amount = gross transaction amount
              displayAmount = charge.amount / 100;
              platformFee = bt.amount / 100;
            } else {
              platformFee = Math.round((0.30 + displayAmount * 0.015) * 100) / 100;
            }
          } else if (bt.type === "application_fee") {
            // Charge not expanded — platform fee is still bt.amount
            platformFee = bt.amount / 100;
          }
        } else if (type === "refund" && source && typeof source !== "string") {
          stripeId = (source as Stripe.Refund).id;
        } else if (type === "payout" && source && typeof source !== "string") {
          stripeId = (source as Stripe.Payout).id;
        }

        return {
          id: bt.id,
          stripeId,
          type,
          amount: displayAmount,
          fee: bt.fee / 100,
          platformFee,
          status: bt.status,
          method,
          studioName,
          studioId,
          created: new Date(bt.created * 1000).toISOString(),
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    // KPIs from last 30 days
    const recent = balTxns.data.filter((bt) => bt.created >= since30d);

    let grossVolume30d = 0;
    let platformFees30d = 0;
    let refunds30d = 0;
    let stripeFees30d = 0;
    const feeTrend = Array(30).fill(0) as number[];

    for (const bt of recent) {
      const type = normalizeTxType(bt.type);

      if (type === "charge") {
        const source = bt.source as Stripe.ApplicationFee | Stripe.Charge | string | null;
        const charge = resolveCharge(bt.type, source);
        const platformFeeAmt = bt.type === "application_fee"
          ? bt.amount / 100                                    // direct: app fee amount
          : Math.round((0.30 + (bt.amount / 100) * 0.015) * 100) / 100; // computed: $0.30 + 1.5%
        const grossAmt = charge
          ? charge.amount / 100
          : bt.type === "application_fee"
            ? bt.amount / 100 / 0.05                           // estimate if charge not resolved
            : bt.amount / 100;

        grossVolume30d += grossAmt;
        platformFees30d += platformFeeAmt;
        stripeFees30d += bt.fee / 100;

        const daysAgo = Math.floor((now - bt.created) / 86400);
        const idx = 29 - daysAgo;
        if (idx >= 0 && idx < 30) {
          feeTrend[idx] = Math.round(((feeTrend[idx] ?? 0) + platformFeeAmt) * 100) / 100;
        }
      } else if (type === "refund") {
        refunds30d += Math.abs(bt.amount) / 100;
      }
    }

    grossVolume30d   = Math.round(grossVolume30d   * 100) / 100;
    platformFees30d  = Math.round(platformFees30d  * 100) / 100;
    refunds30d       = Math.round(refunds30d        * 100) / 100;
    stripeFees30d    = Math.round(stripeFees30d     * 100) / 100;

    // Available and pending balance
    const availableBalance = Math.round(
      balance.available.reduce((s, b) => s + b.amount / 100, 0) * 100,
    ) / 100;
    const pendingBalance = Math.round(
      balance.pending.reduce((s, b) => s + b.amount / 100, 0) * 100,
    ) / 100;

    // Next payout
    const pendingPayout = payouts.data.find(
      (p) => p.status === "pending" || p.status === "in_transit",
    );
    const nextPayoutDate = pendingPayout
      ? new Date(pendingPayout.arrival_date * 1000).toISOString()
      : null;

    // Disputes
    const disputeList = disputes.data.map((d) => {
      const charge = d.charge as Stripe.Charge | string | null;
      let method: string | null = null;
      let studioName: string | null = null;
      let studioId: string | null = null;
      if (charge && typeof charge !== "string") {
        method = cardMethodStr(charge);
        const sid = charge.metadata?.["studioOwnerId"];
        if (sid) { studioId = sid; studioName = studioNames.get(sid) ?? null; }
      }
      return {
        id: d.id,
        chargeId: typeof d.charge === "string" ? d.charge : (d.charge as Stripe.Charge)?.id ?? "",
        amount: d.amount / 100,
        status: d.status,
        studioName,
        studioId,
        method,
        created: new Date(d.created * 1000).toISOString(),
      };
    });

    // Recent payouts
    const payoutList = payouts.data.map((p) => ({
      id: p.id,
      amount: p.amount / 100,
      status: p.status,
      arrivalDate: new Date(p.arrival_date * 1000).toISOString(),
      created: new Date(p.created * 1000).toISOString(),
    }));

    sendJsonResponse(req, res, 200, {
      kpis: {
        grossVolume30d,
        platformFees30d,
        refunds30d,
        availableBalance,
        pendingBalance,
        nextPayoutDate,
      },
      transactions,
      disputes: disputeList,
      payouts: payoutList,
      feeBreakdown: {
        bookingFees: platformFees30d,
        stripeFees: stripeFees30d,
        netRevenue: Math.round((platformFees30d - stripeFees30d) * 100) / 100,
      },
      feeTrend,
    });
  } catch (error) {
    console.error("danceup-admin-finance error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminFinance = functions.https.onRequest(app);
