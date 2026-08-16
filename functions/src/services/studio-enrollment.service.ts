import * as admin from "firebase-admin";
import authService from "./auth.service";
import studentsService from "./students.service";
import { ensureStudiosStructure } from "../utils/studio-enrollment.utils";
import { getFirestore } from "../utils/firestore";
import { normalizeEmail } from "../utils/validation";
import type { StudiosMap } from "../types/firebase";

export class StudioEnrollmentService {
  convertStudioIdsToStudios(studioIds: string[]): StudiosMap {
    if (!Array.isArray(studioIds)) return {};
    const studios: StudiosMap = {};
    studioIds.forEach((studioId) => { studios[studioId] = { credits: 0 }; });
    return studios;
  }

  ensureStudiosStructure(userProfileData: Record<string, unknown> | null | undefined): StudiosMap {
    return ensureStudiosStructure(userProfileData);
  }

  async enrollStudent(studioOwnerId: string, authUid: string): Promise<string> {
    const db = getFirestore();

    const isEnrolled = await this.checkEnrollmentStatus(studioOwnerId, authUid);
    if (isEnrolled) throw new Error("User is already enrolled as a student for this studio");

    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) throw new Error("Student profile not found. Please complete your profile first.");

    const studentProfileData = studentProfileDoc.data() as Record<string, unknown> | undefined;
    const email = normalizeEmail(studentProfileData?.["email"]);
    const studentData = {
      firstName: (studentProfileData?.["firstName"] as string) || "",
      lastName: (studentProfileData?.["lastName"] as string) || "",
      email: email ?? ((studentProfileData?.["email"] as string | null) ?? null),
      phone: (studentProfileData?.["phone"] as string | null) ?? null,
      authUid,
    };

    // If this studio already has a placeholder roster row for this email (e.g. imported via
    // CSV before this person signed up), claim it instead of creating a duplicate — this
    // preserves any attendance/credit/purchase history already recorded against that row.
    const placeholder = email ? await this.findUnclaimedPlaceholder(studioOwnerId, email) : null;

