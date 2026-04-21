import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";
import { geocodeAddress } from "../utils/geocoding";
import { haversineDistance } from "../utils/distance";
import { sendWaitlistNotificationEmail } from "./sendgrid.service";

interface StudioInfo {
  id: string;
  name: string;
  city: string;
  state: string;
  addressLine1: string;
  addressLine2: string | null;
  zip: string;
}

interface ClassFilters {
  danceGenre?: string | null;
  city?: string | null;
  state?: string | null;
  studioName?: string | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  level?: string | null;
  lat?: number | null;
  lng?: number | null;
  radius?: number | null;
  limit?: number | null;
}

const STUDIO_PLACEHOLDER_IMAGE =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiM2MzY2ZjEiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNlYzQ4OTkiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2EpIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIyNCIgZmlsbD0id2hpdGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5TdHVkaW88L3RleHQ+PC9zdmc+";

export class ClassesService {
  async getStudioOwnerId(authUid: string): Promise<string | null> {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) return null;
    return userDoc.id;
  }

  async getClasses(studioOwnerId: string): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const snapshot = await db.collection("classes")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    return snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return { id: doc.id, ...data, maxCapacity: (data["maxCapacity"] as number) ?? 20 };
    });
  }

  async getClassById(
    classId: string, studioOwnerId: string,
  ): Promise<(Record<string, unknown> & { id: string }) | null> {
    const db = getFirestore();
    const doc = await db.collection("classes").doc(classId).get();
    if (!doc.exists) return null;
    const classData = doc.data() as Record<string, unknown>;
    if (classData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Class does not belong to this studio owner");
    }
    return { id: doc.id, ...classData, maxCapacity: (classData["maxCapacity"] as number) ?? 20 };
  }

  getStudioPlaceholderImage(): string {
    return STUDIO_PLACEHOLDER_IMAGE;
  }

  async createClass(classData: Record<string, unknown>, studioOwnerId: string): Promise<string> {
    const db = getFirestore();
    const studioOwnerDoc = await db.collection("users").doc(studioOwnerId).get();

    let imageUrl = classData["imageUrl"] as string | undefined;
    if (!imageUrl) {
      imageUrl = STUDIO_PLACEHOLDER_IMAGE;
      if (studioOwnerDoc.exists) {
        const sd = studioOwnerDoc.data() as Record<string, unknown>;
        imageUrl = (sd["studioImageUrl"] as string | undefined) || STUDIO_PLACEHOLDER_IMAGE;
      }
    }

    let coords: { lat: number; lng: number } | null = null;
    if (studioOwnerDoc.exists) {
      const sd = studioOwnerDoc.data() as Record<string, unknown>;
      if (sd["studioAddressLine1"] && sd["city"] && sd["state"]) {
        coords = await geocodeAddress(
          sd["studioAddressLine1"] as string,
          sd["city"] as string,
          sd["state"] as string,
          (sd["zip"] as string) || "",
        );
      }
    }

    const docRef = await db.collection("classes").add({
      ...classData,
      studioOwnerId,
      imageUrl,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async updateClass(classId: string, classData: Record<string, unknown>, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("classes").doc(classId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Class not found");
    const existingData = doc.data() as Record<string, unknown>;
    if (existingData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Class does not belong to this studio owner");
    }

    let coords: { lat: number; lng: number } | null = null;
    const studioOwnerDoc = await db.collection("users").doc(existingData["studioOwnerId"] as string).get();
    if (studioOwnerDoc.exists) {
      const sd = studioOwnerDoc.data() as Record<string, unknown>;
      if (sd["studioAddressLine1"] && sd["city"] && sd["state"]) {
        coords = await geocodeAddress(
          sd["studioAddressLine1"] as string,
          sd["city"] as string,
          sd["state"] as string,
          (sd["zip"] as string) || "",
        );
      }
    }

    await ref.update({
      ...classData,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async deleteClass(classId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("classes").doc(classId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Class not found");
    const classData = doc.data() as Record<string, unknown>;
    if (classData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Class does not belong to this studio owner");
    }
    await ref.delete();
  }

  async getAllPublicClasses(filters: ClassFilters = {}): Promise<Array<Record<string, unknown>>> {
    const db = getFirestore();
    let query = db.collection("classes").where("isActive", "==", true) as FirebaseFirestore.Query;

    if (filters.level && filters.level !== "All") {
      query = query.where("level", "==", filters.level);
    }
    if (filters.minPrice != null) {
      query = query.where("cost", ">=", filters.minPrice);
    }
    if (filters.maxPrice != null) {
      query = query.where("cost", "<=", filters.maxPrice);
    }

    const snapshot = await query.get();

    const studioOwnerIds = new Set<string>();
    const classesMap = new Map<string, Record<string, unknown>>();

    snapshot.forEach((doc) => {
      const classData = doc.data() as Record<string, unknown>;
      studioOwnerIds.add(classData["studioOwnerId"] as string);
      classesMap.set(doc.id, { id: doc.id, ...classData });
    });

    const studioOwnersMap = new Map<string, Record<string, unknown>>();
    if (studioOwnerIds.size > 0) {
      const idsArray = Array.from(studioOwnerIds);
      for (let i = 0; i < idsArray.length; i += 10) {
        const batch = idsArray.slice(i, i + 10);
        const snap = await db.collection("users")
          .where(admin.firestore.FieldPath.documentId(), "in", batch)
          .get();
        snap.forEach((doc) => studioOwnersMap.set(doc.id, doc.data() as Record<string, unknown>));
      }
    }

    let enrichedClasses: Array<Record<string, unknown>> = [];
    for (const classData of classesMap.values()) {
      const studioOwner = studioOwnersMap.get(classData["studioOwnerId"] as string);
      if (!studioOwner) continue;

      if (filters.city && studioOwner["city"]) {
        const sc = (studioOwner["city"] as string).toLowerCase().trim();
        const fc = filters.city.toLowerCase().trim();
        if (!sc.includes(fc) && !fc.includes(sc)) continue;
      }
      if (filters.state && studioOwner["state"]) {
        if ((studioOwner["state"] as string).toUpperCase() !== filters.state.toUpperCase()) continue;
      }
      if (filters.studioName && studioOwner["studioName"]) {
        const sn = (studioOwner["studioName"] as string).toLowerCase().trim();
        if (!sn.includes(filters.studioName.toLowerCase().trim())) continue;
      }

      const studio: StudioInfo = {
        id: classData["studioOwnerId"] as string,
        name: (studioOwner["studioName"] as string) || "",
        city: (studioOwner["city"] as string) || "",
        state: (studioOwner["state"] as string) || "",
        addressLine1: (studioOwner["studioAddressLine1"] as string) || "",
        addressLine2: (studioOwner["studioAddressLine2"] as string | null) ?? null,
        zip: (studioOwner["zip"] as string) || "",
      };
      enrichedClasses.push({ ...classData, studio });
    }

    if (filters.danceGenre && filters.danceGenre !== "All") {
      enrichedClasses = enrichedClasses.filter((cls) => {
        const genre = cls["danceGenre"];
        if (genre) return (genre as string).toLowerCase() === (filters.danceGenre as string).toLowerCase();
        return false;
      });
    }

    if (filters.lat != null && filters.lng != null) {
      const radius = filters.radius ?? 25;
      const lat = filters.lat;
      const lng = filters.lng;
      const withDistance = enrichedClasses
        .filter((c) => c["lat"] != null && c["lng"] != null)
        .map((c) => ({
          ...c,
          distanceMiles: haversineDistance(lat, lng, c["lat"] as number, c["lng"] as number),
        }))
        .filter((c) => (c["distanceMiles"] as number) <= radius)
        .sort((a, b) => (a["distanceMiles"] as number) - (b["distanceMiles"] as number));

      return filters.limit != null ? withDistance.slice(0, filters.limit) : withDistance;
    }

    return filters.limit != null ? enrichedClasses.slice(0, filters.limit) : enrichedClasses;
  }

  async getPublicClassById(classId: string): Promise<Record<string, unknown> | null> {
    const db = getFirestore();
    const doc = await db.collection("classes").doc(classId).get();
    if (!doc.exists) return null;

    const classData = doc.data() as Record<string, unknown>;
    if (!classData["isActive"]) return null;

    const studioOwnerDoc = await db.collection("users").doc(classData["studioOwnerId"] as string).get();
    if (!studioOwnerDoc.exists) return null;
    const sd = studioOwnerDoc.data() as Record<string, unknown>;

    const instructors: Array<Record<string, unknown>> = [];
    const instructorIds = classData["instructorIds"] as string[] | undefined;
    if (Array.isArray(instructorIds) && instructorIds.length > 0) {
      for (let i = 0; i < instructorIds.length; i += 10) {
        const batch = instructorIds.slice(i, i + 10);
        const snap = await db.collection("instructors")
          .where(admin.firestore.FieldPath.documentId(), "in", batch)
          .get();
        snap.forEach((instructorDoc) => {
          instructors.push({ id: instructorDoc.id, ...(instructorDoc.data() as Record<string, unknown>) });
        });
      }
    }

    return {
      id: doc.id,
      ...classData,
      studio: {
        id: classData["studioOwnerId"],
        name: (sd["studioName"] as string) || "",
        city: (sd["city"] as string) || "",
        state: (sd["state"] as string) || "",
        addressLine1: (sd["studioAddressLine1"] as string) || "",
        addressLine2: (sd["studioAddressLine2"] as string | null) ?? null,
        zip: (sd["zip"] as string) || "",
      },
      instructors,
    };
  }

  async getRelatedClasses(
    classId: string, studioOwnerId: string, limit = 4,
  ): Promise<Array<Record<string, unknown>>> {
    const db = getFirestore();
    const snapshot = await db.collection("classes")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isActive", "==", true)
      .limit(limit + 1)
      .get();

    const classes = snapshot.docs
      .filter((doc) => doc.id !== classId)
      .slice(0, limit)
      .map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));

    const studioOwnerDoc = await db.collection("users").doc(studioOwnerId).get();
    const sd = studioOwnerDoc.exists ? (studioOwnerDoc.data() as Record<string, unknown>) : null;

    const studio: StudioInfo = {
      id: studioOwnerId,
      name: sd ? (sd["studioName"] as string) || "" : "",
      city: sd ? (sd["city"] as string) || "" : "",
      state: sd ? (sd["state"] as string) || "" : "",
      addressLine1: sd ? (sd["studioAddressLine1"] as string) || "" : "",
      addressLine2: sd ? (sd["studioAddressLine2"] as string | null) ?? null : null,
      zip: sd ? (sd["zip"] as string) || "" : "",
    };

    return classes.map((cls) => ({ ...cls, studio }));
  }

  async getEnrolledCount(classId: string, classInstanceDate: string): Promise<number> {
    const db = getFirestore();
    const snapshot = await db.collection("attendance")
      .where("classId", "==", classId)
      .where("classInstanceDate", "==", classInstanceDate)
      .where("isRemoved", "==", false)
      .get();
    return snapshot.size;
  }

  async isClassFull(classId: string, classInstanceDate: string, studioOwnerId: string): Promise<boolean> {
    const classData = await this.getClassById(classId, studioOwnerId);
    if (!classData) throw new Error("Class not found");
    const maxCapacity = (classData["maxCapacity"] as number) ?? 20;
    const enrolled = await this.getEnrolledCount(classId, classInstanceDate);
    return enrolled >= maxCapacity;
  }

  async addToWaitlist(
    classId: string, studentId: string, classInstanceDate: string, studioOwnerId: string,
  ): Promise<string> {
    const db = getFirestore();
    const existing = await db.collection("waitlists")
      .where("classId", "==", classId)
      .where("studentId", "==", studentId)
      .where("classInstanceDate", "==", classInstanceDate)
      .where("isActive", "==", true)
      .get();
    if (!existing.empty) throw new Error("Student is already on the waitlist for this class instance");
    const docRef = await db.collection("waitlists").add({
      classId, studentId, classInstanceDate, studioOwnerId,
      isActive: true,
      notificationSent: false,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async getWaitlist(
    classId: string, classInstanceDate: string,
  ): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const snapshot = await db.collection("waitlists")
      .where("classId", "==", classId)
      .where("classInstanceDate", "==", classInstanceDate)
      .where("isActive", "==", true)
      .orderBy("addedAt", "asc")
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
  }

  async removeFromWaitlist(entryId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const doc = await db.collection("waitlists").doc(entryId).get();
    if (!doc.exists) throw new Error("Waitlist entry not found");
    if ((doc.data() as Record<string, unknown>)["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Waitlist entry does not belong to this studio owner");
    }
    await db.collection("waitlists").doc(entryId).update({ isActive: false });
  }

  async notifyFirstWaiting(
    classId: string, classInstanceDate: string, studioOwnerId: string,
  ): Promise<string | null> {
    const waitlist = await this.getWaitlist(classId, classInstanceDate);
    if (waitlist.length === 0) return null;

    const first = waitlist[0];
    if (!first) return null;
    const db = getFirestore();

    const [studentDoc, classDoc, studioDoc] = await Promise.all([
      db.collection("students").doc(first["studentId"] as string).get(),
      db.collection("classes").doc(classId).get(),
      db.collection("users").doc(studioOwnerId).get(),
    ]);

    if (!studentDoc.exists) return null;
    const studentData = studentDoc.data() as Record<string, unknown>;
    const classData = classDoc.exists ? (classDoc.data() as Record<string, unknown>) : {};
    const studioData = studioDoc.exists ? (studioDoc.data() as Record<string, unknown>) : {};
    const className = (classData["name"] as string) || "your class";
    const studioName = (studioData["studioName"] as string) || "the studio";

    if (studentData["email"]) {
      try {
        await sendWaitlistNotificationEmail(
          studentData["email"] as string,
          (studentData["firstName"] as string) || (studentData["name"] as string) || "there",
          className,
          studioName,
          classInstanceDate,
        );
      } catch (err) {
        console.error("[Waitlist] Failed to send notification email:", (err as Error).message);
      }
    }

    await db.collection("waitlists").doc(first["id"] as string).update({
      notificationSent: true,
      notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return first["studentId"] as string;
  }
}

export default new ClassesService();
