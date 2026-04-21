import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";
import { geocodeAddress } from "../utils/geocoding";
import { haversineDistance } from "../utils/distance";

interface WorkshopFilters {
  level?: string | null;
  city?: string | null;
  state?: string | null;
  studioName?: string | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  lat?: number | null;
  lng?: number | null;
  radius?: number | null;
  limit?: number | null;
}

interface PriceTier {
  price?: number;
}

function parseTimestamp(val: unknown): Date {
  if (val && typeof val === "object" && "toDate" in val) {
    return (val as { toDate(): Date }).toDate();
  }
  return new Date(val as string | number);
}

export class WorkshopsService {
  async getStudioOwnerId(authUid: string): Promise<string | null> {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) return null;
    return userDoc.id;
  }

  async getWorkshops(studioOwnerId: string): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const snapshot = await db.collection("workshops")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
  }

  async getWorkshopById(
    workshopId: string, studioOwnerId: string,
  ): Promise<(Record<string, unknown> & { id: string }) | null> {
    const db = getFirestore();
    const doc = await db.collection("workshops").doc(workshopId).get();
    if (!doc.exists) return null;
    const workshopData = doc.data() as Record<string, unknown>;
    if (workshopData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Workshop does not belong to this studio owner");
    }
    return { id: doc.id, ...workshopData };
  }

  async createWorkshop(workshopData: Record<string, unknown>, studioOwnerId: string): Promise<string> {
    const db = getFirestore();
    let coords: { lat: number; lng: number } | null = null;
    if (workshopData["addressLine1"] && workshopData["city"] && workshopData["state"]) {
      coords = await geocodeAddress(
        workshopData["addressLine1"] as string,
        workshopData["city"] as string,
        workshopData["state"] as string,
        (workshopData["zip"] as string) || "",
      );
    }
    const docRef = await db.collection("workshops").add({
      ...workshopData,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async updateWorkshop(
    workshopId: string, workshopData: Record<string, unknown>, studioOwnerId: string,
  ): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("workshops").doc(workshopId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Workshop not found");
    const existingData = doc.data() as Record<string, unknown>;
    if (existingData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Workshop does not belong to this studio owner");
    }
    let coords: { lat: number; lng: number } | null = null;
    if (workshopData["addressLine1"] && workshopData["city"] && workshopData["state"]) {
      coords = await geocodeAddress(
        workshopData["addressLine1"] as string,
        workshopData["city"] as string,
        workshopData["state"] as string,
        (workshopData["zip"] as string) || "",
      );
    }
    await ref.update({
      ...workshopData,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async deleteWorkshop(workshopId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("workshops").doc(workshopId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Workshop not found");
    const workshopData = doc.data() as Record<string, unknown>;
    if (workshopData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Workshop does not belong to this studio owner");
    }
    await ref.delete();
  }

  async getAllPublicWorkshops(filters: WorkshopFilters = {}): Promise<Array<Record<string, unknown>>> {
    const db = getFirestore();
    const snapshot = await db.collection("workshops").get();

    const studioOwnerIds = new Set<string>();
    const workshopsMap = new Map<string, Record<string, unknown>>();

    snapshot.forEach((doc) => {
      const workshopData = doc.data() as Record<string, unknown>;
      if (workshopData["studioOwnerId"]) {
        studioOwnerIds.add(workshopData["studioOwnerId"] as string);
        workshopsMap.set(doc.id, { id: doc.id, ...workshopData });
      }
    });

    const studioOwnersMap = new Map<string, Record<string, unknown>>();
    if (studioOwnerIds.size > 0) {
      const idsArray = Array.from(studioOwnerIds).filter(Boolean);
      for (let i = 0; i < idsArray.length; i += 10) {
        const batch = idsArray.slice(i, i + 10).filter(Boolean);
        if (batch.length === 0) continue;
        const snap = await db.collection("users")
          .where(admin.firestore.FieldPath.documentId(), "in", batch)
          .get();
        snap.forEach((doc) => studioOwnersMap.set(doc.id, doc.data() as Record<string, unknown>));
      }
    }

    const enrichedWorkshops: Array<Record<string, unknown>> = [];

    for (const workshopData of workshopsMap.values()) {
      const studioOwner = studioOwnersMap.get(workshopData["studioOwnerId"] as string);
      if (!studioOwner) continue;

      const startTime = parseTimestamp(workshopData["startTime"]);
      const endTime = parseTimestamp(workshopData["endTime"]);
      const now = new Date();

      if (endTime < now) continue;
      if (filters.startDate && endTime < new Date(filters.startDate)) continue;
      if (filters.endDate && startTime > new Date(filters.endDate)) continue;

      if (filters.level && filters.level !== "All") {
        const levels = workshopData["levels"];
        if (!Array.isArray(levels) || !levels.includes(filters.level.toLowerCase())) continue;
      }

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

      const priceTiers = workshopData["priceTiers"];
      if (Array.isArray(priceTiers) && priceTiers.length > 0) {
        const tiers = priceTiers as PriceTier[];
        const minPrice = Math.min(...tiers.map((t) => t.price ?? 0));
        const maxPrice = Math.max(...tiers.map((t) => t.price ?? 0));
        if (filters.minPrice != null && maxPrice < filters.minPrice) continue;
        if (filters.maxPrice != null && minPrice > filters.maxPrice) continue;
      } else if (filters.minPrice != null || filters.maxPrice != null) {
        continue;
      }

      enrichedWorkshops.push({
        ...workshopData,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        studio: {
          id: workshopData["studioOwnerId"],
          name: (studioOwner["studioName"] as string) || "",
          city: (studioOwner["city"] as string) || "",
          state: (studioOwner["state"] as string) || "",
          addressLine1: (studioOwner["studioAddressLine1"] as string) || "",
          addressLine2: (studioOwner["studioAddressLine2"] as string | null) ?? null,
          zip: (studioOwner["zip"] as string) || "",
        },
      });
    }

    if (filters.lat != null && filters.lng != null) {
      const radius = filters.radius ?? 25;
      const lat = filters.lat;
      const lng = filters.lng;
      const withDistance = enrichedWorkshops
        .filter((w) => w["lat"] != null && w["lng"] != null)
        .map((w) => ({
          ...w,
          distanceMiles: haversineDistance(lat, lng, w["lat"] as number, w["lng"] as number),
        }))
        .filter((w) => (w["distanceMiles"] as number) <= radius)
        .sort((a, b) => (a["distanceMiles"] as number) - (b["distanceMiles"] as number));

      return filters.limit != null ? withDistance.slice(0, filters.limit) : withDistance;
    }

    return filters.limit != null ? enrichedWorkshops.slice(0, filters.limit) : enrichedWorkshops;
  }

  async getPublicWorkshopById(workshopId: string): Promise<Record<string, unknown> | null> {
    const db = getFirestore();
    const doc = await db.collection("workshops").doc(workshopId).get();
    if (!doc.exists) return null;
    const workshopData = doc.data() as Record<string, unknown>;

    const studioOwnerDoc = await db.collection("users").doc(workshopData["studioOwnerId"] as string).get();
    if (!studioOwnerDoc.exists) return null;
    const sd = studioOwnerDoc.data() as Record<string, unknown>;

    const startTime = parseTimestamp(workshopData["startTime"]);
    const endTime = parseTimestamp(workshopData["endTime"]);

    return {
      id: doc.id,
      ...workshopData,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      studio: {
        id: workshopData["studioOwnerId"],
        name: (sd["studioName"] as string) || "",
        city: (sd["city"] as string) || "",
        state: (sd["state"] as string) || "",
        addressLine1: (sd["studioAddressLine1"] as string) || "",
        addressLine2: (sd["studioAddressLine2"] as string | null) ?? null,
        zip: (sd["zip"] as string) || "",
      },
    };
  }
}

export default new WorkshopsService();