    let studentId: string;
    if (placeholder) {
      await db.collection("students").doc(placeholder.id).update({
        authUid,
        firstName: studentData.firstName || placeholder.data["firstName"],
        lastName: studentData.lastName || placeholder.data["lastName"],
        phone: studentData.phone ?? placeholder.data["phone"] ?? null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      studentId = placeholder.id;
    } else {
      studentId = await studentsService.createStudent(studentData, studioOwnerId);
    }

    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const userProfileDoc = await userProfileRef.get();
    const currentData = userProfileDoc.data() as Record<string, unknown> | undefined;
    const studios = ensureStudiosStructure(currentData);

    if (!studios[studioOwnerId]) {
      studios[studioOwnerId] = {};
      const updateData: Record<string, unknown> = {
        studios,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (Array.isArray(currentData?.["studioIds"])) {
        updateData["studioIds"] = admin.firestore.FieldValue.delete();
      }
      await userProfileRef.update(updateData);
    }

    return studentId;
  }

  /**
   * Enrolls a dependent (a parent-managed sub-profile with no login of its
   * own) at a studio. Mirrors enrollStudent, but sources the name from the
   * dependent sub-doc instead of the account holder's own profile, and tags
   * the new roster row with dependentId — everything downstream (credits,
   * attendance, purchases) resolves that row the same way it resolves any
   * other student, just filtered on dependentId instead of authUid alone.
   */
  async enrollDependent(studioOwnerId: string, authUid: string, dependentId: string): Promise<string> {
    const db = getFirestore();

    const parentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!parentProfileDoc) throw new Error("Student profile not found. Please complete your profile first.");

    const dependentRef = db.collection("usersStudentProfiles").doc(parentProfileDoc.id)
      .collection("dependents").doc(dependentId);
    const dependentDoc = await dependentRef.get();
    if (!dependentDoc.exists) throw new Error("Dependent profile not found");
    const dependentData = dependentDoc.data() as Record<string, unknown>;
    if (dependentData["graduatedAt"]) throw new Error("This dependent has already graduated to their own account");

    const existingRows = await db.collection("students")
      .where("authUid", "==", authUid)
      .where("studioOwnerId", "==", studioOwnerId)
      .get();
    if (existingRows.docs.some((doc) => doc.data()["dependentId"] === dependentId)) {
      throw new Error("This dependent is already enrolled at this studio");
    }

    const studentId = await studentsService.createStudent({
      firstName: (dependentData["firstName"] as string) || "",
      lastName: (dependentData["lastName"] as string) || "",
      email: null,
      phone: null,
      authUid,
      dependentId,
    }, studioOwnerId);

    const userProfileRef = db.collection("usersStudentProfiles").doc(parentProfileDoc.id);
    const currentData = (await userProfileRef.get()).data() as Record<string, unknown> | undefined;
    const studios = ensureStudiosStructure(currentData);
    if (!studios[studioOwnerId]) {
      studios[studioOwnerId] = {};
      await userProfileRef.update({ studios, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    return studentId;
  }

  /**
   * Graduation: re-points every roster row tagged with this dependentId to a
   * newly-registered independent account, and strips dependentId so the row
   * now reads as that person's own account-holder row. Credits carry over
   * automatically — they live in the row's `credits` subcollection, which
   * this never touches. Direct sibling of claimPlaceholderStudentsForAuthUid,
   * just matching on dependentId instead of email — and, like that sibling,
   * must also add each claimed studio to the new account's own `studios` map,
   * since /me and the dashboard discover enrolled studios from that map, not
   * by scanning the students collection.
   */
  async claimDependentRosterRowsForNewAuthUid(dependentId: string, newAuthUid: string): Promise<void> {
    const db = getFirestore();
    const snapshot = await db.collection("students")
      .where("dependentId", "==", dependentId)
      .get();
    if (snapshot.empty) return;

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, {
        authUid: newAuthUid,
        dependentId: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();

    const newProfileDoc = await authService.getStudentProfileByAuthUid(newAuthUid);
    if (!newProfileDoc) return;

    const userProfileRef = db.collection("usersStudentProfiles").doc(newProfileDoc.id);
    const currentData = (await userProfileRef.get()).data() as Record<string, unknown> | undefined;
    const studios = ensureStudiosStructure(currentData);

    let changed = false;
    snapshot.docs.forEach((doc) => {
      const studioOwnerId = (doc.data() as Record<string, unknown>)["studioOwnerId"] as string | undefined;
      if (studioOwnerId && !studios[studioOwnerId]) {
        studios[studioOwnerId] = {};
        changed = true;
      }
    });

    if (changed) {
      await userProfileRef.update({ studios, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }

  async unenrollStudent(studioOwnerId: string, authUid: string): Promise<void> {
    const db = getFirestore();
    const snapshot = await db.collection("students")
      .where("authUid", "==", authUid)
      .where("studioOwnerId", "==", studioOwnerId)
      .limit(1)
      .get();
    if (snapshot.empty) throw new Error("Student enrollment not found");
    const firstDoc = snapshot.docs[0];
    if (!firstDoc) throw new Error("Student enrollment not found");
    const studentId = firstDoc.id;

    await db.collection("students").doc(studentId).delete();

    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (studentProfileDoc) {
      const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
      const currentData = (await userProfileRef.get()).data() as Record<string, unknown> | undefined;
      const studios = ensureStudiosStructure(currentData);

      if (studios[studioOwnerId]) {
        delete studios[studioOwnerId];
        const updateData: Record<string, unknown> = {
          studios,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        const studioIds = currentData?.["studioIds"];
        if (Array.isArray(studioIds) && (studioIds as string[]).includes(studioOwnerId)) {
          updateData["studioIds"] = admin.firestore.FieldValue.arrayRemove(studioOwnerId);
        }
        await userProfileRef.update(updateData);
      }
    }
  }

  async checkEnrollmentStatus(studioOwnerId: string, authUid: string): Promise<boolean> {
    const db = getFirestore();
    const snapshot = await db.collection("students")
      .where("authUid", "==", authUid)
      .where("studioOwnerId", "==", studioOwnerId)
      .limit(1)
      .get();
    return !snapshot.empty;
  }

  private async findUnclaimedPlaceholder(
    studioOwnerId: string, email: string,
  ): Promise<{ id: string; data: Record<string, unknown> } | null> {
    const db = getFirestore();
    const snapshot = await db.collection("students")
      .where("studioOwnerId", "==", studioOwnerId)
      .where("email", "==", email)
      .limit(5)
      .get();
    const unclaimed = snapshot.docs.find((doc) => !doc.data()["authUid"]);
    if (!unclaimed) return null;
    return { id: unclaimed.id, data: unclaimed.data() as Record<string, unknown> };
  }

  /**
   * Called right after a student account is created (registration or Google sign-in).
   * Finds every placeholder `students` row across all studios matching this email
   * (e.g. rows created via CSV import before this person had an account), claims
   * them by setting authUid, and adds each of those studios to the profile's
   * `studios` map — so the student already sees every studio that imported them
   * without needing to separately "join" each one.
   */
  async claimPlaceholderStudentsForAuthUid(authUid: string, email: string | null | undefined): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return;

    const db = getFirestore();
    const snapshot = await db.collection("students")
      .where("email", "==", normalizedEmail)
      .get();

    const unclaimed = snapshot.docs.filter((doc) => !doc.data()["authUid"]);
    if (unclaimed.length === 0) return;

    await Promise.allSettled(
      unclaimed.map((doc) => doc.ref.update({
        authUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })),
    );

    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) return;

    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const currentData = (await userProfileRef.get()).data() as Record<string, unknown> | undefined;
    const studios = ensureStudiosStructure(currentData);

    let changed = false;
    unclaimed.forEach((doc) => {
      const studioOwnerId = (doc.data() as Record<string, unknown>)["studioOwnerId"] as string | undefined;
      if (studioOwnerId && !studios[studioOwnerId]) {
        studios[studioOwnerId] = {};
        changed = true;
      }
    });

    if (changed) {
      await userProfileRef.update({ studios, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }
}

export default new StudioEnrollmentService();
