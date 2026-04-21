const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");
const sendgridService = require("./sendgrid.service");

const RE_ENGAGEMENT_DAYS = 14; // days without attendance before flagging
const RE_ENGAGEMENT_COOLDOWN_DAYS = 30; // days before re-sending re-engagement email
const CREDIT_EXPIRY_WARNING_DAYS = 7; // days before credit expiry to warn student
const CREDIT_EXPIRY_COOLDOWN_DAYS = 7; // days before re-sending credit expiry email

/**
 * Service for automated student retention email triggers
 */
class RetentionService {
  /**
   * Process retention emails for all studios.
   * Called by the daily scheduled function.
   * @returns {Promise<{totalReEngagement: number, totalCreditExpiry: number}>}
   */
  async processAllStudios() {
    const db = getFirestore();

    // Get all unique studio owner IDs from students collection
    const studentsSnapshot = await db.collection("students").get();
    const studioOwnerIds = new Set();
    studentsSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.studioOwnerId) studioOwnerIds.add(data.studioOwnerId);
    });

    let totalReEngagement = 0;
    let totalCreditExpiry = 0;

    for (const studioOwnerId of studioOwnerIds) {
      try {
        const [re, ce] = await Promise.all([
          this.processReEngagementEmails(studioOwnerId),
          this.processCreditExpiryEmails(studioOwnerId),
        ]);
        totalReEngagement += re;
        totalCreditExpiry += ce;
      } catch (err) {
        console.error(`[Retention] Error processing studio ${studioOwnerId}:`, err.message);
      }
    }

    return {totalReEngagement, totalCreditExpiry};
  }

  /**
   * Send re-engagement emails to at-risk students for a studio.
   * A student is at-risk if they have no attendance in the last RE_ENGAGEMENT_DAYS days
   * and haven't received a re-engagement email within RE_ENGAGEMENT_COOLDOWN_DAYS days.
   * @param {string} studioOwnerId
   * @returns {Promise<number>} Number of emails sent
   */
  async processReEngagementEmails(studioOwnerId) {
    const db = getFirestore();
    const now = new Date();
    const cutoff = new Date(now.getTime() - RE_ENGAGEMENT_DAYS * 24 * 60 * 60 * 1000);
    const cooldown = new Date(now.getTime() - RE_ENGAGEMENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    // Get students who attended in the last 14 days (active students)
    const recentSnapshot = await db.collection("attendance")
        .where("studioOwnerId", "==", studioOwnerId)
        .where("isRemoved", "==", false)
        .where("classInstanceDate", ">=", admin.firestore.Timestamp.fromDate(cutoff))
        .get();

    const activeStudentIds = new Set();
    recentSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.studentId) activeStudentIds.add(data.studentId);
    });

    // Get all students for this studio
    const studentsSnapshot = await db.collection("students")
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    // Get studio name once
    const studioDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "your studio") : "your studio";

    let sent = 0;

    for (const studentDoc of studentsSnapshot.docs) {
      if (activeStudentIds.has(studentDoc.id)) continue;

      const studentData = studentDoc.data();
      if (!studentData.email) continue;

      // Check cooldown — skip if re-engagement email sent recently
      const recentEmail = await db.collection("retention_emails")
          .where("studentId", "==", studentDoc.id)
          .where("type", "==", "re_engagement")
          .where("sentAt", ">=", admin.firestore.Timestamp.fromDate(cooldown))
          .limit(1)
          .get();

      if (!recentEmail.empty) continue;

      try {
        await sendgridService.sendReEngagementEmail(
            studentData.email,
            studentData.firstName || studentData.name || "there",
            studioName,
        );

        await db.collection("retention_emails").add({
          studentId: studentDoc.id,
          studioOwnerId,
          type: "re_engagement",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        sent++;
      } catch (err) {
        console.error(`[Retention] Failed re-engagement email to ${studentData.email}:`, err.message);
      }
    }

    return sent;
  }

  /**
   * Send credit expiry warning emails for a studio.
   * Sends to students with credits expiring within CREDIT_EXPIRY_WARNING_DAYS days
   * who haven't been notified within CREDIT_EXPIRY_COOLDOWN_DAYS days.
   * @param {string} studioOwnerId
   * @returns {Promise<number>} Number of emails sent
   */
  async processCreditExpiryEmails(studioOwnerId) {
    const db = getFirestore();
    const now = new Date();
    const warningDate = new Date(now.getTime() + CREDIT_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000);
    const cooldown = new Date(now.getTime() - CREDIT_EXPIRY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    // Find unused credits expiring within the warning window for this studio
    const creditsSnapshot = await db.collectionGroup("credits")
        .where("studioOwnerId", "==", studioOwnerId)
        .where("used", "==", false)
        .where("expiresAt", ">=", admin.firestore.Timestamp.fromDate(now))
        .where("expiresAt", "<=", admin.firestore.Timestamp.fromDate(warningDate))
        .get();

    // Group by studentId, tracking count and earliest expiry date
    const studentCreditMap = new Map();
    creditsSnapshot.forEach((doc) => {
      const data = doc.data();
      if (!data.studentId) return;
      if (!studentCreditMap.has(data.studentId)) {
        studentCreditMap.set(data.studentId, {count: 0, expiresAt: null});
      }
      const entry = studentCreditMap.get(data.studentId);
      entry.count++;
      const expDate = data.expiresAt?.toDate ? data.expiresAt.toDate() : null;
      if (expDate && (!entry.expiresAt || expDate < entry.expiresAt)) {
        entry.expiresAt = expDate;
      }
    });

    // Get studio name once
    const studioDoc = await db.collection("users").doc(studioOwnerId).get();
    const studioName = studioDoc.exists ? (studioDoc.data().studioName || "your studio") : "your studio";

    let sent = 0;

    for (const [studentId, creditInfo] of studentCreditMap.entries()) {
      // Check cooldown
      const recentEmail = await db.collection("retention_emails")
          .where("studentId", "==", studentId)
          .where("type", "==", "credit_expiry")
          .where("sentAt", ">=", admin.firestore.Timestamp.fromDate(cooldown))
          .limit(1)
          .get();

      if (!recentEmail.empty) continue;

      const studentDoc = await db.collection("students").doc(studentId).get();
      if (!studentDoc.exists) continue;
      const studentData = studentDoc.data();
      if (!studentData.email) continue;

      const expiryDateStr = creditInfo.expiresAt
        ? creditInfo.expiresAt.toLocaleDateString("en-US", {month: "long", day: "numeric", year: "numeric"})
        : "soon";

      try {
        await sendgridService.sendCreditExpiryEmail(
            studentData.email,
            studentData.firstName || studentData.name || "there",
            studioName,
            creditInfo.count,
            expiryDateStr,
        );

        await db.collection("retention_emails").add({
          studentId,
          studioOwnerId,
          type: "credit_expiry",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        sent++;
      } catch (err) {
        console.error(`[Retention] Failed credit expiry email to ${studentData.email}:`, err.message);
      }
    }

    return sent;
  }
}

module.exports = new RetentionService();
