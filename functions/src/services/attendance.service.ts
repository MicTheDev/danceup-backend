import * as admin from "firebase-admin";
import authService from "./auth.service";
import creditTrackingService from "./credit-tracking.service";
import { getFirestore } from "../utils/firestore";

interface AttendanceData {
  studentId: string;
  classInstanceDate: admin.firestore.Timestamp | Date | string;
  checkedInBy: "studio" | "student";
  checkedInById?: string;
  checkedInAt?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  classId?: string | null;
  workshopId?: string | null;
  eventId?: string | null;
}

interface PaginationOptions {
  limit?: number;
  after?: string | null;
}

interface PeriodCount {
  period: string;
  count: number;
}

function tsToDate(val: unknown): Date | null {
  if (!val) return null;
  if (typeof val === "object" && val !== null && "toDate" in val) {
    return (val as { toDate(): Date }).toDate();
  }
  const d = new Date(val as string | number);
  return isNaN(d.getTime()) ? null : d;
}

export class AttendanceService {
  async getStudioOwnerId(authUid: string): Promise<string | null> {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) return null;
    return userDoc.id;
  }

  async getStudentIdByAuthUid(authUid: string): Promise<string | null> {
    const db = getFirestore();
    const snapshot = await db.collection("students")
      .where("authUid", "==", authUid)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const firstDoc = snapshot.docs[0];
    return firstDoc ? firstDoc.id : null;
  }

  async getAttendanceRecordsByStudent(
    studentId: string,
    studioOwnerId: string,
    { limit = 100, after = null }: PaginationOptions = {},
  ): Promise<{ records: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean }> {
    const db = getFirestore();
    const pageSize = Math.min(Math.max(1, Number(limit) || 100), 200);

    const studentDoc = await db.collection("students").doc(studentId).get();
    if (!studentDoc.exists) throw new Error("Student not found");
    const studentData = studentDoc.data() as Record<string, unknown>;
    if (studentData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }

    let query = db.collection("attendance")
      .where("studentId", "==", studentId)
      .where("studioOwnerId", "==", studioOwnerId)
      .orderBy("classInstanceDate", "desc")
      .limit(pageSize + 1) as FirebaseFirestore.Query;

    if (after) {
      const cursorDoc = await db.collection("attendance").doc(after).get();
      if (cursorDoc.exists) query = query.startAfter(cursorDoc);
    }

    const snapshot = await query.get();
    const hasMore = snapshot.docs.length > pageSize;
    const docs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;

    const records = docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const record: Record<string, unknown> = { id: doc.id, ...data };
      const cid = tsToDate(data["classInstanceDate"]);
      if (cid) record["classInstanceDate"] = cid.toISOString();
      const cia = tsToDate(data["checkedInAt"]);
      if (cia) record["checkedInAt"] = cia.toISOString();
      const ca = tsToDate(data["createdAt"]);
      if (ca) record["createdAt"] = ca.toISOString();
      const ra = tsToDate(data["removedAt"]);
      if (ra) record["removedAt"] = ra.toISOString();
      return record;
    });

    const lastDoc = docs[docs.length - 1];
    return { records, nextCursor: hasMore && lastDoc ? lastDoc.id : null, hasMore };
  }

  async getAttendanceRecords(
    studioOwnerId: string,
    startDate: Date | null = null,
    endDate: Date | null = null,
  ): Promise<Array<Record<string, unknown>>> {
    const db = getFirestore();
    console.log(`[AttendanceService] getAttendanceRecords - studioOwnerId: ${studioOwnerId}, startDate: ${startDate}, endDate: ${endDate}`);
    console.log("[AttendanceService] Executing Firestore query...");
    const snapshot = await db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).get();
    console.log(`[AttendanceService] Query completed. Found ${snapshot.size} documents`);

    const records: Array<Record<string, unknown>> = [];
    snapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const instanceDate = tsToDate(data["classInstanceDate"]);
      if (startDate && instanceDate && instanceDate < startDate) return;
      if (endDate && instanceDate && instanceDate > endDate) return;
      records.push({ id: doc.id, ...data });
    });
    console.log(`[AttendanceService] Returning ${records.length} filtered records`);
    return records;
  }

  async getClassSpecificAttendanceStats(
    studioOwnerId: string, classId: string,
    startDate: Date | null = null, endDate: Date | null = null,
  ): Promise<{ weekly: PeriodCount[]; monthly: PeriodCount[]; total: number }> {
    const records = await this.getAttendanceRecords(studioOwnerId, startDate, endDate);
    const classRecords = records.filter((r) => r["classId"] === classId);

    if (classRecords.length === 0) return { weekly: [], monthly: [], total: 0 };

    const weeklyMap = new Map<string, number>();
    const monthlyMap = new Map<string, number>();

    classRecords.forEach((record) => {
      const instanceDate = tsToDate(record["classInstanceDate"]);
      if (!instanceDate) return;
      const wk = this.getWeekKey(instanceDate);
      weeklyMap.set(wk, (weeklyMap.get(wk) ?? 0) + 1);
      const mk = this.getMonthKey(instanceDate);
      monthlyMap.set(mk, (monthlyMap.get(mk) ?? 0) + 1);
    });

    return {
      weekly: Array.from(weeklyMap.entries()).map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
      monthly: Array.from(monthlyMap.entries()).map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
      total: classRecords.length,
    };
  }

  async getClassAttendanceStats(
    studioOwnerId: string,
    startDate: Date | null = null,
    endDate: Date | null = null,
  ): Promise<{ weekly: PeriodCount[]; monthly: PeriodCount[]; byClass: Array<Record<string, unknown>>; total: number }> {
    const records = await this.getAttendanceRecords(studioOwnerId, startDate, endDate);
    const classRecords = records.filter((r) => r["classId"]);

    if (classRecords.length === 0) return { weekly: [], monthly: [], byClass: [], total: 0 };

    const weeklyMap = new Map<string, number>();
    const monthlyMap = new Map<string, number>();
    const classMap = new Map<string, { count: number; classId: string }>();

    classRecords.forEach((record) => {
      const instanceDate = tsToDate(record["classInstanceDate"]);
      if (!instanceDate) return;
      const wk = this.getWeekKey(instanceDate);
      weeklyMap.set(wk, (weeklyMap.get(wk) ?? 0) + 1);
      const mk = this.getMonthKey(instanceDate);
      monthlyMap.set(mk, (monthlyMap.get(mk) ?? 0) + 1);
      const cid = record["classId"] as string;
      if (cid) {
        const current = classMap.get(cid) ?? { count: 0, classId: cid };
        classMap.set(cid, { ...current, count: current.count + 1 });
      }
    });

    const byClass: Array<{ classId: string; className: string; totalAttendance: number }> = Array.from(classMap.entries())
      .map(([cid, data]) => ({ classId: cid, className: "", totalAttendance: data.count }))
      .sort((a, b) => b.totalAttendance - a.totalAttendance);

    const db = getFirestore();
    const classIds = Array.from(classMap.keys());
    if (classIds.length > 0) {
      const classDocs = await Promise.all(classIds.map((id) => db.collection("classes").doc(id).get()));
      classDocs.forEach((doc) => {
        if (doc.exists) {
          const d = doc.data() as Record<string, unknown>;
          const stat = byClass.find((c) => c.classId === doc.id);
          if (stat) stat.className = (d["name"] as string) || "Unknown Class";
        }
      });
    }

    return {
      weekly: Array.from(weeklyMap.entries()).map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
      monthly: Array.from(monthlyMap.entries()).map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
      byClass,
      total: classRecords.length,
    };
  }

  async getWorkshopAttendanceStats(
    studioOwnerId: string,
    startDate: Date | null = null,
    endDate: Date | null = null,
  ): Promise<{ total: number; byWorkshop: Array<{ workshopId: string; workshopName: string; totalAttendance: number }> }> {
    const db = getFirestore();
    const snapshot = await db.collection("purchases")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("purchaseType", "==", "workshop")
      .where("status", "==", "completed")
      .get();

    const workshopMap = new Map<string, { count: number; workshopId: string; workshopName: string }>();

    snapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      if (startDate || endDate) {
        const ca = tsToDate(data["createdAt"]);
        if (ca) {
          if (startDate && ca < startDate) return;
          if (endDate && ca > endDate) return;
        }
      }
      const workshopId = data["itemId"] as string | undefined;
      if (!workshopId) return;
      const current = workshopMap.get(workshopId) ?? { count: 0, workshopId, workshopName: (data["itemName"] as string) || "" };
      workshopMap.set(workshopId, { ...current, count: current.count + 1 });
    });

    if (workshopMap.size === 0) return { total: 0, byWorkshop: [] };

    const byWorkshop = Array.from(workshopMap.values())
      .map((w) => ({ workshopId: w.workshopId, workshopName: w.workshopName, totalAttendance: w.count }))
      .sort((a, b) => b.totalAttendance - a.totalAttendance);

    const missingNames = byWorkshop.filter((w) => !w.workshopName);
    if (missingNames.length > 0) {
      const workshopDocs = await Promise.all(missingNames.map((w) => db.collection("workshops").doc(w.workshopId).get()));
      workshopDocs.forEach((doc) => {
        if (doc.exists) {
          const stat = byWorkshop.find((w) => w.workshopId === doc.id);
          if (stat) stat.workshopName = ((doc.data() as Record<string, unknown>)["name"] as string) || "Unknown Workshop";
        }
      });
    }

    return { total: byWorkshop.reduce((sum, w) => sum + w.totalAttendance, 0), byWorkshop };
  }

  async getEventAttendanceStats(
    studioOwnerId: string,
    startDate: Date | null = null,
    endDate: Date | null = null,
  ): Promise<{ weekly: PeriodCount[]; monthly: PeriodCount[]; total: number; byEvent: Array<{ eventId: string; eventName: string; totalAttendance: number }> }> {
    const db = getFirestore();
    const snapshot = await db.collection("purchases")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("purchaseType", "==", "event")
      .where("status", "==", "completed")
      .get();

    const weeklyMap = new Map<string, number>();
    const monthlyMap = new Map<string, number>();
    const eventMap = new Map<string, { count: number; eventId: string; eventName: string }>();

    snapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const ca = tsToDate(data["createdAt"]);
      if (!ca) return;
      if (startDate && ca < startDate) return;
      if (endDate && ca > endDate) return;

      const wk = this.getWeekKey(ca);
      weeklyMap.set(wk, (weeklyMap.get(wk) ?? 0) + 1);
      const mk = this.getMonthKey(ca);
      monthlyMap.set(mk, (monthlyMap.get(mk) ?? 0) + 1);

      const eventId = data["itemId"] as string | undefined;
      if (eventId) {
        const current = eventMap.get(eventId) ?? { count: 0, eventId, eventName: (data["itemName"] as string) || "" };
        eventMap.set(eventId, { ...current, count: current.count + 1 });
      }
    });

    return {
      weekly: Array.from(weeklyMap.entries()).map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
      monthly: Array.from(monthlyMap.entries()).map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
      total: snapshot.size,
      byEvent: Array.from(eventMap.values()).map((e) => ({ eventId: e.eventId, eventName: e.eventName, totalAttendance: e.count })).sort((a, b) => b.totalAttendance - a.totalAttendance),
    };
  }

  async getClassAttendees(studioOwnerId: string, classId: string): Promise<Array<Record<string, unknown>>> {
    const db = getFirestore();
    const snapshot = await db.collection("attendance")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("classId", "==", classId)
      .get();

    const activeDocs = snapshot.docs.filter((d) => !(d.data() as Record<string, unknown>)["isRemoved"]);
    activeDocs.sort((a, b) => {
      const toMs = (ts: unknown) => { const d = tsToDate(ts); return d ? d.getTime() : 0; };
      return toMs((b.data() as Record<string, unknown>)["classInstanceDate"]) - toMs((a.data() as Record<string, unknown>)["classInstanceDate"]);
    });

    const studentIds = [...new Set(activeDocs.map((d) => (d.data() as Record<string, unknown>)["studentId"] as string).filter(Boolean))];
    const studentDocs = studentIds.length > 0
      ? await Promise.all(studentIds.map((id) => db.collection("students").doc(id).get()))
      : [];

    const studentMap = new Map<string, Record<string, unknown>>();
    studentDocs.forEach((doc) => { if (doc.exists) studentMap.set(doc.id, doc.data() as Record<string, unknown>); });

    return activeDocs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const student = studentMap.get(data["studentId"] as string) ?? {};
      const cidDate = tsToDate(data["classInstanceDate"]);
      const ciaDate = tsToDate(data["checkedInAt"]);
      return {
        attendanceId: doc.id,
        studentId: data["studentId"],
        firstName: (student["firstName"] as string) || "",
        lastName: (student["lastName"] as string) || "",
        email: (student["email"] as string) || "",
        classInstanceDate: cidDate ? cidDate.toISOString() : data["classInstanceDate"],
        checkedInAt: ciaDate ? ciaDate.toISOString() : data["checkedInAt"],
        checkedInBy: data["checkedInBy"],
      };
    });
  }

  async getWorkshopAttendees(studioOwnerId: string, workshopId: string): Promise<Array<Record<string, unknown>>> {
    const db = getFirestore();
    const snapshot = await db.collection("purchases")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("purchaseType", "==", "workshop")
      .where("itemId", "==", workshopId)
      .get();

    const completedDocs = snapshot.docs.filter((d) => {
      const status = (d.data() as Record<string, unknown>)["status"];
      return !status || status === "completed";
    });
    completedDocs.sort((a, b) => {
      const toMs = (ts: unknown) => { const d = tsToDate(ts); return d ? d.getTime() : 0; };
      return toMs((b.data() as Record<string, unknown>)["createdAt"]) - toMs((a.data() as Record<string, unknown>)["createdAt"]);
    });

    const studentIds = [...new Set(completedDocs.map((d) => (d.data() as Record<string, unknown>)["studentId"] as string).filter(Boolean))];
    const studentDocs = studentIds.length > 0
      ? await Promise.all(studentIds.map((id) => db.collection("students").doc(id).get()))
      : [];
    const studentMap = new Map<string, Record<string, unknown>>();
    studentDocs.forEach((doc) => { if (doc.exists) studentMap.set(doc.id, doc.data() as Record<string, unknown>); });

    return completedDocs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const student = studentMap.get(data["studentId"] as string) ?? {};
      const caDate = tsToDate(data["createdAt"]);
      return {
        purchaseId: doc.id,
        studentId: data["studentId"],
        firstName: (student["firstName"] as string) || "",
        lastName: (student["lastName"] as string) || "",
        email: (student["email"] as string) || "",
        pricePaid: (data["price"] as number) || 0,
        purchasedAt: caDate ? caDate.toISOString() : data["createdAt"],
      };
    });
  }

  async getEventAttendees(studioOwnerId: string, eventId: string): Promise<Array<Record<string, unknown>>> {
    const db = getFirestore();
    const snapshot = await db.collection("purchases")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("purchaseType", "==", "event")
      .where("itemId", "==", eventId)
      .get();

    const completedDocs = snapshot.docs.filter((d) => {
      const status = (d.data() as Record<string, unknown>)["status"];
      return !status || status === "completed";
    });
    completedDocs.sort((a, b) => {
      const toMs = (ts: unknown) => { const d = tsToDate(ts); return d ? d.getTime() : 0; };
      return toMs((b.data() as Record<string, unknown>)["createdAt"]) - toMs((a.data() as Record<string, unknown>)["createdAt"]);
    });

    const studentIds = [...new Set(completedDocs.map((d) => (d.data() as Record<string, unknown>)["studentId"] as string).filter(Boolean))];
    const studentDocs = studentIds.length > 0
      ? await Promise.all(studentIds.map((id) => db.collection("students").doc(id).get()))
      : [];
    const studentMap = new Map<string, Record<string, unknown>>();
    studentDocs.forEach((doc) => { if (doc.exists) studentMap.set(doc.id, doc.data() as Record<string, unknown>); });

    return completedDocs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const student = studentMap.get(data["studentId"] as string) ?? {};
      const caDate = tsToDate(data["createdAt"]);
      return {
        purchaseId: doc.id,
        studentId: data["studentId"],
        firstName: (student["firstName"] as string) || "",
        lastName: (student["lastName"] as string) || "",
        email: (student["email"] as string) || "",
        pricePaid: (data["price"] as number) || 0,
        purchasedAt: caDate ? caDate.toISOString() : data["createdAt"],
      };
    });
  }

  getWeekKey(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNum.toString().padStart(2, "0")}`;
  }

  getMonthKey(date: Date): string {
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
  }

  async checkDuplicateCheckIn(
    studentId: string,
    classId: string | null | undefined,
    workshopId: string | null | undefined,
    eventId: string | null | undefined,
    classInstanceDate: admin.firestore.Timestamp,
  ): Promise<(Record<string, unknown> & { id: string }) | null> {
    const db = getFirestore();
    const instanceDate = classInstanceDate.toDate();
    const startOfDay = new Date(instanceDate.getFullYear(), instanceDate.getMonth(), instanceDate.getDate());
    const startOfDayTimestamp = admin.firestore.Timestamp.fromDate(startOfDay);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    const endOfDayTimestamp = admin.firestore.Timestamp.fromDate(endOfDay);

    let query = db.collection("attendance")
      .where("studentId", "==", studentId)
      .where("classInstanceDate", ">=", startOfDayTimestamp)
      .where("classInstanceDate", "<", endOfDayTimestamp) as FirebaseFirestore.Query;

    if (classId) query = query.where("classId", "==", classId);
    else if (workshopId) query = query.where("workshopId", "==", workshopId);
    else if (eventId) query = query.where("eventId", "==", eventId);

    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (!data["isRemoved"]) return { id: doc.id, ...data };
    }
    return null;
  }

  async createAttendanceRecord(attendanceData: AttendanceData, studioOwnerId: string): Promise<string> {
    const db = getFirestore();

    if (!attendanceData.studentId) throw new Error("studentId is required");

    const idCount = [attendanceData.classId, attendanceData.workshopId, attendanceData.eventId].filter(Boolean).length;
    if (idCount !== 1) throw new Error("Exactly one of classId, workshopId, or eventId must be provided");

    if (!attendanceData.classInstanceDate) throw new Error("classInstanceDate is required");

    let classInstanceTimestamp: admin.firestore.Timestamp;
    if (attendanceData.classInstanceDate instanceof admin.firestore.Timestamp) {
      classInstanceTimestamp = attendanceData.classInstanceDate;
    } else if (attendanceData.classInstanceDate instanceof Date) {
      classInstanceTimestamp = admin.firestore.Timestamp.fromDate(attendanceData.classInstanceDate);
    } else if (typeof attendanceData.classInstanceDate === "string") {
      const date = new Date(attendanceData.classInstanceDate);
      if (isNaN(date.getTime())) throw new Error("Invalid classInstanceDate format");
      classInstanceTimestamp = admin.firestore.Timestamp.fromDate(date);
    } else {
      throw new Error("classInstanceDate must be a Date, Timestamp, or ISO date string");
    }

    if (!attendanceData.checkedInBy || !["studio", "student"].includes(attendanceData.checkedInBy)) {
      throw new Error("checkedInBy must be 'studio' or 'student'");
    }

    const studentDoc = await db.collection("students").doc(attendanceData.studentId).get();
    if (!studentDoc.exists) throw new Error("Student not found");
    const studentData = studentDoc.data() as Record<string, unknown>;
    if (studentData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Student does not belong to this studio owner");
    }

    const existingCheckIn = await this.checkDuplicateCheckIn(
      attendanceData.studentId,
      attendanceData.classId,
      attendanceData.workshopId,
      attendanceData.eventId,
      classInstanceTimestamp,
    );
    if (existingCheckIn) throw new Error("Student is already checked in for this class instance");

    const classId = attendanceData.classId ?? null;
    let availableCredits: number;

    if (classId) {
      availableCredits = await creditTrackingService.getAvailableCredits(attendanceData.studentId, studioOwnerId, classId);
      if (availableCredits < 1) {
        availableCredits = await creditTrackingService.getAvailableCredits(attendanceData.studentId, studioOwnerId, null);
      }
    } else {
      availableCredits = await creditTrackingService.getAvailableCredits(attendanceData.studentId, studioOwnerId, null);
    }

    if (availableCredits < 1) throw new Error("Insufficient credits");

    let creditUsedId: string;
    try {
      if (classId) {
        try {
          creditUsedId = await creditTrackingService.useCredit(attendanceData.studentId, studioOwnerId, classId);
        } catch (_classCreditError) {
          creditUsedId = await creditTrackingService.useCredit(attendanceData.studentId, studioOwnerId, null);
        }
      } else {
        creditUsedId = await creditTrackingService.useCredit(attendanceData.studentId, studioOwnerId, null);
      }
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to use credit: ${err.message}`);
    }

    const checkedInById = attendanceData.checkedInById ??
      (attendanceData.checkedInBy === "studio" ? studioOwnerId : attendanceData.studentId);
    const checkedInAt = attendanceData.checkedInAt ?? admin.firestore.FieldValue.serverTimestamp();

    const attendanceDoc: Record<string, unknown> = {
      studentId: attendanceData.studentId,
      classInstanceDate: classInstanceTimestamp,
      checkedInBy: attendanceData.checkedInBy,
      checkedInById,
      checkedInAt,
      studioOwnerId,
      creditUsedId,
      isRemoved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (attendanceData.classId) attendanceDoc["classId"] = attendanceData.classId;
    else if (attendanceData.workshopId) attendanceDoc["workshopId"] = attendanceData.workshopId;
    else if (attendanceData.eventId) attendanceDoc["eventId"] = attendanceData.eventId;

    const docRef = await db.collection("attendance").add(attendanceDoc);
    return docRef.id;
  }

  async getAttendanceRecordById(
    attendanceId: string, studioOwnerId: string,
  ): Promise<Record<string, unknown> | null> {
    const db = getFirestore();
    const doc = await db.collection("attendance").doc(attendanceId).get();
    if (!doc.exists) return null;
    const data = doc.data() as Record<string, unknown>;
    if (data["studioOwnerId"] !== studioOwnerId) return null;
    return { id: doc.id, ...data };
  }

  async getLastAttendedAtMap(studioOwnerId: string): Promise<Map<string, Date>> {
    const db = getFirestore();
    const snapshot = await db.collection("attendance")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isRemoved", "==", false)
      .get();
    const map = new Map<string, Date>();
    snapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const date = tsToDate(data["classInstanceDate"]);
      const studentId = data["studentId"] as string | undefined;
      if (!date || !studentId) return;
      const existing = map.get(studentId);
      if (!existing || date > existing) map.set(studentId, date);
    });
    return map;
  }

  async getLostRevenueStats(studioOwnerId: string): Promise<Record<string, unknown>> {
    const db = getFirestore();
    const now = new Date();

    // --- Average class price + total weekly capacity ---
    const classesSnap = await db.collection("classes")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isActive", "==", true)
      .get();
    let totalCost = 0;
    let classCount = 0;
    let totalCapacity = 0;
    classesSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const cost = (d["cost"] as number) || 0;
      const cap = (d["maxCapacity"] as number) || 20;
      if (cost > 0) { totalCost += cost; classCount++; }
      totalCapacity += cap;
    });
    const avgClassPrice = classCount > 0 ? totalCost / classCount : 0;

    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    // Fetch all non-removed attendance for this studio in one query (no date range = no composite index needed)
    const allAttSnap = await db.collection("attendance")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isRemoved", "==", false)
      .get();

    const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const activeStudentIds = new Set<string>();
    let weekCheckIns = 0;

    allAttSnap.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const date = tsToDate(data["classInstanceDate"]);
      const sid = data["studentId"] as string | undefined;
      if (!date) return;
      // Count this week's check-ins
      if (date >= weekStart && date < weekEnd) weekCheckIns++;
      // Track students active in last 14 days
      if (date >= cutoff && sid) activeStudentIds.add(sid);
    });

    const emptySpots = Math.max(0, totalCapacity - weekCheckIns);
    const emptySpotValue = emptySpots * avgClassPrice;

    // --- At-risk count ---
    const studentsSnap = await db.collection("students")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    const atRiskCount = studentsSnap.docs.filter((d) => !activeStudentIds.has(d.id)).length;
    const atRiskValue = atRiskCount * avgClassPrice * 4; // estimated monthly value (4 classes/mo)

    // --- Unused credits (equality-only query, no composite index needed) ---
    const creditsSnap = await db.collectionGroup("credits")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("used", "==", false)
      .get();
    const totalUnusedCredits = creditsSnap.size;
    const unusedCreditsValue = totalUnusedCredits * avgClassPrice;

    return {
      emptySpotValue: Math.round(emptySpotValue * 100) / 100,
      atRiskCount,
      atRiskValue: Math.round(atRiskValue * 100) / 100,
      unusedCreditsValue: Math.round(unusedCreditsValue * 100) / 100,
      totalUnusedCredits,
      avgClassPrice: Math.round(avgClassPrice * 100) / 100,
      weekStart: weekStart.toISOString(),
    };
  }

  async removeAttendanceRecord(attendanceId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("attendance").doc(attendanceId);
    const attendanceDoc = await ref.get();
    if (!attendanceDoc.exists) throw new Error("Attendance record not found");
    const attendanceData = attendanceDoc.data() as Record<string, unknown>;
    if (attendanceData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Attendance record does not belong to this studio owner");
    }
    if (attendanceData["isRemoved"]) throw new Error("Attendance record is already removed");

    if (attendanceData["creditUsedId"]) {
      try {
        await creditTrackingService.restoreCredit(
          attendanceData["studentId"] as string,
          studioOwnerId,
          attendanceData["creditUsedId"] as string,
        );
      } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to restore credit: ${err.message}`);
      }
    }

    await ref.update({
      isRemoved: true,
      removedAt: admin.firestore.FieldValue.serverTimestamp(),
      removedBy: studioOwnerId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async getDashboardStats(studioOwnerId: string): Promise<Record<string, unknown>> {
    const db = getFirestore();
    const now = new Date();
    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const dayOfWeek = now.getDay();
    const startOfCurrentWeek = new Date(now);
    startOfCurrentWeek.setDate(now.getDate() - dayOfWeek);
    startOfCurrentWeek.setHours(0, 0, 0, 0);
    const startOfPrevWeek = new Date(startOfCurrentWeek);
    startOfPrevWeek.setDate(startOfPrevWeek.getDate() - 7);
    const endOfPrevWeek = new Date(startOfCurrentWeek);
    endOfPrevWeek.setMilliseconds(-1);

    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const attendanceRecords = await this.getAttendanceRecords(studioOwnerId, startOfPrevMonth, now);
    const activeRecords = attendanceRecords.filter((r) => !r["isRemoved"]);

    // Active students
    const currentMonthStudents = new Set<string>();
    const prevMonthStudents = new Set<string>();
    activeRecords.forEach((r) => {
      const d = tsToDate(r["classInstanceDate"]);
      if (!d) return;
      if (d >= startOfCurrentMonth) currentMonthStudents.add(r["studentId"] as string);
      else if (d >= startOfPrevMonth && d <= endOfPrevMonth) prevMonthStudents.add(r["studentId"] as string);
    });
    const activeStudentsCurrent = currentMonthStudents.size;
    const activeStudentsPrev = prevMonthStudents.size;
    const activeStudentsChange = activeStudentsPrev > 0
      ? Math.round(((activeStudentsCurrent - activeStudentsPrev) / activeStudentsPrev) * 100)
      : activeStudentsCurrent > 0 ? 100 : 0;

    // Avg attendance
    let currentWeekCheckIns = 0;
    let prevWeekCheckIns = 0;
    activeRecords.forEach((r) => {
      const d = tsToDate(r["classInstanceDate"]);
      if (!d) return;
      if (d >= startOfCurrentWeek) currentWeekCheckIns++;
      else if (d >= startOfPrevWeek && d < startOfCurrentWeek) prevWeekCheckIns++;
    });
    const avgAttendanceChange = prevWeekCheckIns > 0
      ? Math.round(((currentWeekCheckIns - prevWeekCheckIns) / prevWeekCheckIns) * 100)
      : currentWeekCheckIns > 0 ? 100 : 0;

    // New sign-ups
    const studentsSnapshot = await db.collection("students").where("studioOwnerId", "==", studioOwnerId).get();
    let newSignupsCurrent = 0;
    let newSignupsPrev = 0;
    studentsSnapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const ca = tsToDate(data["createdAt"]);
      if (!ca) return;
      if (ca >= startOfCurrentWeek) newSignupsCurrent++;
      else if (ca >= startOfPrevWeek && ca < startOfCurrentWeek) newSignupsPrev++;
    });
    const newSignupsChange = newSignupsPrev > 0
      ? Math.round(((newSignupsCurrent - newSignupsPrev) / newSignupsPrev) * 100)
      : newSignupsCurrent > 0 ? 100 : 0;

    // Monthly revenue
    const startOfPrevMonthForRevenue = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const [purchasesSnapshot, cashPurchasesSnapshot, privateLessonSnapshot] = await Promise.all([
      db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("cashPurchases").where("studioOwnerId", "==", studioOwnerId).get(),
      db.collection("privateLessonBookings").where("studioId", "==", studioOwnerId).where("paymentStatus", "==", "paid").get(),
    ]);

    let currentMonthRevenue = 0;
    let prevMonthRevenue = 0;

    purchasesSnapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      if (data["status"] && data["status"] !== "completed") return;
      if (data["paymentMethod"] === "cash") return;
      const ca = tsToDate(data["createdAt"]);
      if (!ca) return;
      const amount = (data["price"] as number) ?? (data["amount"] as number) ?? 0;
      if (ca >= startOfCurrentMonth) currentMonthRevenue += amount;
      else if (ca >= startOfPrevMonthForRevenue && ca < startOfCurrentMonth) prevMonthRevenue += amount;
    });
    cashPurchasesSnapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      if (data["status"] && data["status"] !== "completed") return;
      const ca = tsToDate(data["createdAt"]);
      if (!ca) return;
      const amount = (data["amount"] as number) ?? 0;
      if (ca >= startOfCurrentMonth) currentMonthRevenue += amount;
      else if (ca >= startOfPrevMonthForRevenue && ca < startOfCurrentMonth) prevMonthRevenue += amount;
    });
    privateLessonSnapshot.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const ca = tsToDate(data["createdAt"]);
      if (!ca) return;
      const amount = (data["amountPaid"] as number) ?? 0;
      if (ca >= startOfCurrentMonth) currentMonthRevenue += amount;
      else if (ca >= startOfPrevMonthForRevenue && ca < startOfCurrentMonth) prevMonthRevenue += amount;
    });

    const revenueChange = prevMonthRevenue > 0
      ? Math.round(((currentMonthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100)
      : currentMonthRevenue > 0 ? 100 : 0;

    // Attendance pulse
    const classesSnapshot = await db.collection("classes")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isActive", "==", true)
      .get();

    const capacityByDay: Record<string, number> = {};
    DAY_NAMES.forEach((d) => { capacityByDay[d] = 0; });
    classesSnapshot.forEach((doc) => {
      const c = doc.data() as Record<string, unknown>;
      const day = c["dayOfWeek"] as string | undefined;
      if (day && DAY_NAMES.includes(day)) {
        capacityByDay[day] = (capacityByDay[day] ?? 0) + ((c["maxCapacity"] as number) || 20);
      }
    });

    const checkInsByDate: Record<string, number> = {};
    activeRecords.forEach((r) => {
      const d = tsToDate(r["classInstanceDate"]);
      if (!d || d < sevenDaysAgo) return;
      const key = d.toISOString().split("T")[0] ?? "";
      checkInsByDate[key] = (checkInsByDate[key] ?? 0) + 1;
    });

    const attendancePulse = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(now.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const dateKey = date.toISOString().split("T")[0] ?? "";
      const dayName = DAY_NAMES[date.getDay()] ?? "Sunday";
      const checkIns = checkInsByDate[dateKey] ?? 0;
      const maxCap = capacityByDay[dayName] ?? 0;
      const fillRate = maxCap > 0 ? Math.min(Math.round((checkIns / maxCap) * 100), 100) : 0;
      attendancePulse.push({ day: dayName.substring(0, 3), date: dateKey, checkIns, maxCapacity: maxCap, fillRate });
    }

    return {
      activeStudents: { current: activeStudentsCurrent, previous: activeStudentsPrev, change: activeStudentsChange },
      avgAttendance: { current: currentWeekCheckIns, previous: prevWeekCheckIns, change: avgAttendanceChange },
      newSignups: { current: newSignupsCurrent, previous: newSignupsPrev, change: newSignupsChange },
      monthlyRevenue: { current: currentMonthRevenue, previous: prevMonthRevenue, change: revenueChange },
      attendancePulse,
    };
  }
}

export default new AttendanceService();
