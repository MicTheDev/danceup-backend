import { getFirestore } from "../utils/firestore";
import instructorsService from "./instructors.service";

interface StudioFilters {
  city?: string | null;
  state?: string | null;
  studioName?: string | null;
}

interface StudioListItem {
  id: string;
  studioName: string;
  studioImageUrl: string | null;
  city: string;
  state: string;
  zip: string;
  studioAddressLine1: string;
  studioAddressLine2: string | null;
}

interface StudioDetail extends StudioListItem {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  facebook: string | null;
  instagram: string | null;
  tiktok: string | null;
  youtube: string | null;
  membership: string | null;
  instructors: Array<{
    id: string;
    firstName: string;
    lastName: string;
    photoURL: string | null;
    bio: string | null;
    email: string | null;
    phone: string | null;
  }>;
}

export class StudiosService {
  async getAllPublicStudios(filters: StudioFilters = {}): Promise<StudioListItem[]> {
    const db = getFirestore();
    let query = db.collection("users").where("roles", "array-contains", "studio_owner");

    if (filters.state) {
      query = query.where("state", "==", filters.state.toUpperCase());
    }

    const snapshot = await query.get();
    const studios: StudioListItem[] = [];

    snapshot.forEach((doc) => {
      const userData = doc.data() as Record<string, unknown>;

      if (userData["subscriptionActive"] === false) return;

      if (filters.city && userData["city"]) {
        const studioCity = (userData["city"] as string).toLowerCase().trim();
        const filterCity = filters.city.toLowerCase().trim();
        if (!studioCity.includes(filterCity) && !filterCity.includes(studioCity)) return;
      }

      if (filters.studioName && userData["studioName"]) {
        const studioName = (userData["studioName"] as string).toLowerCase().trim();
        const filterName = filters.studioName.toLowerCase().trim();
        if (!studioName.includes(filterName)) return;
      }

      studios.push({
        id: doc.id,
        studioName: (userData["studioName"] as string) || "",
        studioImageUrl: (userData["studioImageUrl"] as string | null) ?? null,
        city: (userData["city"] as string) || "",
        state: (userData["state"] as string) || "",
        zip: (userData["zip"] as string) || "",
        studioAddressLine1: (userData["studioAddressLine1"] as string) || "",
        studioAddressLine2: (userData["studioAddressLine2"] as string | null) ?? null,
      });
    });

    return studios;
  }

  async getPublicStudioById(studioOwnerId: string): Promise<StudioDetail | null> {
    const db = getFirestore();
    const doc = await db.collection("users").doc(studioOwnerId).get();
    if (!doc.exists) return null;

    const d = doc.data() as Record<string, unknown>;
    const roles = (d["roles"] as string[] | undefined) ?? [];
    if (!roles.includes("studio_owner")) return null;
    if (d["subscriptionActive"] === false) return null;

    const instructors = await instructorsService.getInstructors(studioOwnerId);

    return {
      id: doc.id,
      studioName: (d["studioName"] as string) || "",
      studioImageUrl: (d["studioImageUrl"] as string | null) ?? null,
      city: (d["city"] as string) || "",
      state: (d["state"] as string) || "",
      zip: (d["zip"] as string) || "",
      studioAddressLine1: (d["studioAddressLine1"] as string) || "",
      studioAddressLine2: (d["studioAddressLine2"] as string | null) ?? null,
      firstName: (d["firstName"] as string) || "",
      lastName: (d["lastName"] as string) || "",
      email: (d["email"] as string) || "",
      phone: (d["phone"] as string | null) ?? null,
      facebook: (d["facebook"] as string | null) ?? null,
      instagram: (d["instagram"] as string | null) ?? null,
      tiktok: (d["tiktok"] as string | null) ?? null,
      youtube: (d["youtube"] as string | null) ?? null,
      membership: (d["membership"] as string | null) ?? null,
      instructors: instructors.map((instructor) => ({
        id: instructor["id"] as string,
        firstName: (instructor["firstName"] as string) || "",
        lastName: (instructor["lastName"] as string) || "",
        photoURL: (instructor["photoURL"] as string | null) ?? (instructor["photoUrl"] as string | null) ?? null,
        bio: (instructor["bio"] as string | null) ?? null,
        email: (instructor["email"] as string | null) ?? null,
        phone: (instructor["phone"] as string | null) ?? null,
      })),
    };
  }
}

export default new StudiosService();
