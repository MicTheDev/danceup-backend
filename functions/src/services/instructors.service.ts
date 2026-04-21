import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";

interface InstructorAvailabilityData {
  availableForPrivates?: boolean;
  availability?: unknown;
}

interface PublicInstructorData {
  id: string;
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
