import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
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
const EXPAND = ["data.source", "data.source.charge"];

const PLAN_COLORS: Record<string, string> = {
  "Studio": "#8b5cf6",
  "Pro": "#6366f1",
  "Starter": "#22d3ee",
  "Free": "#64748b",
};

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

// --- Shared helpers (same logic as finance route) ---

function normalizeTxType(btType: string): "charge" | "refund" | "payout" | "other" {
  if (btType === "charge" || btType === "payment" || btType === "application_fee") return "charge";
  if (btType === "refund" || btType === "payment_refund" || btType === "application_fee_refund") return "refund";
  if (btType === "payout" || btType === "payout_failure") return "payout";
  return "other";
}

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
  if (btType === "charge" || btType === "payment") return source as Stripe.Charge;
  return null;
}

function grossAmount(bt: Stripe.BalanceTransaction): number {
  return bt.amount / 100;
}

function cardMethodStr(charge: Stripe.Charge): string | null {
  const card = charge.payment_method_details?.card;
  if (!card?.last4) return null;
  const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : "Card";
  return `${brand} •• ${card.last4}`;
}

function derivePlan(membership: string | null | undefined): string {
  if (membership === "ultimate") return "Studio";
  if (membership === "studio_owner") return "Pro";
  if (membership === "individual_instructor" || membership === "event_organizer") return "Starter";
  return "Free";
}

// Manual pagination helper (safe across all Stripe SDK versions)
async function fetchAllTxns(
  stripe: Stripe,
  params: Stripe.BalanceTransactionListParams,
  maxItems: number,
): Promise<Stripe.BalanceTransaction[]> {
  const all: Stripe.BalanceTransaction[] = [];
  let startingAfter: string | undefined;
  do {
    const p: Stripe.BalanceTransactionListParams = { ...params, limit: 100 };
    if (startingAfter) p.starting_after = startingAfter;
    const page = await stripe.balanceTransactions.list(p);
    all.push(...page.data);
    if (!page.has_more || all.length >= maxItems) break;
    startingAfter = page.data[page.data.length - 1]?.id;
  } while (true); // eslint-disable-line no-constant-condition
  return all.slice(0, maxItems);
}

interface OverviewTx {
  id: string;
  stripeId: string;
  type: string;
  amount: number;
  status: string;
  method: string | null;
  studioName: string | null;
  created: string;
}

function normalizeTx(bt: Stripe.BalanceTransaction, studioNames: Map<string, string>): OverviewTx | null {
  const type = normalizeTxType(bt.type);
  if (type === "other") return null;
  const source = bt.source as Stripe.ApplicationFee | Stripe.Charge | Stripe.Refund | Stripe.Payout | string | null;
  const charge = resolveCharge(bt.type, source);
  let studioName: string | null = null;
  let stripeId = typeof source === "string" ? source : (source as { id?: string })?.id ?? bt.id;
  let method: string | null = null;
  let amount = bt.amount / 100;

  if (type === "charge" && charge) {
    method = cardMethodStr(charge);
    const sid = charge.metadata?.["studioOwnerId"];
    if (sid) studioName = studioNames.get(sid) ?? null;
    stripeId = charge.id;
    if (bt.type === "application_fee") amount = charge.amount / 100;
  } else if (type === "refund" && source && typeof source !== "string") {
    stripeId = (source as Stripe.Refund).id;
  } else if (type === "payout" && source && typeof source !== "string") {
    stripeId = (source as Stripe.Payout).id;
  }

  return { id: bt.id, stripeId, type, amount, status: bt.status, method, studioName, created: new Date(bt.created * 1000).toISOString() };
}

// --- GET / — main dashboard snapshot ---

