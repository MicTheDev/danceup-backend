import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";

// Pure data-assembly for the AI Insights feature, extracted from routes/ai.ts so the exact
// same queries/math can be reused by both the existing /ai/* HTTP endpoints and the Co-Pilot's
// Pro+ read tools (assistant.service.ts), rather than duplicating this logic in two places.
// This is a mechanical extraction, not a rewrite — behavior must stay byte-for-byte identical
// to what routes/ai.ts did inline before this file existed.

async function getStudioName(studioOwnerId: string): Promise<string> {
  const db = getFirestore();
  const doc = await db.collection("users").doc(studioOwnerId).get();
  return doc.exists ? ((doc.data() as Record<string, unknown>)["studioName"] as string) || "Your Studio" : "Your Studio";
}

// ─── Revenue forecast ───────────────────────────────────────────────────────

export interface MonthlyRevenueEntry {
  month: string;
  revenue: number;
  stripe: number;
  cash: number;
}

// Shared by revenue-forecast (last 6 months) and income-goal progress (year-to-date) —
// same purchases/cashPurchases aggregation, just a different `since` cutoff.
export async function getMonthlyRevenueSince(studioOwnerId: string, since: Date): Promise<MonthlyRevenueEntry[]> {
  const db = getFirestore();
  const [purchasesSnap, cashPurchasesSnap] = await Promise.all([
    db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
    db.collection("cashPurchases").where("studioOwnerId", "==", studioOwnerId).get(),
  ]);

  const monthlyMap: Record<string, { stripe: number; cash: number }> = {};
  purchasesSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    if (d["status"] && d["status"] !== "completed") return;
    if (d["paymentMethod"] === "cash") return;
    const ts = d["createdAt"] as { toDate?: () => Date } | null;
    const createdAt = ts?.toDate ? ts.toDate() : null;
    if (!createdAt || createdAt < since) return;
    const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyMap[key]) monthlyMap[key] = { stripe: 0, cash: 0 };
    monthlyMap[key]!.stripe += ((d["price"] as number) ?? (d["amount"] as number) ?? 0);
  });

  cashPurchasesSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    if (d["status"] && d["status"] !== "completed") return;
    const ts = d["createdAt"] as { toDate?: () => Date } | null;
    const createdAt = ts?.toDate ? ts.toDate() : null;
    if (!createdAt || createdAt < since) return;
    const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyMap[key]) monthlyMap[key] = { stripe: 0, cash: 0 };
    monthlyMap[key]!.cash += ((d["amount"] as number) ?? 0);
  });

  return Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { stripe, cash }]) => {
      const [year, month] = key.split("-");
      const date = new Date(Number(year), Number(month) - 1, 1);
      return { month: date.toLocaleDateString("en-US", { month: "short", year: "numeric" }), revenue: stripe + cash, stripe, cash };
    });
}

export interface RevenueForecastInput {
  studioName: string;
  monthlyRevenue: MonthlyRevenueEntry[];
  activeSubscriptions: number;
  avgMonthlyGrowth: number;
  cashPercent: number;
}

export async function buildRevenueForecastInput(studioOwnerId: string): Promise<RevenueForecastInput | null> {
  const db = getFirestore();
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(now.getMonth() - 6);

  const [monthlyRevenue, packagesSnap, studioName] = await Promise.all([
    getMonthlyRevenueSince(studioOwnerId, sixMonthsAgo),
    db.collection("packages").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
    getStudioName(studioOwnerId),
  ]);

  if (monthlyRevenue.length === 0) return null;

  let activeSubscriptions = 0;
  packagesSnap.forEach((doc) => {
    if ((doc.data() as Record<string, unknown>)["isRecurring"]) activeSubscriptions++;
  });

  let avgMonthlyGrowth = 0;
  if (monthlyRevenue.length >= 2) {
    const growthRates: number[] = [];
    for (let i = 1; i < monthlyRevenue.length; i++) {
      const prev = monthlyRevenue[i - 1]?.revenue ?? 0;
      const curr = monthlyRevenue[i]?.revenue ?? 0;
      if (prev > 0) growthRates.push(((curr - prev) / prev) * 100);
    }
    if (growthRates.length > 0) {
      avgMonthlyGrowth = Math.round(growthRates.reduce((a, b) => a + b, 0) / growthRates.length * 10) / 10;
    }
  }

  const totalCash = monthlyRevenue.reduce((s, m) => s + m.cash, 0);
  const totalStripe = monthlyRevenue.reduce((s, m) => s + m.stripe, 0);
  const cashPercent = (totalStripe + totalCash) > 0 ? Math.round((totalCash / (totalStripe + totalCash)) * 100) : 0;

  return { studioName, monthlyRevenue, activeSubscriptions, avgMonthlyGrowth, cashPercent };
}

