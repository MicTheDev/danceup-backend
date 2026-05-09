import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "../utils/firestore";
import storageService from "../services/storage.service";
import { getStripeClient } from "../services/stripe.service";

if (!admin.apps.length) { admin.initializeApp(); }

const DELETION_WINDOW_DAYS = 90;
const FINANCIAL_RETENTION_YEARS = 7;

async function processStudentDeletions(): Promise<number> {
  const db = getFirestore();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DELETION_WINDOW_DAYS);

  const sevenYearsAgo = new Date();
  sevenYearsAgo.setFullYear(sevenYearsAgo.getFullYear() - FINANCIAL_RETENTION_YEARS);

  const pendingSnap = await db.collection("usersStudentProfiles")
    .where("deletionStatus", "==", "pending")
    .where("deletionRequestedAt", "<=", admin.firestore.Timestamp.fromDate(cutoff))
    .get();

  let deleted = 0;

  for (const profileDoc of pendingSnap.docs) {
    const profileData = profileDoc.data() as Record<string, unknown>;
    const authUid = profileData["authUid"] as string;

    try {
      const batch = db.batch();

      // Anonymize purchases older records keep amounts/dates, PII stripped
      // Records older than 7 years are fully deleted
      const purchasesSnap = await db.collection("purchases")
        .where("authUid", "==", authUid)
        .get();

      for (const purchaseDoc of purchasesSnap.docs) {
        const purchasedAt = (purchaseDoc.data() as Record<string, unknown>)["purchasedAt"] as admin.firestore.Timestamp | undefined;
        if (purchasedAt && purchasedAt.toDate() < sevenYearsAgo) {
          batch.delete(purchaseDoc.ref);
        } else {
          batch.update(purchaseDoc.ref, {
            authUid: "deleted",
            studentId: "deleted",
            guestEmail: admin.firestore.FieldValue.delete(),
          });
        }
      }

      // Anonymize attendance records (studio's business records — keep but strip PII)
      const attendanceSnap = await db.collection("attendance")
        .where("authUid", "==", authUid)
        .get();
      for (const attDoc of attendanceSnap.docs) {
        batch.update(attDoc.ref, {
          authUid: "deleted",
        });
      }

      // Delete the profile doc itself
      batch.delete(profileDoc.ref);
      await batch.commit();

      // Delete avatar from storage
      if (profileData["photoURL"]) {
        try {
          await storageService.deleteFile(profileData["photoURL"] as string);
        } catch (e) {
          console.error(`[AccountDeletion] Failed to delete avatar for ${authUid}:`, e);
        }
      }

      // Delete Stripe customer
      if (profileData["stripeCustomerId"]) {
        try {
          const stripe = await getStripeClient();
          await stripe.customers.del(profileData["stripeCustomerId"] as string);
        } catch (e) {
          console.error(`[AccountDeletion] Failed to delete Stripe customer for ${authUid}:`, e);
        }
      }

      // Delete Firebase Auth user last
      try {
        await admin.auth().deleteUser(authUid);
      } catch (e) {
        console.error(`[AccountDeletion] Failed to delete Firebase Auth user ${authUid}:`, e);
      }

      deleted++;
      console.log(`[AccountDeletion] Student ${authUid} permanently deleted.`);
    } catch (error) {
      console.error(`[AccountDeletion] Error processing student deletion for ${authUid}:`, error);
    }
  }

  return deleted;
}

