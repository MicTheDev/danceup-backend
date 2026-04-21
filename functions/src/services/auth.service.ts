import * as admin from "firebase-admin";
import type { DocumentSnapshot } from "@google-cloud/firestore";
import { getFirestore } from "../utils/firestore";
import { getFirebaseApiKey } from "../utils/firebase-api-key";

interface PasswordSignInResponse {
  idToken: string;
  localId: string;
  email: string;
  refreshToken: string;
  expiresIn: string;
}

interface ActionCodeSettings {
  url: string;
  handleCodeInApp?: boolean;
}

export class AuthService {
  async createUser(email: string, password: string): Promise<admin.auth.UserRecord> {
    return admin.auth().createUser({ email, password });
  }

  async deleteUser(uid: string): Promise<void> {
    return admin.auth().deleteUser(uid);
  }

  async getUserByEmail(email: string): Promise<admin.auth.UserRecord> {
    return admin.auth().getUserByEmail(email);
  }

  async createCustomToken(uid: string): Promise<string> {
    return admin.auth().createCustomToken(uid);
  }

  async verifyPassword(email: string, password: string, apiKey: string): Promise<PasswordSignInResponse> {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(errorData.error?.message ?? "Failed to verify password");
    }
    return response.json() as Promise<PasswordSignInResponse>;
  }

  async exchangeCustomTokenForIdToken(customToken: string, apiKey: string): Promise<PasswordSignInResponse> {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(errorData.error?.message ?? "Failed to exchange custom token");
    }
    return response.json() as Promise<PasswordSignInResponse>;
  }

  async createUserDocument(authUid: string, userData: Record<string, unknown>): Promise<string> {
    const db = getFirestore();
    const docRef = await db.collection("users").add({
      ...userData,
      authUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async getUserDocumentByAuthUid(authUid: string): Promise<DocumentSnapshot | null> {
    const db = getFirestore();
    const snapshot = await db.collection("users")
      .where("authUid", "==", authUid)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0] ?? null;
  }

  hasStudioOwnerRole(userDoc: DocumentSnapshot | null): boolean {
    if (!userDoc || !userDoc.exists) return false;
    const userData = userDoc.data() as Record<string, unknown>;
    const roles = (userData["roles"] as string[]) ?? [];
    return roles.includes("studio_owner");
  }

  async createStudentProfileDocument(authUid: string, userData: Record<string, unknown>): Promise<string> {
    const db = getFirestore();
    const docRef = await db.collection("usersStudentProfiles").add({
      ...userData,
      authUid,
      role: "student",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  }

  async getStudentProfileByAuthUid(authUid: string): Promise<DocumentSnapshot | null> {
    const db = getFirestore();
    const snapshot = await db.collection("usersStudentProfiles")
      .where("authUid", "==", authUid)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0] ?? null;
  }

  async generatePasswordResetLink(email: string, actionCodeSettings: ActionCodeSettings): Promise<string> {
    try {
      const user = await this.getUserByEmail(email);
      return admin.auth().generatePasswordResetLink(user.email ?? email, actionCodeSettings);
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === "auth/user-not-found") {
        throw new Error("No user found with this email address");
      }
      throw error;
    }
  }

  async sendPasswordResetEmail(email: string, actionCodeSettings: ActionCodeSettings): Promise<void> {
    try {
      await this.getUserByEmail(email);
      const apiKey = await getFirebaseApiKey();
      const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestType: "PASSWORD_RESET",
          email: email.trim().toLowerCase(),
          continueUrl: actionCodeSettings?.url,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
        const errorMessage = errorData.error?.message ?? "Failed to send password reset email";
        if (errorMessage.includes("USER_NOT_FOUND") || errorMessage.includes("user-not-found")) {
          throw new Error("No user found with this email address");
        }
        throw new Error(errorMessage);
      }
    } catch (error) {
      const err = error as { code?: string; message?: string };
      if (err.code === "auth/user-not-found" || err.message?.includes("user-not-found") || err.message?.includes("No user found")) {
        throw new Error("No user found with this email address");
      }
      throw error;
    }
  }

  async verifyPasswordResetCode(oobCode: string, newPassword: string): Promise<void> {
    const apiKey = await getFirebaseApiKey();
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oobCode, newPassword }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(errorData.error?.message ?? "Failed to reset password");
    }
  }

  async updateUserEmail(uid: string, newEmail: string): Promise<void> {
    try {
      await admin.auth().updateUser(uid, { email: newEmail });
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === "auth/email-already-exists") throw new Error("This email address is already in use");
      if (err.code === "auth/invalid-email") throw new Error("Invalid email address");
      throw error;
    }
  }

  async verifyPasswordForReauth(email: string, password: string, apiKey: string): Promise<PasswordSignInResponse> {
    return this.verifyPassword(email, password, apiKey);
  }
}

export default new AuthService();