// ─── Class demand analysis ──────────────────────────────────────────────────

export interface ClassDemandInput {
  studioName: string;
  classes: Array<{
    classId: string; name: string; genre: string; level: string; dayOfWeek: string;
    startTime: string; maxCapacity: number; fillRate: number; checkIns: number;
  }>;
}

export async function buildClassDemandInput(studioOwnerId: string): Promise<ClassDemandInput | null> {
  const db = getFirestore();
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  const [classesSnap, attendanceSnap, studioName] = await Promise.all([
    db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
    db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
      .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
    getStudioName(studioOwnerId),
  ]);

  const checkInsMap: Record<string, number> = {};
  attendanceSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    if (d["isRemoved"]) return;
    const cid = d["classId"] as string;
    checkInsMap[cid] = (checkInsMap[cid] || 0) + 1;
  });

  const DAY_TO_SESSIONS: Record<string, number> = { Monday: 4, Tuesday: 4, Wednesday: 4, Thursday: 4, Friday: 4, Saturday: 4, Sunday: 4 };

  const classes: ClassDemandInput["classes"] = [];
  classesSnap.forEach((doc) => {
    const c = doc.data() as Record<string, unknown>;
    const checkIns = checkInsMap[doc.id] || 0;
    const sessions = DAY_TO_SESSIONS[c["dayOfWeek"] as string] || 4;
    const maxCapacity = (c["maxCapacity"] as number) || 20;
    const fillRate = Math.min(100, Math.round((checkIns / (sessions * maxCapacity)) * 100));
    classes.push({
      classId: doc.id, name: c["name"] as string, genre: (c["danceGenre"] as string) || "General",
      level: (c["level"] as string) || "All Levels", dayOfWeek: (c["dayOfWeek"] as string) || "TBD",
      startTime: (c["startTime"] as string) || "TBD", maxCapacity, fillRate, checkIns,
    });
  });

  if (classes.length === 0) return null;
  return { studioName, classes };
}

// ─── Promo trigger suggestions ──────────────────────────────────────────────

export interface PromoTriggerClass {
  classId: string; name: string; genre: string; dayOfWeek: string; startTime: string;
  maxCapacity: number; weeklyFillRates: number[]; avgFillRate: number;
}

export interface PromoTriggerInput {
  studioName: string;
  underperformingClasses: PromoTriggerClass[];
}

