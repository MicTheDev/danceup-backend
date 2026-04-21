import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";
import attendanceService from "./attendance.service";
import studentsService from "./students.service";

interface AtRiskStudent {
  id: string;
  firstName: string;
  lastName: string;
  credits: number;
  lastAttendance: string | null;
  daysSinceAttendance: number | null;
  neverAttended: boolean;
}

interface MostActiveStudent {
  id: string;
  firstName: string;
  lastName: string;
  checkIns30Days: number;
}

interface EngagementStats {
  totalStudents: number;
  atRiskCount: number;
  activeThisMonth: number;
  avgCheckInsPerActiveStudent: number;
  studentsWithCredits: number;
  atRiskWithCredits: number;
}

export async function getInsightsData(studioOwnerId: string): Promise<{
  studioName: string;
  dashboardStats: Record<string, unknown>;
  topClasses: Array<{ name: string; totalAttendance: number }>;
  classStats: Record<string, unknown>;
}> {
  const db = getFirestore();
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  const [dashboardStats, classStats, studioDoc] = await Promise.all([
    attendanceService.getDashboardStats(studioOwnerId),
    attendanceService.getClassAttendanceStats(studioOwnerId, thirtyDaysAgo, now),
    db.collection("users").doc(studioOwnerId).get(),
  ]);

  const studioName = studioDoc.exists
    ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string) || "Your Studio"
    : "Your Studio";

  const byClass = (classStats as Record<string, unknown>)["byClass"] as Array<Record<string, unknown>> | undefined;
  const topClasses = (byClass || []).slice(0, 8).map((c) => ({
    name: (c["className"] as string) || "Unknown Class",
    totalAttendance: c["totalAttendance"] as number,
  }));

  return { studioName, dashboardStats: dashboardStats as unknown as Record<string, unknown>, topClasses, classStats: classStats as unknown as Record<string, unknown> };
}

export async function getEngagementData(studioOwnerId: string): Promise<{
  atRisk: AtRiskStudent[];
  mostActive: MostActiveStudent[];
  stats: EngagementStats;
}> {
  const db = getFirestore();
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(now.getDate() - 90);
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);

  const [studentsSnap, attendanceSnap] = await Promise.all([
    db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
    db.collection("attendance")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(ninetyDaysAgo))
      .get(),
  ]);

  const lastAttendanceDate: Record<string, Date> = {};
  const checkIns30Days: Record<string, number> = {};

  attendanceSnap.docs.forEach((doc) => {
    const data = doc.data() as Record<string, unknown>;
    if (data["isRemoved"]) return;
    const sid = data["studentId"] as string;
    const rawDate = data["classInstanceDate"] as { toDate?: () => Date } | string | undefined;
    const date = typeof rawDate === "object" && rawDate !== null && typeof rawDate.toDate === "function"
      ? rawDate.toDate()
      : new Date(rawDate as string);

    if (!lastAttendanceDate[sid] || date > (lastAttendanceDate[sid] as Date)) {
      lastAttendanceDate[sid] = date;
    }
    if (date >= thirtyDaysAgo) {
      checkIns30Days[sid] = (checkIns30Days[sid] ?? 0) + 1;
    }
  });

  const students = studentsSnap.docs.map((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const rawCreatedAt = d["createdAt"] as { toDate?: () => Date } | string | undefined;
    return {
      id: doc.id,
      firstName: (d["firstName"] as string) || "",
      lastName: (d["lastName"] as string) || "",
      credits: (d["credits"] as number) ?? 0,
      createdAt: typeof rawCreatedAt === "object" && rawCreatedAt !== null && typeof rawCreatedAt.toDate === "function"
        ? rawCreatedAt.toDate()
        : new Date((rawCreatedAt as string) || 0),
    };
  });

  const totalStudents = students.length;

  const atRisk: AtRiskStudent[] = students
    .filter((s) => {
      const last = lastAttendanceDate[s.id];
      if (!last) return s.createdAt < sevenDaysAgo;
      return last < thirtyDaysAgo;
    })
    .map((s) => {
      const last = lastAttendanceDate[s.id];
      return {
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        credits: s.credits,
        lastAttendance: last ? last.toISOString() : null,
        daysSinceAttendance: last
          ? Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24))
          : null,
        neverAttended: !last,
      };
    })
    .sort((a, b) => (b.daysSinceAttendance ?? 9999) - (a.daysSinceAttendance ?? 9999))
    .slice(0, 15);

  const mostActive: MostActiveStudent[] = students
    .filter((s) => (checkIns30Days[s.id] ?? 0) > 0)
    .sort((a, b) => (checkIns30Days[b.id] ?? 0) - (checkIns30Days[a.id] ?? 0))
    .slice(0, 5)
    .map((s) => ({
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      checkIns30Days: checkIns30Days[s.id] ?? 0,
    }));

  const activeThisMonth = new Set(
    Object.entries(checkIns30Days)
      .filter(([, count]) => count > 0)
      .map(([id]) => id),
  ).size;

  const totalCheckIns30Days = Object.values(checkIns30Days).reduce((a, b) => a + b, 0);
  const avgCheckIns = activeThisMonth > 0
    ? Math.round((totalCheckIns30Days / activeThisMonth) * 10) / 10
    : 0;

  const studentsWithCredits = students.filter((s) => s.credits > 0).length;
  const atRiskWithCredits = atRisk.filter((s) => s.credits > 0).length;

  const stats: EngagementStats = {
    totalStudents,
    atRiskCount: atRisk.length,
    activeThisMonth,
    avgCheckInsPerActiveStudent: avgCheckIns,
    studentsWithCredits,
    atRiskWithCredits,
  };

  // Silence unused import warning
  void studentsService;

  return { atRisk, mostActive, stats };
}
