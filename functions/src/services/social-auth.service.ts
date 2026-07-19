import * as admin from "firebase-admin";
import authService from "./auth.service";
import studioEnrollmentService from "./studio-enrollment.service";
import { createCustomer } from "./stripe.service";
import { getFirestore } from "../utils/firestore";
import { getFirebaseApiKey } from "../utils/firebase-api-key";

export interface SocialProfile {
  email: string;
  firstName: string;
  lastName: string;
  picture?: string | null;
  provider: "google" | "apple";
}

export interface SocialSignInResult {
  idToken: string;
  refreshToken: string;
  expiresIn: string;
  user: { uid: string; email: string; studentProfileId: string | null; autoCheckInClassIds: string[] };
}

/**
 * Firebase Auth has no concept of "sign in with Google/Apple token" for a
 * backend-only (non-client-SDK) auth flow, so we map the verified OAuth
 * identity onto a Firebase user by email — reusing an existing account if
 * one already exists (e.g. the person originally registered with
 * email/password) rather than creating a duplicate.
 */
async function findOrCreateFirebaseUser(email: string): Promise<admin.auth.UserRecord> {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") {
      return admin.auth().createUser({ email, emailVerified: true });
    }
    throw err;
  }
}

/**
 * Shared account-provisioning + token-issuance logic for any verified
 * social sign-in (Google or Apple). Creates the student profile and Stripe
 * customer on first sign-in only; existing accounts are left untouched
 * apart from being matched by authUid.
 */
export async function completeSocialSignIn(profile: SocialProfile): Promise<SocialSignInResult> {
  const { firstName, lastName, picture, provider } = profile;
  // Normalize the same way users-app normalizes email/password sign-ups (trim + lowercase)
  // so a Google/Apple identity matches the same Firebase user and student profile
  // regardless of casing/whitespace differences in what the provider returns.
  const email = profile.email.trim().toLowerCase();

  const firebaseUser = await findOrCreateFirebaseUser(email);
  const uid = firebaseUser.uid;

  let studentDoc = await authService.getStudentProfileByAuthUid(uid);

  if (!studentDoc) {
    const profileData = {
      email,
      firstName,
      lastName,
      city: "", state: "", zip: "",
      phone: null,
      danceGenres: [],
      subscribeToNewsletter: false,
      photoURL: picture || null,
      provider,
    };

    const studentProfileId = await authService.createStudentProfileDocument(uid, profileData) as string;
    studentDoc = await authService.getStudentProfileByAuthUid(uid);

    try {
      await studioEnrollmentService.claimPlaceholderStudentsForAuthUid(uid, email);
    } catch (claimError) {
      console.error(`Error claiming placeholder students during ${provider} sign-in:`, claimError);
    }

    try {
      const stripeCustomer = await createCustomer(email, {
        uid,
        studentProfileId,
        name: `${firstName} ${lastName}`.trim(),
      }) as { id: string; email: string };
      const db = getFirestore();
      await db.collection("usersStudentProfiles").doc(studentProfileId).update({
        stripeCustomerId: stripeCustomer.id,
        stripeEmail: stripeCustomer.email,
      });
    } catch (stripeError) {
      console.error(`Error creating Stripe customer for ${provider} sign-in:`, stripeError);
    }
  }

  const apiKey = await getFirebaseApiKey();
  const customToken = await authService.createCustomToken(uid);
  const tokenResponse = await authService.exchangeCustomTokenForIdToken(customToken, apiKey);

  const studentData = studentDoc?.data() as Record<string, unknown> | undefined;
  return {
    idToken: tokenResponse.idToken,
    refreshToken: tokenResponse.refreshToken,
    expiresIn: tokenResponse.expiresIn,
    user: {
      uid,
      email,
      studentProfileId: studentDoc ? (studentDoc as unknown as { id: string }).id : null,
      autoCheckInClassIds: (studentData?.["autoCheckInClassIds"] as string[]) || [],
    },
  };
}
