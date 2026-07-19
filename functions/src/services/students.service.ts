import * as admin from "firebase-admin";
import authService from "./auth.service";
import creditTrackingService from "./credit-tracking.service";
import attendanceService from "./attendance.service";
import { getFirestore } from "../utils/firestore";
import { normalizeEmail, validatePhone } from "../utils/validation";
import { ensureStudiosStructure } from "../utils/studio-enrollment.utils";

interface GetStudentsOptions {
  limit?: number;
  after?: string | null;
}

interface GetStudentsResult {
  students: Array<Record<string, unknown> & { id: string; credits: number }>;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface BulkImportRowError {
  row: number; // 1-based index into the submitted rows array
  message: string;
}

export interface BulkImportResult {
  created: number;
  updated: number;
  linked: number;
  errors: BulkImportRowError[];
  newPlaceholders: Array<{ email: string; firstName: string }>;
}

interface ValidBulkImportRow {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const DAY_MAP: Record<string, number> = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 0,
};

export class StudentsService {
  async getStudioOwnerId(authUid: string): Promise<string | null> {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) return null;
    return userDoc.id;
  }

  async getStudents(studioOwnerId: string, { limit = 50, after = null }: GetStudentsOptions = {}): Promise<GetStudentsResult> {
    const pageSize = Math.min(Math.max(1, Number(limit) || 50), 100);
    const db = getFirestore();

    let query = db.collection("students")
      .where("studioOwnerId", "==", studioOwnerId)
      .orderBy("__name__")
      .limit(pageSize + 1) as FirebaseFirestore.Query;

    if (after) {
      const cursorDoc = await db.collection("students").doc(after).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snapshot = await query.get();
    const hasMore = snapshot.docs.length > pageSize;
    const docs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;

    const lastAttendedMap = await attendanceService.getLastAttendedAtMap(studioOwnerId);

    const students = await Promise.all(docs.map(async (doc) => {
      const data = doc.data() as Record<string, unknown>;
      const credits = await creditTrackingService.getAvailableCredits(doc.id, studioOwnerId);
      const lastAttendedAt = lastAttendedMap.get(doc.id) ?? null;
      return { id: doc.id, ...data, credits, lastAttendedAt: lastAttendedAt ? lastAttendedAt.toISOString() : null };
    }));

    const lastDoc = docs[docs.length - 1];
    return {
      students,
      nextCursor: hasMore && lastDoc ? lastDoc.id : null,
      hasMore,
    };
  }

  async getStudentById(
    studentId: string, studioOwnerId: string,
  ): Promise<(Record<string, unknown> & { id: string; credits: number }) | null> {
    const db = getFirestore();
    const doc = await db.collection("students").doc(studentId).get();
    if (!doc.exists) return null;
    const studentData = doc.data() as Record<string, unknown>;
    if (studentData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }
    const credits = await creditTrackingService.getAvailableCredits(studentId, studioOwnerId);
    const lastAttendedMap = await attendanceService.getLastAttendedAtMap(studioOwnerId);
    const lastAttendedAt = lastAttendedMap.get(studentId) ?? null;
    return { id: doc.id, ...studentData, credits, lastAttendedAt: lastAttendedAt ? lastAttendedAt.toISOString() : null };
  }

  async createStudent(studentData: Record<string, unknown>, studioOwnerId: string): Promise<string> {
    const db = getFirestore();
    const docRef = await db.collection("students").add({
      ...studentData,
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async updateStudent(
    studentId: string, studentData: Record<string, unknown>, studioOwnerId: string,
  ): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("students").doc(studentId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Student not found");
    const existingData = doc.data() as Record<string, unknown>;
    if (existingData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }
    await ref.update({ ...studentData, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  async deleteStudent(studentId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("students").doc(studentId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Student not found");
    const studentData = doc.data() as Record<string, unknown>;
    if (studentData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }
    await ref.delete();
  }

  async bulkImportStudents(
    rows: Array<Record<string, unknown>>, studioOwnerId: string,
  ): Promise<BulkImportResult> {
    const db = getFirestore();
    const errors: BulkImportRowError[] = [];
    const seenEmails = new Set<string>();
    const validRows: ValidBulkImportRow[] = [];

    rows.forEach((row, index) => {
      const rowNum = index + 1;
      const firstName = typeof row["firstName"] === "string" ? (row["firstName"] as string).trim() : "";
      const lastName = typeof row["lastName"] === "string" ? (row["lastName"] as string).trim() : "";
      if (!firstName) { errors.push({ row: rowNum, message: "Missing first name" }); return; }
      if (!lastName) { errors.push({ row: rowNum, message: "Missing last name" }); return; }

      let email: string | null = null;
      const rawEmail = row["email"];
      if (rawEmail !== undefined && rawEmail !== null && String(rawEmail).trim() !== "") {
        email = normalizeEmail(rawEmail);
        if (!email) { errors.push({ row: rowNum, message: "Invalid email format" }); return; }
        if (seenEmails.has(email)) {
          errors.push({ row: rowNum, message: `Duplicate email in file: ${email}` });
          return;
        }
        seenEmails.add(email);
      }

      let phone: string | null = null;
      const rawPhone = row["phone"];
      if (rawPhone !== undefined && rawPhone !== null && String(rawPhone).trim() !== "") {
        const pv = validatePhone(rawPhone);
        if (!pv.valid) { errors.push({ row: rowNum, message: pv.message || "Invalid phone number" }); return; }
        phone = String(rawPhone).trim();
      }

      validRows.push({ firstName, lastName, email, phone });
    });

    if (validRows.length === 0) {
      return { created: 0, updated: 0, linked: 0, errors, newPlaceholders: [] };
    }

    const emailsToLookup = validRows.map((r) => r.email).filter((e): e is string => !!e);
    const existingStudentByEmail = new Map<string, { id: string; hasAuthUid: boolean }>();
    const profileByEmail = new Map<string, { profileId: string; authUid: string }>();

    await Promise.all(chunkArray(emailsToLookup, 30).map(async (emailChunk) => {
      if (emailChunk.length === 0) return;
      const snap = await db.collection("students")
        .where("studioOwnerId", "==", studioOwnerId)
        .where("email", "in", emailChunk)
        .get();
      snap.forEach((doc) => {
        const data = doc.data() as Record<string, unknown>;
        const email = data["email"] as string | undefined;
        if (email) existingStudentByEmail.set(email, { id: doc.id, hasAuthUid: !!data["authUid"] });
      });
    }));

    await Promise.all(chunkArray(emailsToLookup, 30).map(async (emailChunk) => {
      if (emailChunk.length === 0) return;
      const snap = await db.collection("usersStudentProfiles")
        .where("email", "in", emailChunk)
        .get();
      snap.forEach((doc) => {
        const data = doc.data() as Record<string, unknown>;
        const email = data["email"] as string | undefined;
        const authUid = data["authUid"] as string | undefined;
        if (email && authUid) profileByEmail.set(email, { profileId: doc.id, authUid });
      });
    }));

    let created = 0;
    let updated = 0;
    let linked = 0;
    const newPlaceholders: Array<{ email: string; firstName: string }> = [];
    const studioUpdatesByProfileId = new Map<string, string>();

    for (const rowChunk of chunkArray(validRows, 490)) {
      const batch = db.batch();
      for (const row of rowChunk) {
        const existing = row.email ? existingStudentByEmail.get(row.email) : undefined;
        const profileMatch = row.email ? profileByEmail.get(row.email) : undefined;
        const willLink = !!profileMatch && !existing?.hasAuthUid;

        if (existing) {
          const ref = db.collection("students").doc(existing.id);
          const updateData: Record<string, unknown> = {
            firstName: row.firstName,
            lastName: row.lastName,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (row.email) updateData["email"] = row.email;
          if (row.phone) updateData["phone"] = row.phone;
          if (willLink && profileMatch) updateData["authUid"] = profileMatch.authUid;
          batch.update(ref, updateData as FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>);
          if (willLink) linked++; else updated++;
        } else {
          const ref = db.collection("students").doc();
          batch.set(ref, {
            firstName: row.firstName,
            lastName: row.lastName,
            email: row.email,
            phone: row.phone,
            authUid: profileMatch?.authUid ?? null,
            studioOwnerId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          if (profileMatch) {
            linked++;
          } else {
            created++;
            if (row.email) newPlaceholders.push({ email: row.email, firstName: row.firstName });
          }
        }

        if (willLink && profileMatch) {
          studioUpdatesByProfileId.set(profileMatch.profileId, profileMatch.authUid);
        }
      }
      await batch.commit();
    }

    await Promise.all(Array.from(studioUpdatesByProfileId.keys()).map(async (profileId) => {
      try {
        const ref = db.collection("usersStudentProfiles").doc(profileId);
        const doc = await ref.get();
        const currentData = doc.data() as Record<string, unknown> | undefined;
        const studios = ensureStudiosStructure(currentData);
        if (!studios[studioOwnerId]) {
          studios[studioOwnerId] = {};
          await ref.update({ studios, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      } catch (err) {
        console.error(`Error updating studios map for profile ${profileId}:`, err);
      }
    }));

    return { created, updated, linked, errors, newPlaceholders };
  }

  async getEnrolledStudios(authUid: string): Promise<string[]> {
    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) return [];
    const studentData = studentProfileDoc.data() as Record<string, unknown> | undefined;
    if (!studentData) return [];

    if (studentData["studios"] && typeof studentData["studios"] === "object") {
      return Object.keys(studentData["studios"] as Record<string, unknown>);
    }
    if (Array.isArray(studentData["studioIds"])) {
      return studentData["studioIds"] as string[];
    }
    return [];
  }

  calculateNextClassInstance(dayOfWeek: string, startTime: string, fromDate: Date = new Date()): Date {
    const targetDay = DAY_MAP[dayOfWeek];
    if (targetDay === undefined) throw new Error(`Invalid day of week: ${dayOfWeek}`);

    const parts = startTime.split(":").map(Number);
    const hours = parts[0] ?? 0;
    const minutes = parts[1] ?? 0;
    const currentDay = fromDate.getDay();
    let daysUntilNext = targetDay - currentDay;

    if (daysUntilNext < 0 || (daysUntilNext === 0 && this.isTimePassedToday(fromDate, hours, minutes))) {
      daysUntilNext += 7;
    }

    const nextDate = new Date(fromDate);
    nextDate.setDate(fromDate.getDate() + daysUntilNext);
    nextDate.setHours(hours, minutes, 0, 0);
    return nextDate;
  }

  calculatePastClassInstances(
    dayOfWeek: string, startTime: string, fromDate: Date = new Date(), daysBack = 30,
  ): Date[] {
    const targetDay = DAY_MAP[dayOfWeek];
    if (targetDay === undefined) throw new Error(`Invalid day of week: ${dayOfWeek}`);

    const parts = startTime.split(":").map(Number);
    const hours = parts[0] ?? 0;
    const minutes = parts[1] ?? 0;
    const instances: Date[] = [];
    const endDate = new Date(fromDate);
    endDate.setDate(fromDate.getDate() - daysBack);

    const checkDate = new Date(fromDate);
    checkDate.setDate(fromDate.getDate() - 1);
    checkDate.setHours(23, 59, 59, 999);

    while (checkDate >= endDate) {
      if (checkDate.getDay() === targetDay) {
        const instanceDate = new Date(checkDate);
        instanceDate.setHours(hours, minutes, 0, 0);
        instances.push(instanceDate);
      }
      checkDate.setDate(checkDate.getDate() - 1);
    }

    return instances.reverse();
  }

  isTimePassedToday(_date: Date, hours: number, minutes: number): boolean {
    const now = new Date();
    const checkTime = new Date(now);
    checkTime.setHours(hours, minutes, 0, 0);
    return now > checkTime;
  }
}

export default new StudentsService();