app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (user.email !== ADMIN_EMAIL) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const todayDate = new Date(nowMs);
    const year = todayDate.getFullYear();
    const month = todayDate.getMonth(); // 0-indexed

    const startOfYear = Math.floor(new Date(year, 0, 1).getTime() / 1000);
    const since30d = nowSec - 30 * 86400;
    const startOfThisMonth = Math.floor(new Date(year, month, 1).getTime() / 1000);
    const startOfLastMonth = Math.floor(new Date(year, month - 1, 1).getTime() / 1000);
    // Fetch from earliest needed point (handles January edge case where last month is Dec of previous year)
    const fetchFrom = Math.min(startOfYear, startOfLastMonth, since30d);

    const [stripe, db] = await Promise.all([getStripeClient(), Promise.resolve(getFirestore())]);

    const [allTxns, disputes, allStudiosSnap, pastDueSnap, incompleteSetupSnap] = await Promise.all([
      fetchAllTxns(stripe, { created: { gte: fetchFrom }, expand: EXPAND }, 3000),
      stripe.disputes.list({ limit: 10 }),
      db.collection("users").where("roles", "array-contains", "studio_owner").get(),
      db.collection("users").where("stripeSubscriptionStatus", "==", "past_due").get(),
      db.collection("users").where("stripeSetupCompleted", "==", false)
        .where("roles", "array-contains", "studio_owner").get(),
    ]);

    // Studio name lookup
    const studioNames = new Map<string, string>();
    for (const doc of allStudiosSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      studioNames.set(doc.id, (d["studioName"] as string) || "Unknown Studio");
    }

    // Partition by time range in app-code
    const last30dTxns = allTxns.filter(bt => bt.created >= since30d);
    const yearTxns    = allTxns.filter(bt => bt.created >= startOfYear);
    const lastMonthTxns = allTxns.filter(bt => bt.created >= startOfLastMonth && bt.created < startOfThisMonth);

    // MRR = gross charge revenue last 30 days; mrrTrend = daily bucket
    let mrr = 0;
    const mrrTrend = Array<number>(30).fill(0);
    for (const bt of last30dTxns) {
      if (normalizeTxType(bt.type) !== "charge") continue;
      const gross = grossAmount(bt);
      mrr += gross;
      const daysAgo = Math.floor((nowSec - bt.created) / 86400);
      const idx = 29 - daysAgo;
      if (idx >= 0 && idx < 30) mrrTrend[idx] = Math.round(((mrrTrend[idx] ?? 0) + gross) * 100) / 100;
    }
    mrr = Math.round(mrr * 100) / 100;

    // ARR = gross charge revenue current year; monthlyRevenue = monthly bucket
    let arr = 0;
    const monthlyRevenue = Array<number>(12).fill(0);
    for (const bt of yearTxns) {
      if (normalizeTxType(bt.type) !== "charge") continue;
      const gross = grossAmount(bt);
      arr += gross;
      const btMonth = new Date(bt.created * 1000).getMonth();
      monthlyRevenue[btMonth] = Math.round(((monthlyRevenue[btMonth] ?? 0) + gross) * 100) / 100;
    }
    arr = Math.round(arr * 100) / 100;

    // ARPU = last month gross / active studios
    let lastMonthGross = 0;
    for (const bt of lastMonthTxns) {
      if (normalizeTxType(bt.type) === "charge") lastMonthGross += grossAmount(bt);
    }

    // Studio KPIs from Firestore snapshot
    const activeStudios = allStudiosSnap.docs.filter(d => (d.data() as Record<string, unknown>)["subscriptionActive"] === true).length;
    const arpu = activeStudios > 0 ? Math.round((lastMonthGross / activeStudios) * 100) / 100 : 0;

    // Churn: studios that became inactive this month vs last month (from updatedAt field)
    const thisMonthStartMs = new Date(year, month, 1).getTime();
    const lastMonthStartMs = new Date(year, month - 1, 1).getTime();
    let churnCurrent = 0;
    let churnPrevious = 0;
    for (const doc of allStudiosSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      if (d["subscriptionActive"] !== false) continue;
      const updatedAt = d["updatedAt"] as admin.firestore.Timestamp | undefined;
      if (!updatedAt) continue;
      const ms = updatedAt.toDate().getTime();
      if (ms >= thisMonthStartMs) churnCurrent++;
      else if (ms >= lastMonthStartMs) churnPrevious++;
    }

    // Plan distribution
    const planCounts = new Map<string, number>();
    for (const doc of allStudiosSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const plan = derivePlan(d["membership"] as string | null | undefined);
      planCounts.set(plan, (planCounts.get(plan) ?? 0) + 1);
    }
    const planOrder = ["Studio", "Pro", "Starter", "Free"];
    const planDistribution = planOrder
      .filter(p => (planCounts.get(p) ?? 0) > 0)
      .map(p => ({ label: p, value: planCounts.get(p) ?? 0, color: PLAN_COLORS[p] ?? "#64748b" }));

    // New signups last 30 days
    const thirtyDaysAgoMs = nowMs - 30 * 86400 * 1000;
    const in7DaysMs = nowMs + 7 * 86400 * 1000;
    const newSignupsDailyTrend = Array<number>(30).fill(0);
    let newSignups30 = 0;
    const expiringTrials: typeof allStudiosSnap.docs = [];
    for (const doc of allStudiosSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      // New signups
      const createdAt = d["createdAt"] as admin.firestore.Timestamp | undefined;
      if (createdAt) {
        const ms = createdAt.toDate().getTime();
        if (ms >= thirtyDaysAgoMs) {
          newSignups30++;
          const daysAgo = Math.floor((nowMs - ms) / 86400000);
          const idx = 29 - daysAgo;
          if (idx >= 0 && idx < 30) newSignupsDailyTrend[idx] = (newSignupsDailyTrend[idx] ?? 0) + 1;
        }
      }
      // Expiring trials
      if (d["stripeSubscriptionStatus"] === "trialing") {
        const trialEnd = d["stripeTrialEnd"] as admin.firestore.Timestamp | undefined;
        if (trialEnd) {
          const ms = trialEnd.toDate().getTime();
          if (ms <= in7DaysMs && ms >= nowMs) expiringTrials.push(doc);
        }
      }
    }

    // Needs attention items
    const attention: { tone: string; icon: string; title: string; description: string; count: number }[] = [];

    if (pastDueSnap.size > 0) {
      attention.push({
        tone: "red", icon: "card",
        title: `${pastDueSnap.size} studio${pastDueSnap.size > 1 ? "s" : ""} with failed payments`,
        description: "Stripe subscription past due — payment retry failed",
        count: pastDueSnap.size,
      });
    }
    if (disputes.data.length > 0) {
      const atRisk = disputes.data.reduce((s, d) => s + d.amount / 100, 0);
      attention.push({
        tone: "red", icon: "alert",
        title: `${disputes.data.length} open dispute${disputes.data.length > 1 ? "s" : ""} need response`,
        description: `$${atRisk.toFixed(0)} at risk · respond within 7 days`,
        count: disputes.data.length,
      });
    }
    if (expiringTrials.length > 0) {
      attention.push({
        tone: "amber", icon: "clock",
        title: `${expiringTrials.length} trial${expiringTrials.length > 1 ? "s" : ""} expiring within 7 days`,
        description: "Convert before trial ends to avoid churn",
        count: expiringTrials.length,
      });
    }
    if (incompleteSetupSnap.size > 0) {
      attention.push({
        tone: "violet", icon: "shield",
        title: `${incompleteSetupSnap.size} studio${incompleteSetupSnap.size > 1 ? "s haven't" : " hasn't"} connected Stripe`,
        description: "Can't accept payments until Stripe is connected",
        count: incompleteSetupSnap.size,
      });
    }

    // Recent transactions — first 10 normalized from last-30d batch
    const normalizedPairs = last30dTxns
      .map(bt => ({ bt, tx: normalizeTx(bt, studioNames) }))
      .filter((p): p is { bt: Stripe.BalanceTransaction; tx: OverviewTx } => p.tx !== null);
    const transactions = normalizedPairs.slice(0, 10).map(p => p.tx);
    const hasMoreTransactions = normalizedPairs.length > 10;
    const nextTransactionCursor = hasMoreTransactions ? normalizedPairs[9]!.bt.id : null;

    sendJsonResponse(req, res, 200, {
      kpis: { mrr, arr, activeStudios, churnRate: { current: churnCurrent, previous: churnPrevious }, arpu },
      mrrTrend,
      monthlyRevenue,
      planDistribution,
      attention,
      newSignups30,
      newSignupsDailyTrend,
      totalStudios: allStudiosSnap.size,
      transactions,
      hasMoreTransactions,
      nextTransactionCursor,
    });
  } catch (error) {
    console.error("danceup-admin-overview GET / error:", error);
    handleError(req, res, error);
  }
});

