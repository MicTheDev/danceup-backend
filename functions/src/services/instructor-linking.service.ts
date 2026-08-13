import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";
import { normalizeEmail } from "../utils/validation";

export interface InstructorLink {
  studioOwnerId: string;
  instructorId: string;
  studioName: string;
}

export class InstructorLinkingService {
  /**
   * Called whenever we have a fresh (authUid, email) pair — registration,
   * social sign-in, or plain login — so an instructor added by a studio
   * owner before or after this person had an account still gets linked.
   * Finds every unclaimed `instructors` row across all studios matching
   * this email, sets `authUid` on each, and records the link on this
   * person's `usersStudentProfiles` doc (instructor access rides on the
   * same profile as their student identity, not a separate collection).
   */
  async claimPlaceholderInstructorsForAuthUid(authUid: string, email: string | null | undefined): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return;

    const db = getFirestore();
    const snapshot = await db.collection("instructors")
      .where("email", "==", normalizedEmail)
      .get();

    const unclaimed = snapshot.docs.filter((doc) => !doc.data()["authUid"]);
    if (unclaimed.length === 0) return;

    await Promise.allSettled(
      unclaimed.map((doc) => doc.ref.update({
        authUid,
        authLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })),
    );

    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) return;

    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const currentData = (await userProfileRef.get()).data() as Record<string, unknown> | undefined;
    const instructorLinks = { ...((currentData?.["instructorLinks"] as Record<string, unknown>) ?? {}) };

    let changed = false;
    unclaimed.forEach((doc) => {
      const studioOwnerId = (doc.data() as Record<string, unknown>)["studioOwnerId"] as string | undefined;
      if (studioOwnerId && !instructorLinks[studioOwnerId]) {
        instructorLinks[studioOwnerId] = {
          instructorId: doc.id,
          linkedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        changed = true;
      }
    });

    if (changed) {
      await userProfileRef.update({
        instructorLinks,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  /**
   * Called right after `InstructorsService.createInstructor()` — the
   * reverse direction of the claim above: check whether the email the
   * studio owner just typed in already belongs to a users-app account, and
   * link immediately rather than waiting for that person's next login.
   */
  async linkInstructorIfAccountExists(instructorId: string, studioOwnerId: string, email: string | null | undefined): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return;

    const db = getFirestore();
    const profileSnapshot = await db.collection("usersStudentProfiles")
      .where("email", "==", normalizedEmail)
      .limit(1)
      .get();
    if (profileSnapshot.empty) return;

    const profileDoc = profileSnapshot.docs[0];
    if (!profileDoc) return;
    const profileData = profileDoc.data() as Record<string, unknown>;
    const authUid = profileData["authUid"] as string | undefined;
    if (!authUid) return;

    await db.collection("instructors").doc(instructorId).update({
      authUid,
      authLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const instructorLinks = { ...((profileData["instructorLinks"] as Record<string, unknown>) ?? {}) };
    instructorLinks[studioOwnerId] = {
      instructorId,
      linkedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await profileDoc.ref.update({
      instructorLinks,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /** Resolves the caller's instructor links from their student-profile doc, keyed by studioOwnerId. */
  async getInstructorLinksForAuthUid(authUid: string): Promise<Record<string, { instructorId: string }>> {
    const profileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!profileDoc) return {};
    const data = profileDoc.data() as Record<string, unknown>;
    return (data["instructorLinks"] as Record<string, { instructorId: string }>) ?? {};
  }

  /** Resolves a single studio link, verifying the caller actually owns it — the core ACL check every /usersinstructor route needs. */
  async resolveLink(
    authUid: string, requestedStudioOwnerId?: string,
  ): Promise<{ studioOwnerId: string; instructorId: string } | null> {
    const links = await this.getInstructorLinksForAuthUid(authUid);
    const studioOwnerIds = Object.keys(links);
    if (studioOwnerIds.length === 0) return null;

    if (requestedStudioOwnerId) {
      const link = links[requestedStudioOwnerId];
      if (!link) return null;
      return { studioOwnerId: requestedStudioOwnerId, instructorId: link.instructorId };
    }

    if (studioOwnerIds.length === 1) {
      const only = studioOwnerIds[0];
      if (!only) return null;
      const link = links[only];
      if (!link) return null;
      return { studioOwnerId: only, instructorId: link.instructorId };
    }

    // Ambiguous — caller must pass ?studioOwnerId= when linked at more than one studio.
    return null;
  }
}

export default new InstructorLinkingService();