export async function buildPromoTriggerInput(studioOwnerId: string): Promise<PromoTriggerInput | null> {
  const db = getFirestore();
  const now = new Date();
  const twentyEightDaysAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

  const [classesSnap, attendanceSnap, studioName] = await Promise.all([
    db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
    db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).where("isRemoved", "==", false).get(),
    getStudioName(studioOwnerId),
  ]);

  const weekBoundaries = [0, 1, 2, 3, 4].map((i) => new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000));

  const weeklyMap = new Map<string, number[]>();
  classesSnap.forEach((doc) => weeklyMap.set(doc.id, [0, 0, 0, 0]));

  attendanceSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const cid = d["classId"] as string | undefined;
    if (!cid || !weeklyMap.has(cid)) return;
    const ts = d["classInstanceDate"] as { toDate?: () => Date } | null;
    const date = ts?.toDate ? ts.toDate() : null;
    if (!date || date < twentyEightDaysAgo) return;
    const weekCounts = weeklyMap.get(cid);
    if (weekCounts) {
      for (let w = 0; w < 4; w++) {
        if (date < weekBoundaries[w]! && date >= weekBoundaries[w + 1]!) {
          weekCounts[w] = (weekCounts[w] ?? 0) + 1;
          break;
        }
      }
    }
  });

  const underperforming: PromoTriggerClass[] = [];
  classesSnap.forEach((doc) => {
    const c = doc.data() as Record<string, unknown>;
    const maxCapacity = (c["maxCapacity"] as number) || 20;
    const weekly = weeklyMap.get(doc.id) || [0, 0, 0, 0];
    const weeklyFillRates = weekly.map((count) => Math.min(100, Math.round((count / maxCapacity) * 100)));
    const weeksBelow40 = weeklyFillRates.filter((r) => r < 40).length;
    if (weeksBelow40 >= 2) {
      const avgFillRate = Math.round(weeklyFillRates.reduce((a, b) => a + b, 0) / weeklyFillRates.length);
      underperforming.push({
        classId: doc.id, name: c["name"] as string, genre: (c["danceGenre"] as string) || "General",
        dayOfWeek: (c["dayOfWeek"] as string) || "TBD", startTime: (c["startTime"] as string) || "TBD",
        maxCapacity, weeklyFillRates, avgFillRate,
      });
    }
  });

  if (underperforming.length === 0) return null;
  return { studioName, underperformingClasses: underperforming };
}

// ─── Schedule health ────────────────────────────────────────────────────────

export interface ScheduleHealthInput {
  studioName: string;
  scheduleContext: string;
  coverageGaps: string;
}

export async function buildScheduleHealthInput(studioOwnerId: string): Promise<ScheduleHealthInput> {
  const db = getFirestore();
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  const [classesSnap, attendanceSnap, studioName] = await Promise.all([
    db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
    db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
      .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
    getStudioName(studioOwnerId),
  ]);

  const checkInsMap: Record<string, number> = {};
  attendanceSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    if (d["isRemoved"]) return;
    const cid = d["classId"] as string;
    checkInsMap[cid] = (checkInsMap[cid] || 0) + 1;
  });

  const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const byDay: Record<string, string[]> = {};
  classesSnap.forEach((doc) => {
    const c = doc.data() as Record<string, unknown>;
    const day = (c["dayOfWeek"] as string) || "Unscheduled";
    if (!byDay[day]) byDay[day] = [];
    const sessions = 4;
    const maxCapacity = (c["maxCapacity"] as number) || 20;
    const checkIns = checkInsMap[doc.id] || 0;
    const fillRate = Math.min(100, Math.round((checkIns / (sessions * maxCapacity)) * 100));
    byDay[day]!.push(`${c["startTime"] || "?"} – ${c["endTime"] || "?"}: "${c["name"]}" (${c["danceGenre"] || "?"}, ${c["level"] || "All Levels"}) — fill rate ${fillRate}%`);
  });

  const scheduleLines = DAY_ORDER
    .filter((d) => byDay[d])
    .map((d) => `${d}:\n${(byDay[d] as string[]).map((l) => `  • ${l}`).join("\n")}`);

  if (scheduleLines.length === 0 && Object.keys(byDay).length > 0) {
    scheduleLines.push(`Unscheduled:\n${(byDay["Unscheduled"] || []).map((l) => `  • ${l}`).join("\n")}`);
  }
  const scheduleContext = scheduleLines.join("\n\n") || "No active classes scheduled.";

  const coveredDays = new Set(Object.keys(byDay));
  const missingDays = DAY_ORDER.filter((d) => !coveredDays.has(d));
  const genreSet = new Set<string>();
  const levelSet = new Set<string>();
  classesSnap.forEach((doc) => {
    const c = doc.data() as Record<string, unknown>;
    if (c["danceGenre"]) genreSet.add(c["danceGenre"] as string);
    if (c["level"]) levelSet.add(c["level"] as string);
  });

  const coverageGaps = [
    missingDays.length > 0 ? `No classes on: ${missingDays.join(", ")}` : "All 7 days have at least one class.",
    `Genres offered: ${genreSet.size > 0 ? [...genreSet].join(", ") : "None"}`,
    `Levels offered: ${levelSet.size > 0 ? [...levelSet].join(", ") : "None"}`,
    !levelSet.has("Beginner") && !levelSet.has("beginner") ? "No beginner-level classes detected — potential barrier to new students." : "",
  ].filter(Boolean).join("\n");

  return { studioName, scheduleContext, coverageGaps };
}

