import * as crypto from "crypto";
import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";
import authService from "./auth.service";
import studentsService from "./students.service";
import { getApiKey, sendEmail } from "./sendgrid.service";

const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const CAMPAIGNS_COLLECTION = "marketingCampaigns";

interface ContentItem {
  id: string;
  [key: string]: unknown;
}

interface StudioContentFilters {
  selectedClassIds?: string[];
  selectedEventIds?: string[];
  selectedWorkshopIds?: string[];
}

interface StudioContent {
  studioName: string;
  classes: ContentItem[];
  events: ContentItem[];
  workshops: ContentItem[];
}

async function getUnsubscribeSecret(): Promise<string> {
  if (process.env["NODE_ENV"] === "development" || process.env["FUNCTIONS_EMULATOR"] === "true") {
    const envSecret = process.env["MARKETING_UNSUBSCRIBE_SECRET"];
    if (!envSecret) {
      throw new Error("MARKETING_UNSUBSCRIBE_SECRET environment variable must be set in development.");
    }
    return envSecret;
  }
  const sendgridKey = await getApiKey();
  return crypto.createHash("sha256").update(sendgridKey + "|marketing-unsubscribe").digest("hex");
}

export async function createUnsubscribeToken(authUid: string): Promise<string> {
  const secret = await getUnsubscribeSecret();
  const exp = Date.now() + TOKEN_EXPIRY_MS;
  const payload = JSON.stringify({ authUid, exp });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

export async function verifyUnsubscribeToken(token: string): Promise<string> {
  if (!token || typeof token !== "string") {
    throw new Error("Invalid or missing token");
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid token format");
  }
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) throw new Error("Invalid token format");
  const secret = await getUnsubscribeSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  if (signature !== expectedSig) {
    throw new Error("Invalid token signature");
  }
  let payload: { authUid?: string; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as { authUid?: string; exp?: number };
  } catch {
    throw new Error("Invalid token payload");
  }
  if (!payload.authUid || !payload.exp) {
    throw new Error("Invalid token payload");
  }
  if (Date.now() > payload.exp) {
    throw new Error("Token expired");
  }
  return payload.authUid;
}

export async function getSubscribedRecipients(studioOwnerId: string): Promise<Array<{
  id: string;
  email: string;
  authUid: string;
  firstName?: string;
  lastName?: string;
}>> {
  const { students } = await studentsService.getStudents(studioOwnerId);
  const result: Array<{ id: string; email: string; authUid: string; firstName?: string; lastName?: string }> = [];
  for (const student of students) {
    const authUid = student["authUid"] as string | undefined;
    if (!authUid) continue;
    const profileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!profileDoc) continue;
    const profile = profileDoc.data() as Record<string, unknown> | undefined;
    if (!profile || profile["subscribeToNewsletter"] !== true) continue;
    let email = profile["email"] as string | undefined;
    if (!email) {
      try {
        const firebaseUser = await admin.auth().getUser(authUid);
        email = firebaseUser.email;
      } catch {
        email = undefined;
      }
    }
    if (!email) continue;
    result.push({
      id: student["id"] as string,
      email,
      authUid,
      firstName: (student["firstName"] as string | undefined) || (profile["firstName"] as string | undefined),
      lastName: (student["lastName"] as string | undefined) || (profile["lastName"] as string | undefined),
    });
  }
  return result;
}

export async function createCampaign(
  studioOwnerId: string,
  subject: string,
  recipientCount: number,
  bodyText?: string,
  bodyHtml?: string,
): Promise<{ campaignId: string; category: string }> {
  const db = getFirestore();
  const ref = db.collection(CAMPAIGNS_COLLECTION).doc();
  const campaignId = ref.id;
  const category = `marketing-${campaignId}`;
  const doc: Record<string, unknown> = {
    studioOwnerId,
    subject,
    recipientCount,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    category,
  };
  if (bodyText) doc["bodyText"] = bodyText;
  if (bodyHtml) doc["bodyHtml"] = bodyHtml;
  await ref.set(doc);
  return { campaignId, category };
}

