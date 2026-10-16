import * as crypto from "crypto";
import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";
import { getStudioOwnerData, getTierLimit } from "../utils/membership";
import authService from "./auth.service";
import studentsService from "./students.service";
import { getApiKey, sendEmail } from "./sendgrid.service";
import { getDeployedFunctionBaseUrl } from "../utils/http";

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

// Automation/retention emails: the token names one studio's student record, so an
// unsubscribe stops that studio's automated emails even for students without an app account.
// 90 days comfortably exceeds CAN-SPAM's 30-day minimum for a working opt-out link.
const AUTOMATION_TOKEN_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

export async function createAutomationUnsubscribeToken(studentId: string): Promise<string> {
  const secret = await getUnsubscribeSecret();
  const payload = JSON.stringify({ sid: studentId, kind: "automation", exp: Date.now() + AUTOMATION_TOKEN_EXPIRY_MS });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

export async function verifyAutomationUnsubscribeToken(token: string): Promise<string> {
  const parts = typeof token === "string" ? token.split(".") : [];
  const [payloadB64, signature] = parts;
  if (parts.length !== 2 || !payloadB64 || !signature) throw new Error("Invalid token format");
  const secret = await getUnsubscribeSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  if (signature !== expectedSig) throw new Error("Invalid token signature");
  let payload: { sid?: string; kind?: string; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as typeof payload;
  } catch {
    throw new Error("Invalid token payload");
  }
  if (payload.kind !== "automation" || !payload.sid || !payload.exp) throw new Error("Invalid token payload");
  if (Date.now() > payload.exp) throw new Error("Token expired");
  return payload.sid;
}

/** Unsubscribe link for an automated email to one studio's student, or undefined if it can't be built. */
export async function getAutomationUnsubscribeUrl(studentId: string): Promise<string | undefined> {
  const base = getDeployedFunctionBaseUrl("marketing");
  if (!base) return undefined;
  const token = await createAutomationUnsubscribeToken(studentId);
  return `${base}/unsubscribe-automations?token=${encodeURIComponent(token)}`;
}

export async function unsubscribeStudentFromAutomations(studentId: string): Promise<void> {
  const ref = getFirestore().collection("students").doc(studentId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Student not found");
  await ref.update({
    emailOptOut: true,
    emailOptOutAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Returns a check for whether a student has opted out of automated emails: either they
 * unsubscribed from this studio's automations (students.emailOptOut) or they unsubscribed
 * from DanceUp marketing via a campaign link (usersStudentProfiles.emailOptOut).
 * subscribeToNewsletter=false is NOT treated as an opt-out — it's also the signup default.
 */
export async function getEmailOptOutChecker(): Promise<(student: Record<string, unknown>) => boolean> {
  const snap = await getFirestore().collection("usersStudentProfiles").where("emailOptOut", "==", true).get();
  const optedOutAuthUids = new Set<string>();
  snap.forEach((doc) => {
    const uid = (doc.data() as Record<string, unknown>)["authUid"];
    if (typeof uid === "string") optedOutAuthUids.add(uid);
  });
  return (student) => {
    if (student["emailOptOut"] === true) return true;
    const uid = student["authUid"];
    return typeof uid === "string" && optedOutAuthUids.has(uid);
  };
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

export interface CampaignRecipient {
  id: string;
  email: string;
  /** null for roster-only students without a DanceUp account. */
  authUid: string | null;
  firstName?: string;
  lastName?: string;
}

export interface CampaignAudienceBreakdown {
  eligible: number;
  optedOut: number;
  noEmail: number;
  /** Students with a DanceUp account who didn't opt in, and the studio hasn't confirmed consent. */
  notOptedIn: number;
  /** Roster-only students the studio hasn't confirmed consent for. */
  noConsent: number;
}

/**
 * Who a studio's campaigns can reach:
 * - Opted out (students.emailOptOut or usersStudentProfiles.emailOptOut) — never.
 * - Students with a DanceUp account — if they opted in (subscribeToNewsletter) or the
 *   studio confirmed consent for them (students.emailConsent).
 * - Roster-only students (no account) — if the studio confirmed consent.
 */
export async function getCampaignAudience(studioOwnerId: string): Promise<{
  recipients: CampaignRecipient[];
  breakdown: CampaignAudienceBreakdown;
}> {
  const { students } = await studentsService.getStudents(studioOwnerId);
  const recipients: CampaignRecipient[] = [];
  const breakdown: CampaignAudienceBreakdown = { eligible: 0, optedOut: 0, noEmail: 0, notOptedIn: 0, noConsent: 0 };

  for (const student of students) {
    const authUid = (student["authUid"] as string | undefined) || null;
    const studioConsent = student["emailConsent"] === true;
    let email = (student["email"] as string | undefined) || undefined;
    let optedOut = student["emailOptOut"] === true;
    let eligible: boolean;

    const profile = authUid
      ? ((await authService.getStudentProfileByAuthUid(authUid))?.data() as Record<string, unknown> | undefined)
      : undefined;
    if (authUid && profile) {
      optedOut = optedOut || profile["emailOptOut"] === true;
      email = (profile["email"] as string | undefined) || email;
      if (!email) {
        try {
          email = (await admin.auth().getUser(authUid)).email;
        } catch {
          email = undefined;
        }
      }
      eligible = profile["subscribeToNewsletter"] === true || studioConsent;
      if (!eligible && !optedOut && email) { breakdown.notOptedIn++; continue; }
    } else {
      eligible = studioConsent;
      if (!eligible && !optedOut && email) { breakdown.noConsent++; continue; }
    }

    if (!email) { breakdown.noEmail++; continue; }
    if (optedOut) { breakdown.optedOut++; continue; }

    breakdown.eligible++;
    recipients.push({
      id: student["id"] as string,
      email,
      authUid,
      firstName: (student["firstName"] as string | undefined) || undefined,
      lastName: (student["lastName"] as string | undefined) || undefined,
    });
  }
  return { recipients, breakdown };
}

export async function getSubscribedRecipients(studioOwnerId: string): Promise<CampaignRecipient[]> {
  return (await getCampaignAudience(studioOwnerId)).recipients;
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

  const recipientLimit = getTierLimit((await getStudioOwnerData(studioOwnerId))?.["membership"], "emailRecipients");
  if (recipientLimit !== null && toSend.length > recipientLimit) {
    throw new Error(`Validation Error: Your plan allows up to ${recipientLimit} recipients. Upgrade your plan to send to more recipients.`);
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
    // Account holders unsubscribe from DanceUp marketing; roster-only students from this studio.
    const unsubscribeUrl = recipient.authUid
      ? `${opts.unsubscribeBaseUrl}/unsubscribe?token=${encodeURIComponent(await createUnsubscribeToken(recipient.authUid))}`
      : `${opts.unsubscribeBaseUrl}/unsubscribe-automations?token=${encodeURIComponent(await createAutomationUnsubscribeToken(recipient.id))}`;

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
    // Explicit opt-out (distinct from the false signup default) so automated emails honor it too.
    emailOptOut: true,
    emailOptOutAt: admin.firestore.FieldValue.serverTimestamp(),
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
