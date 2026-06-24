import { getFirestore } from "../utils/firestore";

export interface FlyerDocument {
  id: string;
  studioOwnerId: string;
  type: "event" | "class" | "workshop" | "schedule";
  contentName: string;
  svgContent: string;
  flyerHeight: number;
  createdAt: string;
}

function db() {
  return getFirestore();
}

export async function saveFlyer(
  studioOwnerId: string,
  data: Omit<FlyerDocument, "id" | "studioOwnerId" | "createdAt">,
): Promise<FlyerDocument> {
  const doc = db().collection("marketingFlyers").doc();
  const flyer: FlyerDocument = {
    id: doc.id,
    studioOwnerId,
    createdAt: new Date().toISOString(),
    ...data,
  };
  await doc.set(flyer);
  return flyer;
}

export async function listFlyers(studioOwnerId: string): Promise<FlyerDocument[]> {
  const snap = await db()
    .collection("marketingFlyers")
    .where("studioOwnerId", "==", studioOwnerId)
    .limit(50)
    .get();

  const docs = snap.docs.map((d) => d.data() as FlyerDocument);
  return docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getFlyerById(flyerId: string, studioOwnerId: string): Promise<FlyerDocument | null> {
  const doc = await db().collection("marketingFlyers").doc(flyerId).get();
  if (!doc.exists) return null;
  const data = doc.data() as FlyerDocument;
  if (data.studioOwnerId !== studioOwnerId) return null;
  return data;
}

export async function deleteFlyer(flyerId: string, studioOwnerId: string): Promise<boolean> {
  const doc = await db().collection("marketingFlyers").doc(flyerId).get();
  if (!doc.exists) return false;
  const data = doc.data() as FlyerDocument;
  if (data.studioOwnerId !== studioOwnerId) return false;
  await db().collection("marketingFlyers").doc(flyerId).delete();
  return true;
}
