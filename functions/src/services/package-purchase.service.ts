import authService from "./auth.service";
import packagesService from "./packages.service";
import studentsService from "./students.service";
import studioEnrollmentService from "./studio-enrollment.service";
import creditTrackingService from "./credit-tracking.service";
import { getFirestore } from "../utils/firestore";
import { ensureStudiosStructure } from "../utils/studio-enrollment.utils";

export class PackagePurchaseService {
  async purchasePackageForUser(
    packageId: string, authUid: string, studioOwnerId: string,
  ): Promise<{
    packageId: string;
    packageName: string;
    creditsAdded: number;
    newCreditBalance: number;
    studioOwnerId: string;
  }> {
    const db = getFirestore();

    const packageData = await packagesService.getPackageById(packageId, studioOwnerId);
    if (!packageData) throw new Error("Package not found or does not belong to this studio");
    if (!packageData["isActive"]) throw new Error("Package is not active");

    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) throw new Error("Student profile not found");

    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const userProfileData = (await userProfileRef.get()).data() as Record<string, unknown> | undefined;
    const studios = ensureStudiosStructure(userProfileData);
    if (!studios[studioOwnerId]) throw new Error("User is not enrolled in this studio");

    const studentSnapshot = await db.collection("students")
      .where("authUid", "==", authUid)
      .where("studioOwnerId", "==", studioOwnerId)
      .limit(1)
      .get();
    if (studentSnapshot.empty) throw new Error("Student record not found for this studio");
    const studentDoc = studentSnapshot.docs[0];
    if (!studentDoc) throw new Error("Student record not found for this studio");
    const studentId = studentDoc.id;

    const expirationDays = (packageData["expirationDays"] as number) || 365;
    const creditsToAdd = (packageData["credits"] as number) || 0;

    await creditTrackingService.addCredits(studentId, studioOwnerId, creditsToAdd, expirationDays, packageId, null);
    const newCreditBalance = await creditTrackingService.getAvailableCredits(studentId, studioOwnerId);

    return {
      packageId,
      packageName: packageData["name"] as string,
      creditsAdded: creditsToAdd,
      newCreditBalance,
      studioOwnerId,
    };
  }

  async purchasePackageForStudent(
    packageId: string, studentId: string, studioOwnerId: string,
  ): Promise<{
    packageId: string;
    packageName: string;
    creditsAdded: number;
    newCreditBalance: number;
    studentId: string;
    studioOwnerId: string;
  }> {
    const packageData = await packagesService.getPackageById(packageId, studioOwnerId);
    if (!packageData) throw new Error("Package not found or does not belong to this studio");
    if (!packageData["isActive"]) throw new Error("Package is not active");

    const studentDoc = await studentsService.getStudentById(studentId, studioOwnerId);
    if (!studentDoc) throw new Error("Student not found");
    const authUid = studentDoc["authUid"] as string | undefined;
    if (!authUid) throw new Error("Student record does not have an associated auth UID");

    const studentProfileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!studentProfileDoc) throw new Error("Student profile not found");

    // Verify studios structure (ensure student is enrolled)
    const db = getFirestore();
    const userProfileRef = db.collection("usersStudentProfiles").doc(studentProfileDoc.id);
    const userProfileData = (await userProfileRef.get()).data() as Record<string, unknown> | undefined;
    const studios = ensureStudiosStructure(userProfileData);
    if (!studios[studioOwnerId]) {
      studios[studioOwnerId] = {};
    }

    const expirationDays = (packageData["expirationDays"] as number) || 365;
    const creditsToAdd = (packageData["credits"] as number) || 0;

    await creditTrackingService.addCredits(studentId, studioOwnerId, creditsToAdd, expirationDays, packageId, null);
    const newCreditBalance = await creditTrackingService.getAvailableCredits(studentId, studioOwnerId);

    return {
      packageId,
      packageName: packageData["name"] as string,
      creditsAdded: creditsToAdd,
      newCreditBalance,
      studentId,
      studioOwnerId,
    };
  }
}

// Re-export studioEnrollmentService for use in routes
export { studioEnrollmentService };

export default new PackagePurchaseService();
