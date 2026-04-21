import * as admin from "firebase-admin";
import authService from "./auth.service";
import studentsService from "./students.service";
import { ensureStudiosStructure } from "../utils/studio-enrollment.utils";
import { getFirestore } from "../utils/firestore";
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
    const studentData = {
      firstName: (studentProfileData?.["firstName"] as string) || "",
      lastName: (studentProfileData?.["lastName"] as string) || "",
      email: (studentProfileData?.["email"] as string | null) ?? null,
      phone: (studentProfileData?.["phone"] as string | null) ?? null,
      authUid,
    };

    const studentId = await studentsService.createStudent(studentData, studioOwnerId);

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
}

export default new StudioEnrollmentService();
