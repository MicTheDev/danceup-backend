import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";
import { normalizeEmail, validatePhone } from "../utils/validation";

interface InstructorAvailabilityData {
  availableForPrivates?: boolean;
  availability?: unknown;
}

export interface BulkImportRowError {
  row: number; // 1-based index into the submitted rows array
  message: string;
}

export interface BulkImportInstructorsResult {
  created: number;
  errors: BulkImportRowError[];
}

interface PublicInstructorData {
  id: string;
  studioOwnerId: string | null;
  firstName: string;
  lastName: string;
  photoURL: string | null;
  bio: string | null;
  email: string | null;
  phone: string | null;
  privateRate: number | null;
  availability?: InstructorAvailabilityData;
}

export class InstructorsService {
  async getStudioOwnerId(authUid: string): Promise<string | null> {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) return null;
    return userDoc.id;
  }

  async getInstructors(studioOwnerId: string): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const snapshot = await db.collection("instructors")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Record<string, unknown>),
    }));
  }

  async getInstructorById(
    instructorId: string, studioOwnerId: string,
  ): Promise<(Record<string, unknown> & { id: string }) | null> {
    const db = getFirestore();
    const doc = await db.collection("instructors").doc(instructorId).get();
    if (!doc.exists) return null;
    const instructorData = doc.data() as Record<string, unknown>;
    if (instructorData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Instructor does not belong to this studio owner");
    }
    return { id: doc.id, ...instructorData };
  }

  async createInstructor(
    instructorData: Record<string, unknown>, studioOwnerId: string,
  ): Promise<string> {
    const db = getFirestore();
    const docRef = await db.collection("instructors").add({
      ...instructorData,
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async bulkImportInstructors(
    rows: Array<Record<string, unknown>>, studioOwnerId: string,
  ): Promise<BulkImportInstructorsResult> {
    const db = getFirestore();
    const errors: BulkImportRowError[] = [];
    const validRows: Record<string, unknown>[] = [];

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
      }

      let phone: string | null = null;
      const rawPhone = row["phone"];
      if (rawPhone !== undefined && rawPhone !== null && String(rawPhone).trim() !== "") {
        const phoneStr = String(rawPhone).trim();
        const pv = validatePhone(phoneStr);
        if (!pv.valid) { errors.push({ row: rowNum, message: pv.message || "Invalid phone number" }); return; }
        phone = phoneStr;
      }

      const bio = typeof row["bio"] === "string" ? (row["bio"] as string).trim() || null : null;
      validRows.push({ firstName, lastName, email, phone, bio });
    });

    // Firestore batches cap out at 500 writes — chunk to stay under that
    // regardless of how many rows the 2000-row import limit allows through.
    const BATCH_SIZE = 500;
    for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const row of validRows.slice(i, i + BATCH_SIZE)) {
        const ref = db.collection("instructors").doc();
        batch.set(ref, {
          ...row,
          studioOwnerId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }

    return { created: validRows.length, errors };
  }

  async updateInstructor(
    instructorId: string, instructorData: Record<string, unknown>, studioOwnerId: string,
  ): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("instructors").doc(instructorId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Instructor not found");
    const existingData = doc.data() as Record<string, unknown>;
    if (existingData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Instructor does not belong to this studio owner");
    }
    await ref.update({ ...instructorData, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  async deleteInstructor(instructorId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("instructors").doc(instructorId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Instructor not found");
    const instructorData = doc.data() as Record<string, unknown>;
    if (instructorData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Instructor does not belong to this studio owner");
    }
    await ref.delete();
  }

  async getPublicInstructorById(instructorId: string): Promise<PublicInstructorData | null> {
    const db = getFirestore();
    const doc = await db.collection("instructors").doc(instructorId).get();
    if (!doc.exists) return null;
    const d = doc.data() as Record<string, unknown>;

    const publicData: PublicInstructorData = {
      id: doc.id,
      studioOwnerId: (d["studioOwnerId"] as string | undefined) ?? null,
      firstName: (d["firstName"] as string) || "",
      lastName: (d["lastName"] as string) || "",
      photoURL: (d["photoURL"] as string | null) ?? (d["photoUrl"] as string | null) ?? null,
      bio: (d["bio"] as string | null) ?? null,
      email: (d["email"] as string | null) ?? null,
      phone: (d["phone"] as string | null) ?? null,
      privateRate: d["privateRate"] != null ? (d["privateRate"] as number) : null,
    };

    if (d["availability"]) {
      const avail = d["availability"] as Record<string, unknown>;
      publicData.availability = {
        availableForPrivates: (avail["availableForPrivates"] as boolean | undefined) ?? false,
        availability: avail["availability"] ?? null,
      };
    }

    return publicData;
  }
}

export default new InstructorsService();