// ─── Student LTV ────────────────────────────────────────────────────────────

export interface StudentLTVEntry {
  studentId: string; name: string; totalSpent: number; monthsAsCustomer: number;
  avgMonthlySpend: number; projected12Month: number;
}

export interface StudentLTVInput {
  studioName: string;
  allEntries: StudentLTVEntry[];
  topStudents: StudentLTVEntry[];
  avgLTV: number;
  totalStudents: number;
}

export async function buildStudentLTVInput(studioOwnerId: string): Promise<StudentLTVInput | null> {
  const db = getFirestore();
  const [studentsSnap, purchasesSnap, cashPurchasesSnap, studioName] = await Promise.all([
    db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
    db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
    db.collection("cashPurchases").where("studioOwnerId", "==", studioOwnerId).get(),
    getStudioName(studioOwnerId),
  ]);

  const studentMeta = new Map<string, { name: string; joinedAt: Date | null }>();
  studentsSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const ts = d["createdAt"] as { toDate?: () => Date } | null;
    studentMeta.set(doc.id, {
      name: `${d["firstName"] || ""} ${d["lastName"] || ""}`.trim() || "Unknown",
      joinedAt: ts?.toDate ? ts.toDate() : null,
    });
  });

  const spendMap = new Map<string, { total: number; firstPurchase: Date | null }>();
  const processDoc = (d: Record<string, unknown>) => {
    if (d["status"] && d["status"] !== "completed") return;
    const sid = d["studentId"] as string | undefined;
    if (!sid || !studentMeta.has(sid)) return;
    const ts = d["createdAt"] as { toDate?: () => Date } | null;
    const purchaseDate = ts?.toDate ? ts.toDate() : null;
    const amount = (d["price"] as number) ?? (d["amount"] as number) ?? 0;
    if (!spendMap.has(sid)) spendMap.set(sid, { total: 0, firstPurchase: null });
    const entry = spendMap.get(sid)!;
    entry.total += amount;
    if (purchaseDate && (!entry.firstPurchase || purchaseDate < entry.firstPurchase)) {
      entry.firstPurchase = purchaseDate;
    }
  };
  purchasesSnap.forEach((doc) => processDoc(doc.data() as Record<string, unknown>));
  cashPurchasesSnap.forEach((doc) => processDoc(doc.data() as Record<string, unknown>));

  const now = new Date();
  const ltvEntries: StudentLTVEntry[] = [];
  studentMeta.forEach((meta, sid) => {
    const spend = spendMap.get(sid);
    const totalSpent = spend?.total ?? 0;
    const firstDate = spend?.firstPurchase ?? meta.joinedAt ?? null;
    const monthsAsCustomer = firstDate
      ? Math.max(1, Math.round((now.getTime() - firstDate.getTime()) / (30 * 24 * 60 * 60 * 1000)))
      : 1;
    const avgMonthlySpend = totalSpent / monthsAsCustomer;
    const projected12Month = avgMonthlySpend * 12;
    ltvEntries.push({ studentId: sid, name: meta.name, totalSpent, monthsAsCustomer, avgMonthlySpend, projected12Month });
  });

  ltvEntries.sort((a, b) => b.totalSpent - a.totalSpent);

  const totalStudents = ltvEntries.length;
  if (totalStudents === 0) return null;
  const avgLTV = ltvEntries.reduce((sum, e) => sum + e.totalSpent, 0) / totalStudents;

  return { studioName, allEntries: ltvEntries, topStudents: ltvEntries.slice(0, 10), avgLTV, totalStudents };
}

// ─── Instructor performance ─────────────────────────────────────────────────