export interface SendCampaignParams {
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  templateId?: string;
  bodyContent?: string;
  recipientIds?: string[];
  sendToAll?: boolean;
}

export interface SendCampaignOptions {
  fromEmail: string;
  fromName: string;
  unsubscribeBaseUrl: string;
}

/**
 * Sends a campaign to the studio's subscribed recipients and logs it to marketingCampaigns.
 * Extracted from the `/marketing/send` route so other callers (the assistant approval flow)
 * can trigger a real send without duplicating this orchestration.
 */
export async function sendCampaignToRecipients(
  studioOwnerId: string,
  params: SendCampaignParams,
  opts: SendCampaignOptions,
): Promise<{ campaignId: string; recipientCount: number }> {
  const { subject, bodyHtml, bodyText, templateId, bodyContent, recipientIds, sendToAll } = params;

  if (!subject || typeof subject !== "string" || !subject.trim()) {
    throw new Error("Validation Error: subject is required");
  }
  const hasTemplate = typeof templateId === "string" && !!templateId.trim();
  const hasHtml = bodyHtml != null && typeof bodyHtml === "string";
  const hasText = bodyText != null && typeof bodyText === "string";
  if (!hasTemplate && !hasHtml && !hasText) {
    throw new Error("Validation Error: templateId or bodyHtml/bodyText is required");
  }

  const allRecipients = await getSubscribedRecipients(studioOwnerId);
  let toSend = allRecipients;
  if (!sendToAll && Array.isArray(recipientIds) && recipientIds.length > 0) {
    const idSet = new Set(recipientIds);
    toSend = allRecipients.filter((r) => idSet.has(r.id));
  }
  if (toSend.length === 0) {
    throw new Error("Validation Error: No recipients selected or no subscribed students");
  }

  const campaignResult = await createCampaign(
    studioOwnerId,
    subject.trim(),
    toSend.length,
    hasTemplate ? undefined : (hasText ? bodyText : undefined),
    hasTemplate ? undefined : (hasHtml ? bodyHtml : undefined),
  );
  const { campaignId, category: categoryId } = campaignResult;

  const from = { email: opts.fromEmail, name: opts.fromName };

  for (const recipient of toSend) {
    const token = await createUnsubscribeToken(recipient.authUid);
    const unsubscribeUrl = `${opts.unsubscribeBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;

    let msg: Record<string, unknown>;
    if (hasTemplate) {
      const firstName = recipient.firstName || "";
      msg = {
        to: recipient.email,
        from,
        templateId: (templateId as string).trim(),
        dynamicTemplateData: {
          firstName,
          subject: subject.trim(),
          bodyContent: bodyContent || "",
          unsubscribeUrl,
        },
        categories: [categoryId],
      };
    } else {
      const footerHtml = `<p style="margin-top:24px;font-size:12px;color:#666;">If you no longer wish to receive these emails, <a href="${unsubscribeUrl}">unsubscribe here</a>.</p>`;
      const footerText = `\n\nIf you no longer wish to receive these emails, unsubscribe here: ${unsubscribeUrl}`;
      const html = hasHtml ? (bodyHtml as string) + footerHtml : null;
      const text = hasText ? (bodyText as string) + footerText : null;
      msg = {
        to: recipient.email,
        from,
        subject: subject.trim(),
        categories: [categoryId],
      };
      if (html) msg["html"] = html;
      if (text) msg["text"] = text;
    }

    try {
      await sendEmail(msg as unknown as Parameters<typeof sendEmail>[0]);
    } catch (sendErr) {
      console.error("SendGrid error for", recipient.email, sendErr);
    }
  }

  return { campaignId, recipientCount: toSend.length };
}

export async function listCampaigns(studioOwnerId: string): Promise<Array<Record<string, unknown>>> {
  const db = getFirestore();
  const snapshot = await db
    .collection(CAMPAIGNS_COLLECTION)
    .where("studioOwnerId", "==", studioOwnerId)
    .get();
  const campaigns = snapshot.docs.map((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const sentAt = d["sentAt"];
    const sentAtIso = typeof (sentAt as { toDate?: () => Date } | undefined)?.toDate === "function"
      ? (sentAt as { toDate: () => Date }).toDate().toISOString()
      : sentAt;
    return { id: doc.id, ...d, sentAt: sentAtIso };
  });
  campaigns.sort((a, b) => {
    const ta = a["sentAt"] ? new Date(a["sentAt"] as string).getTime() : 0;
    const tb = b["sentAt"] ? new Date(b["sentAt"] as string).getTime() : 0;
    return tb - ta;
  });
  return campaigns;
}

export async function getCampaignById(
  campaignId: string,
  studioOwnerId: string,
): Promise<Record<string, unknown> | null> {
  const db = getFirestore();
  const doc = await db.collection(CAMPAIGNS_COLLECTION).doc(campaignId).get();
  if (!doc.exists) return null;
  const data = doc.data() as Record<string, unknown>;
  if (data["studioOwnerId"] !== studioOwnerId) return null;
  const sentAt = data["sentAt"];
  const sentAtIso = typeof (sentAt as { toDate?: () => Date } | undefined)?.toDate === "function"
    ? (sentAt as { toDate: () => Date }).toDate().toISOString()
    : sentAt;
  return { id: doc.id, ...data, sentAt: sentAtIso };
}

export async function unsubscribeByAuthUid(authUid: string): Promise<void> {
  const profileDoc = await authService.getStudentProfileByAuthUid(authUid);
  if (!profileDoc) {
    throw new Error("Profile not found");
  }
  const db = getFirestore();
  await db.collection("usersStudentProfiles").doc(profileDoc.id).update({
    subscribeToNewsletter: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

export async function getStudioContentPreview(studioOwnerId: string): Promise<StudioContent> {
  const db = getFirestore();

  const [studioDoc, classesSnap, eventsSnap, workshopsSnap] = await Promise.all([
    db.collection("users").doc(studioOwnerId).get(),
    db.collection("classes")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isActive", "==", true)
      .limit(20)
      .get(),
    db.collection("events")
      .where("studioOwnerId", "==", studioOwnerId)
      .limit(15)
      .get(),
    db.collection("workshops")
      .where("studioOwnerId", "==", studioOwnerId)
      .limit(15)
      .get(),
  ]);

  const studioName = studioDoc.exists
    ? ((studioDoc.data() as Record<string, unknown>)["studioName"] as string) || "Our Studio"
    : "Our Studio";

  const now = new Date();
  const toItems = (snap: FirebaseFirestore.QuerySnapshot): ContentItem[] =>
    snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
  const filterUpcoming = (items: ContentItem[]): ContentItem[] =>
    items.filter((item) => {
      if (!item["startTime"]) return true;
      return new Date(item["startTime"] as string) >= now;
    });

  return {
    studioName,
    classes: toItems(classesSnap),
    events: filterUpcoming(toItems(eventsSnap)),
    workshops: filterUpcoming(toItems(workshopsSnap)),
  };
}

export async function getStudioContentForAI(
  studioOwnerId: string,
  filters: StudioContentFilters = {},
): Promise<StudioContent> {
  const { studioName, classes, events, workshops } = await getStudioContentPreview(studioOwnerId);

  const filterByIds = (items: ContentItem[], ids: string[] | undefined): ContentItem[] => {
    if (!Array.isArray(ids) || ids.length === 0) return items;
    const idSet = new Set(ids);
    return items.filter((item) => idSet.has(item.id));
  };

  return {
    studioName,
    classes: filterByIds(classes, filters.selectedClassIds),
    events: filterByIds(events, filters.selectedEventIds),
    workshops: filterByIds(workshops, filters.selectedWorkshopIds),
  };
}