// --- GET /transactions — paginated ---

app.get("/transactions", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }
    if (user.email !== ADMIN_EMAIL) return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");

    const startingAfter = req.query["startingAfter"] as string | undefined;
    const [stripe, db] = await Promise.all([getStripeClient(), Promise.resolve(getFirestore())]);

    const params: Stripe.BalanceTransactionListParams = { limit: 10, expand: EXPAND };
    if (startingAfter) params.starting_after = startingAfter;

    const [list, studiosSnap] = await Promise.all([
      stripe.balanceTransactions.list(params),
      db.collection("users").where("roles", "array-contains", "studio_owner").get(),
    ]);

    const studioNames = new Map<string, string>();
    for (const doc of studiosSnap.docs) {
      const d = doc.data() as Record<string, unknown>;
      studioNames.set(doc.id, (d["studioName"] as string) || "Unknown Studio");
    }

    const transactions = list.data
      .map(bt => normalizeTx(bt, studioNames))
      .filter((t): t is OverviewTx => t !== null);

    sendJsonResponse(req, res, 200, {
      transactions,
      hasMore: list.has_more,
      nextCursor: list.has_more ? list.data[list.data.length - 1]?.id ?? null : null,
    });
  } catch (error) {
    console.error("danceup-admin-overview GET /transactions error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminOverview = functions.https.onRequest(app);
