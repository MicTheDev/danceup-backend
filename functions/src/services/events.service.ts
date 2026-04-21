import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";
import { geocodeAddress } from "../utils/geocoding";
import { haversineDistance } from "../utils/distance";

interface EventFilters {
  type?: string | null;
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

export class EventsService {
  async getStudioOwnerId(authUid: string): Promise<string | null> {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) return null;
    return userDoc.id;
  }

  async getEvents(studioOwnerId: string): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const snapshot = await db.collection("events")
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
  }

  async getEventById(
    eventId: string, studioOwnerId: string,
  ): Promise<(Record<string, unknown> & { id: string }) | null> {
    const db = getFirestore();
    const doc = await db.collection("events").doc(eventId).get();
    if (!doc.exists) return null;
    const eventData = doc.data() as Record<string, unknown>;
    if (eventData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Event does not belong to this studio owner");
    }
    return { id: doc.id, ...eventData };
  }

  async createEvent(eventData: Record<string, unknown>, studioOwnerId: string): Promise<string> {
    const db = getFirestore();
    let coords: { lat: number; lng: number } | null = null;
    if (eventData["addressLine1"] && eventData["city"] && eventData["state"]) {
      coords = await geocodeAddress(
        eventData["addressLine1"] as string,
        eventData["city"] as string,
        eventData["state"] as string,
        (eventData["zip"] as string) || "",
      );
    }
    const docRef = await db.collection("events").add({
      ...eventData,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      studioOwnerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async updateEvent(eventId: string, eventData: Record<string, unknown>, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("events").doc(eventId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Event not found");
    const existingData = doc.data() as Record<string, unknown>;
    if (existingData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Event does not belong to this studio owner");
    }
    let coords: { lat: number; lng: number } | null = null;
    if (eventData["addressLine1"] && eventData["city"] && eventData["state"]) {
      coords = await geocodeAddress(
        eventData["addressLine1"] as string,
        eventData["city"] as string,
        eventData["state"] as string,
        (eventData["zip"] as string) || "",
      );
    }
    await ref.update({
      ...eventData,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  async deleteEvent(eventId: string, studioOwnerId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("events").doc(eventId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Event not found");
    const eventData = doc.data() as Record<string, unknown>;
    if (eventData["studioOwnerId"] !== studioOwnerId) {
      throw new Error("Access denied: Event does not belong to this studio owner");
    }
    await ref.delete();
  }

  async getAllPublicEvents(filters: EventFilters = {}): Promise<Array<Record<string, unknown>>> {
    const db = getFirestore();
    let query = db.collection("events") as FirebaseFirestore.Query;

    if (filters.type && filters.type !== "All") {
      query = query.where("type", "==", filters.type);
    }

    const snapshot = await query.get();
    const studioOwnerIds = new Set<string>();
    const eventsMap = new Map<string, Record<string, unknown>>();

    snapshot.forEach((doc) => {
      const eventData = doc.data() as Record<string, unknown>;
      if (eventData["studioOwnerId"]) {
        studioOwnerIds.add(eventData["studioOwnerId"] as string);
        eventsMap.set(doc.id, { id: doc.id, ...eventData });
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

    const enrichedEvents: Array<Record<string, unknown>> = [];
    const now = new Date();

    for (const eventData of eventsMap.values()) {
      const studioOwner = studioOwnersMap.get(eventData["studioOwnerId"] as string);
      if (!studioOwner) continue;

      const startTime = parseTimestamp(eventData["startTime"]);
      const endTimeRaw = eventData["endTime"];
      const endTime = endTimeRaw ? parseTimestamp(endTimeRaw) : null;
      const compareTime = endTime ?? startTime;

      if (compareTime < now) continue;

      if (filters.startDate) {
        if (compareTime < new Date(filters.startDate)) continue;
      }
      if (filters.endDate) {
        if (startTime > new Date(filters.endDate)) continue;
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

      const priceTiers = eventData["priceTiers"];
      if (Array.isArray(priceTiers) && priceTiers.length > 0) {
        const tiers = priceTiers as PriceTier[];
        const minPrice = Math.min(...tiers.map((t) => t.price ?? 0));
        const maxPrice = Math.max(...tiers.map((t) => t.price ?? 0));
        if (filters.minPrice != null && maxPrice < filters.minPrice) continue;
        if (filters.maxPrice != null && minPrice > filters.maxPrice) continue;
      } else if (filters.minPrice != null || filters.maxPrice != null) {
        continue;
      }

      enrichedEvents.push({
        ...eventData,
        startTime: startTime.toISOString(),
        endTime: endTime ? endTime.toISOString() : null,
        studio: {
          id: eventData["studioOwnerId"],
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
      const withDistance = enrichedEvents
        .filter((e) => e["lat"] != null && e["lng"] != null)
        .map((e) => ({
          ...e,
          distanceMiles: haversineDistance(lat, lng, e["lat"] as number, e["lng"] as number),
        }))
        .filter((e) => (e["distanceMiles"] as number) <= radius)
        .sort((a, b) => (a["distanceMiles"] as number) - (b["distanceMiles"] as number));

      return filters.limit != null ? withDistance.slice(0, filters.limit) : withDistance;
    }

    return filters.limit != null ? enrichedEvents.slice(0, filters.limit) : enrichedEvents;
  }

  async getPublicEventById(eventId: string): Promise<Record<string, unknown> | null> {
    const db = getFirestore();
    const doc = await db.collection("events").doc(eventId).get();
    if (!doc.exists) return null;
    const eventData = doc.data() as Record<string, unknown>;

    const studioOwnerDoc = await db.collection("users").doc(eventData["studioOwnerId"] as string).get();
    if (!studioOwnerDoc.exists) return null;
    const sd = studioOwnerDoc.data() as Record<string, unknown>;

    const startTime = parseTimestamp(eventData["startTime"]);
    const endTimeRaw = eventData["endTime"];
    const endTime = endTimeRaw ? parseTimestamp(endTimeRaw) : null;

    return {
      id: doc.id,
      ...eventData,
      startTime: startTime.toISOString(),
      endTime: endTime ? endTime.toISOString() : null,
      studio: {
        id: eventData["studioOwnerId"],
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

export default new EventsService();
