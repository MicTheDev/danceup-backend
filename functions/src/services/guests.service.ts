import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";

interface GuestInfo {
  firstName: string;
  lastName: string;
  email: string;
  city: string;
  state: string;
  zip: string;
}

interface GuestRecord extends GuestInfo {
  id: string;
  createdAt?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  updatedAt?: admin.firestore.FieldValue | admin.firestore.Timestamp;
}

export class GuestsService {
  async createGuest(guestInfo: GuestInfo): Promise<string> {
    const db = getFirestore();
    if (!guestInfo.firstName || !guestInfo.lastName || !guestInfo.email) {
      throw new Error("First name, last name, and email are required");
    }
    if (!guestInfo.city || !guestInfo.state || !guestInfo.zip) {
      throw new Error("City, state, and ZIP code are required");
    }

    const normalizedEmail = guestInfo.email.trim().toLowerCase();
    const guestDoc = {
      firstName: guestInfo.firstName.trim(),
      lastName: guestInfo.lastName.trim(),
      email: normalizedEmail,
      city: guestInfo.city.trim(),
      state: guestInfo.state.trim().toUpperCase(),
      zip: guestInfo.zip.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const guestRef = db.collection("guests").doc();
    await guestRef.set(guestDoc);
    return guestRef.id;
  }

  async getGuestById(guestId: string): Promise<GuestRecord | null> {
    const db = getFirestore();
    const doc = await db.collection("guests").doc(guestId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...(doc.data() as Omit<GuestRecord, "id">) };
  }

  async getGuestsByEmail(email: string): Promise<GuestRecord[]> {
    const db = getFirestore();
    const normalizedEmail = email.trim().toLowerCase();
    const query = await db.collection("guests")
      .where("email", "==", normalizedEmail)
      .get();
    return query.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<GuestRecord, "id">),
    }));
  }
}

export default new GuestsService();
