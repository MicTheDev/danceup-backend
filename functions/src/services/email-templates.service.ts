import { getFirestore } from "../utils/firestore";

const COLLECTION = "emailTemplates";

interface TemplateListItem {
  id: string;
  name: string;
  html: string;
  createdAt: string;
  updatedAt: string;
}

interface TemplateDetail extends TemplateListItem {
  design: unknown;
  studioOwnerId: string;
}

export async function saveTemplate(
  studioOwnerId: string, name: string, design: unknown, html: string,
): Promise<string> {
  const db = getFirestore();
  const ref = await db.collection(COLLECTION).add({
    studioOwnerId, name, design, html,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return ref.id;
}

export async function updateTemplate(
  templateId: string, studioOwnerId: string, name: string, design: unknown, html: string,
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(templateId);
  const doc = await ref.get();
  const data = doc.data() as Record<string, unknown> | undefined;
  if (!doc.exists || data?.["studioOwnerId"] !== studioOwnerId) {
    throw new Error("Template not found or access denied");
  }
  await ref.update({ name, design, html, updatedAt: new Date().toISOString() });
}

export async function listTemplates(studioOwnerId: string): Promise<TemplateListItem[]> {
  const db = getFirestore();
  const snap = await db.collection(COLLECTION)
    .where("studioOwnerId", "==", studioOwnerId)
    .orderBy("updatedAt", "desc")
    .get();
  return snap.docs.map((doc) => {
    const d = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      name: d["name"] as string,
      html: (d["html"] as string) || "",
      createdAt: d["createdAt"] as string,
      updatedAt: d["updatedAt"] as string,
    };
  });
}

export async function getTemplate(templateId: string, studioOwnerId: string): Promise<TemplateDetail | null> {
  const db = getFirestore();
  const doc = await db.collection(COLLECTION).doc(templateId).get();
  const data = doc.data() as Record<string, unknown> | undefined;
  if (!doc.exists || data?.["studioOwnerId"] !== studioOwnerId) return null;
  return { id: doc.id, ...(data as Omit<TemplateDetail, "id">) };
}

export async function deleteTemplate(templateId: string, studioOwnerId: string): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(templateId);
  const doc = await ref.get();
  const data = doc.data() as Record<string, unknown> | undefined;
  if (!doc.exists || data?.["studioOwnerId"] !== studioOwnerId) {
    throw new Error("Template not found or access denied");
  }
  await ref.delete();
}