export interface InstructorPerformanceEntry {
  name: string; classCount: number; totalCheckIns: number; avgFillRate: number;
  avgRating: number | null; reviewCount: number;
}

export interface InstructorPerformanceInput {
  studioName: string;
  instructors: InstructorPerformanceEntry[];
}

export async function buildInstructorPerformanceInput(studioOwnerId: string): Promise<InstructorPerformanceInput | null> {
  const db = getFirestore();
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  const [instructorsSnap, classesSnap, attendanceSnap, reviewsSnap, studioName] = await Promise.all([
    db.collection("instructors").where("studioOwnerId", "==", studioOwnerId).get(),
    db.collection("classes").where("studioOwnerId", "==", studioOwnerId).where("isActive", "==", true).get(),
    db.collection("attendance").where("studioOwnerId", "==", studioOwnerId)
      .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(thirtyDaysAgo)).get(),
    db.collection("reviews").where("studioOwnerId", "==", studioOwnerId).where("entityType", "==", "instructor").get(),
    getStudioName(studioOwnerId),
  ]);

  const classMap: Record<string, { instructorIds: string[]; maxCapacity: number }> = {};
  classesSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    classMap[doc.id] = { instructorIds: (d["instructorIds"] as string[]) || [], maxCapacity: (d["maxCapacity"] as number) || 20 };
  });

  const instructorStats: Record<string, { checkIns: number; sessionDates: Set<string> }> = {};
  attendanceSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    if (d["isRemoved"]) return;
    const cls = classMap[d["classId"] as string];
    if (!cls || !cls.instructorIds || cls.instructorIds.length === 0) return;
    const ts = d["classInstanceDate"] as { toDate?: () => Date } | null;
    const dateKey = ts?.toDate ? ts.toDate().toISOString().split("T")[0] || "" : "";
    for (const iid of cls.instructorIds) {
      if (!instructorStats[iid]) instructorStats[iid] = { checkIns: 0, sessionDates: new Set() };
      instructorStats[iid]!.checkIns++;
      if (dateKey) instructorStats[iid]!.sessionDates.add(`${d["classId"] as string}_${dateKey}`);
    }
  });

  const reviewStats: Record<string, { total: number; count: number }> = {};
  reviewsSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const iid = d["entityId"] as string;
    if (!iid) return;
    if (!reviewStats[iid]) reviewStats[iid] = { total: 0, count: 0 };
    reviewStats[iid]!.total += (d["rating"] as number) || 0;
    reviewStats[iid]!.count++;
  });

  const classCountMap: Record<string, number> = {};
  classesSnap.forEach((doc) => {
    for (const iid of ((doc.data() as Record<string, unknown>)["instructorIds"] as string[] || [])) {
      classCountMap[iid] = (classCountMap[iid] || 0) + 1;
    }
  });

  const instructors: InstructorPerformanceEntry[] = [];
  instructorsSnap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const iid = doc.id;
    const stats = instructorStats[iid] || { checkIns: 0, sessionDates: new Set<string>() };
    const sessions = stats.sessionDates ? stats.sessionDates.size : 0;
    const classCount = classCountMap[iid] || 0;
    const avgCapacity = classCount > 0
      ? classesSnap.docs
        .filter((c) => ((c.data() as Record<string, unknown>)["instructorIds"] as string[] || []).includes(iid))
        .reduce((sum, c) => sum + ((c.data() as Record<string, unknown>)["maxCapacity"] as number || 20), 0) / classCount
      : 20;
    const avgFillRate = sessions > 0 ? Math.min(100, Math.round(((stats.checkIns / sessions) / avgCapacity) * 100)) : 0;

    const revStats = reviewStats[iid];
    const avgRating = revStats && revStats.count > 0 ? Math.round((revStats.total / revStats.count) * 10) / 10 : null;

    instructors.push({
      name: `${d["firstName"] || ""} ${d["lastName"] || ""}`.trim() || "Unknown",
      classCount, totalCheckIns: stats.checkIns, avgFillRate, avgRating, reviewCount: revStats ? revStats.count : 0,
    });
  });

  if (instructors.length === 0) return null;
  return { studioName, instructors };
}
