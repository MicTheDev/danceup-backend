const crypto = require("crypto");
const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");
const authService = require("./auth.service");
const studentsService = require("./students.service");
const sendgridService = require("./sendgrid.service");

const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CAMPAIGNS_COLLECTION = "marketingCampaigns";

/**
 * Get secret for signing unsubscribe tokens. Uses the same SendGrid API key
 * that sendgrid.service uses to send email (via getApiKey()), so no extra secret needed.
 * @returns {Promise<string>}
 */
async function getUnsubscribeSecret() {
  if (process.env.NODE_ENV === "development" || process.env.FUNCTIONS_EMULATOR === "true") {
    const envSecret = process.env.MARKETING_UNSUBSCRIBE_SECRET;
    if (envSecret) return envSecret;
    return "dev-unsubscribe-secret-do-not-use-in-prod";
  }
  const sendgridKey = await sendgridService.getApiKey();
  return crypto.createHash("sha256").update(sendgridKey + "|marketing-unsubscribe").digest("hex");
}

/**
 * Create a signed unsubscribe token for a recipient
 * @param {string} authUid - Firebase Auth UID
 * @returns {Promise<string>} Token string
 */
async function createUnsubscribeToken(authUid) {
  const secret = await getUnsubscribeSecret();
  const exp = Date.now() + TOKEN_EXPIRY_MS;
  const payload = JSON.stringify({authUid, exp});
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/**
 * Verify unsubscribe token and return authUid
 * @param {string} token - Token from query string
 * @returns {Promise<string>} authUid
 */
async function verifyUnsubscribeToken(token) {
  if (!token || typeof token !== "string") {
    throw new Error("Invalid or missing token");
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid token format");
  }
  const [payloadB64, signature] = parts;
  const secret = await getUnsubscribeSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  if (signature !== expectedSig) {
    throw new Error("Invalid token signature");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (e) {
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

/**
 * Get all subscribed recipients for a studio (students with subscribeToNewsletter === true)
 * @param {string} studioOwnerId - Studio owner document ID
 * @returns {Promise<Array<{id: string, email: string, authUid: string, firstName?: string, lastName?: string}>>}
 */
async function getSubscribedRecipients(studioOwnerId) {
  const students = await studentsService.getStudents(studioOwnerId);
  const result = [];
  for (const student of students) {
    const authUid = student.authUid;
    if (!authUid) continue;
    const profileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!profileDoc) continue;
    const profile = profileDoc.data();
    if (profile.subscribeToNewsletter !== true) continue;
    const email = profile.email || (await admin.auth().getUser(authUid).catch(() => null))?.email;
    if (!email) continue;
    result.push({
      id: student.id,
      email,
      authUid,
      firstName: student.firstName || profile.firstName,
      lastName: student.lastName || profile.lastName,
    });
  }
  return result;
}

/**
 * Create a campaign record in Firestore. Category is set to marketing-<campaignId>.
 * @param {string} studioOwnerId
 * @param {string} subject
 * @param {number} recipientCount
 * @returns {Promise<{campaignId: string, category: string}>} Campaign document ID and SendGrid category
 */
async function createCampaign(studioOwnerId, subject, recipientCount, bodyText, bodyHtml) {
  const db = getFirestore();
  const ref = db.collection(CAMPAIGNS_COLLECTION).doc();
  const campaignId = ref.id;
  const category = `marketing-${campaignId}`;
  const doc = {
    studioOwnerId,
    subject,
    recipientCount,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    category,
  };
  if (bodyText) doc.bodyText = bodyText;
  if (bodyHtml) doc.bodyHtml = bodyHtml;
  await ref.set(doc);
  return {campaignId, category};
}

/**
 * List campaigns for a studio owner (newest first)
 * @param {string} studioOwnerId
 * @returns {Promise<Array<Object>>}
 */
async function listCampaigns(studioOwnerId) {
  const db = getFirestore();
  const snapshot = await db
      .collection(CAMPAIGNS_COLLECTION)
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
  const campaigns = snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      ...d,
      sentAt: d.sentAt?.toDate?.()?.toISOString?.() || d.sentAt,
    };
  });
  campaigns.sort((a, b) => {
    const ta = a.sentAt ? new Date(a.sentAt).getTime() : 0;
    const tb = b.sentAt ? new Date(b.sentAt).getTime() : 0;
    return tb - ta;
  });
  return campaigns;
}

/**
 * Get a single campaign by ID (and verify studio owner)
 * @param {string} campaignId
 * @param {string} studioOwnerId
 * @returns {Promise<Object|null>}
 */
async function getCampaignById(campaignId, studioOwnerId) {
  const db = getFirestore();
  const doc = await db.collection(CAMPAIGNS_COLLECTION).doc(campaignId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (data.studioOwnerId !== studioOwnerId) return null;
  return {
    id: doc.id,
    ...data,
    sentAt: data.sentAt?.toDate?.()?.toISOString?.() || data.sentAt,
  };
}

/**
 * Set subscribeToNewsletter to false for a user by authUid
 * @param {string} authUid
 * @returns {Promise<void>}
 */
async function unsubscribeByAuthUid(authUid) {
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

/**
 * Fetch all studio content for display (picker) and AI generation.
 * Returns the studio name plus active classes, upcoming events, and upcoming workshops.
 * @param {string} studioOwnerId
 * @returns {Promise<{studioName: string, classes: Array, events: Array, workshops: Array}>}
 */
async function getStudioContentPreview(studioOwnerId) {
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

  const studioName = studioDoc.exists ? (studioDoc.data().studioName || "Our Studio") : "Our Studio";

  const now = new Date();
  const toItems = (snap) => snap.docs.map((d) => ({id: d.id, ...d.data()}));
  const filterUpcoming = (items) => items.filter((item) => {
    if (!item.startTime) return true;
    return new Date(item.startTime) >= now;
  });

  return {
    studioName,
    classes: toItems(classesSnap),
    events: filterUpcoming(toItems(eventsSnap)),
    workshops: filterUpcoming(toItems(workshopsSnap)),
  };
}

/**
 * Fetch all studio content needed for AI campaign generation, with optional ID filtering.
 * @param {string} studioOwnerId
 * @param {{selectedClassIds?: string[], selectedEventIds?: string[], selectedWorkshopIds?: string[]}} [filters]
 * @returns {Promise<{studioName: string, classes: Array, events: Array, workshops: Array}>}
 */
async function getStudioContentForAI(studioOwnerId, filters = {}) {
  const {studioName, classes, events, workshops} = await getStudioContentPreview(studioOwnerId);

  const filterByIds = (items, ids) => {
    // null/undefined = use all; empty array = use all (no items selected means no filter applied)
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

module.exports = {
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  getSubscribedRecipients,
  createCampaign,
  listCampaigns,
  getCampaignById,
  unsubscribeByAuthUid,
  getStudioContentPreview,
  getStudioContentForAI,
  CAMPAIGNS_COLLECTION,
};