async function processStudioOwnerDeletions(): Promise<number> {
  const db = getFirestore();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DELETION_WINDOW_DAYS);

  const sevenYearsAgo = new Date();
  sevenYearsAgo.setFullYear(sevenYearsAgo.getFullYear() - FINANCIAL_RETENTION_YEARS);

  const pendingSnap = await db.collection("users")
    .where("deletionStatus", "==", "pending")
    .where("deletionRequestedAt", "<=", admin.firestore.Timestamp.fromDate(cutoff))
    .get();

  let deleted = 0;

  for (const userDoc of pendingSnap.docs) {
    const userData = userDoc.data() as Record<string, unknown>;
    const authUid = userData["authUid"] as string;
    const studioOwnerId = userDoc.id;

    try {
      // Fully cancel Stripe subscription if still active
      if (userData["stripeSubscriptionId"]) {
        try {
          const stripe = await getStripeClient();
          await stripe.subscriptions.cancel(userData["stripeSubscriptionId"] as string);
        } catch (e) {
          console.error(`[AccountDeletion] Failed to cancel Stripe subscription for ${studioOwnerId}:`, e);
        }
      }

      // Gather all studio data for cascade delete
      const [classesSnap, workshopsSnap, eventsSnap, packagesSnap, instructorsSnap, studentsSnap, attendanceSnap, purchasesSnap] =
        await Promise.all([
          db.collection("classes").where("studioOwnerId", "==", studioOwnerId).get(),
          db.collection("workshops").where("studioOwnerId", "==", studioOwnerId).get(),
          db.collection("events").where("studioOwnerId", "==", studioOwnerId).get(),
          db.collection("packages").where("studioOwnerId", "==", studioOwnerId).get(),
          db.collection("instructors").where("studioOwnerId", "==", studioOwnerId).get(),
          db.collection("students").where("studioOwnerId", "==", studioOwnerId).get(),
          db.collection("attendance").where("studioOwnerId", "==", studioOwnerId).get(),
          db.collection("purchases").where("studioOwnerId", "==", studioOwnerId).get(),
        ]);

      // Firestore batch has 500-op limit — commit in chunks
      const toDelete = [
        ...classesSnap.docs,
        ...workshopsSnap.docs,
        ...eventsSnap.docs,
        ...packagesSnap.docs,
        ...instructorsSnap.docs,
        ...studentsSnap.docs,
        ...attendanceSnap.docs,
      ];

      const chunkSize = 490;
      for (let i = 0; i < toDelete.length; i += chunkSize) {
        const batch = db.batch();
        toDelete.slice(i, i + chunkSize).forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
      }

      // Anonymize purchase records (7-year financial retention)
      const purchaseBatch = db.batch();
      for (const purchaseDoc of purchasesSnap.docs) {
        const purchasedAt = (purchaseDoc.data() as Record<string, unknown>)["purchasedAt"] as admin.firestore.Timestamp | undefined;
        if (purchasedAt && purchasedAt.toDate() < sevenYearsAgo) {
          purchaseBatch.delete(purchaseDoc.ref);
        } else {
          purchaseBatch.update(purchaseDoc.ref, {
            studioOwnerId: "deleted",
          });
        }
      }
      await purchaseBatch.commit();

      // Delete studio image from storage
      if (userData["studioImageUrl"]) {
        try {
          await storageService.deleteFile(userData["studioImageUrl"] as string);
        } catch (e) {
          console.error(`[AccountDeletion] Failed to delete studio image for ${studioOwnerId}:`, e);
        }
      }

      // Delete the user profile doc
      await db.collection("users").doc(studioOwnerId).delete();

      // Delete Firebase Auth user last
      try {
        await admin.auth().deleteUser(authUid);
      } catch (e) {
        console.error(`[AccountDeletion] Failed to delete Firebase Auth user ${authUid}:`, e);
      }

      deleted++;
      console.log(`[AccountDeletion] Studio owner ${studioOwnerId} permanently deleted.`);
    } catch (error) {
      console.error(`[AccountDeletion] Error processing studio owner deletion for ${studioOwnerId}:`, error);
    }
  }

  return deleted;
}

export const processAccountDeletions = onSchedule(
  { schedule: "0 4 * * *", timeZone: "UTC" },
  async (_event) => {
    console.log("[AccountDeletion] Starting scheduled account deletion job");
    try {
      const [studentsDeleted, ownersDeleted] = await Promise.all([
        processStudentDeletions(),
        processStudioOwnerDeletions(),
      ]);
      console.log(`[AccountDeletion] Job complete. Students: ${studentsDeleted}, Studio owners: ${ownersDeleted}`);
    } catch (error) {
      console.error("[AccountDeletion] Scheduler error:", error);
      throw error;
    }
  },
);
