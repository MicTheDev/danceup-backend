const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling authentication and user management operations
 */
class AuthService {
  /**
   * Create a new Firebase Auth user
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<admin.auth.UserRecord>}
   */
  async createUser(email, password) {
    return admin.auth().createUser({
      email,
      password,
    });
  }

  /**
   * Delete a Firebase Auth user
   * @param {string} uid - User UID
   * @returns {Promise<void>}
   */
  async deleteUser(uid) {
    return admin.auth().deleteUser(uid);
  }

  /**
   * Get user by email
   * @param {string} email - User email
   * @returns {Promise<admin.auth.UserRecord>}
   */
  async getUserByEmail(email) {
    return admin.auth().getUserByEmail(email);
  }

  /**
   * Create a custom token for a user
   * @param {string} uid - User UID
   * @returns {Promise<string>}
   */
  async createCustomToken(uid) {
    return admin.auth().createCustomToken(uid);
  }

  /**
   * Verify password using Firebase Auth REST API
   * @param {string} email - User email
   * @param {string} password - User password
   * @param {string} apiKey - Firebase Web API key
   * @returns {Promise<Object>}
   */
  async verifyPassword(email, password, apiKey) {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to verify password');
    }

    return response.json();
  }

  /**
   * Exchange custom token for ID token using Firebase Auth REST API
   * @param {string} customToken - Custom token to exchange
   * @param {string} apiKey - Firebase Web API key
   * @returns {Promise<Object>} Object containing idToken, refreshToken, and expiresIn
   */
  async exchangeCustomTokenForIdToken(customToken, apiKey) {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: customToken,
        returnSecureToken: true,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to exchange custom token');
    }

    return response.json();
  }

  /**
   * Create user document in Firestore
   * @param {string} authUid - Firebase Auth UID
   * @param {Object} userData - User data to store
   * @returns {Promise<string>} Document ID
   */
  async createUserDocument(authUid, userData) {
    const db = getFirestore();
    const userDataWithAuthUid = {
      ...userData,
      authUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("users").add(userDataWithAuthUid);
    return docRef.id;
  }

  /**
   * Get user document from Firestore by auth UID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<admin.firestore.DocumentSnapshot | null>}
   */
  async getUserDocumentByAuthUid(authUid) {
    const db = getFirestore();
    const usersRef = db.collection("users");
    const snapshot = await usersRef
        .where("authUid", "==", authUid)
        .limit(1)
        .get();

    if (snapshot.empty) {
      return null;
    }

    return snapshot.docs[0];
  }

  /**
   * Check if user document has studio_owner role
   * @param {admin.firestore.DocumentSnapshot} userDoc - User document snapshot
   * @returns {boolean}
   */
  hasStudioOwnerRole(userDoc) {
    if (!userDoc || !userDoc.exists) {
      return false;
    }

    const userData = userDoc.data();
    const roles = userData.roles || [];
    return roles.includes("studio_owner");
  }

  /**
   * Create student profile document in Firestore
   * @param {string} authUid - Firebase Auth UID
   * @param {Object} userData - Student profile data to store
   * @returns {Promise<string>} Document ID
   */
  async createStudentProfileDocument(authUid, userData) {
    const db = getFirestore();
    const userDataWithAuthUid = {
      ...userData,
      authUid,
      role: "student",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("usersStudentProfiles").add(userDataWithAuthUid);
    return docRef.id;
  }

  /**
   * Get student profile document from Firestore by auth UID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<admin.firestore.DocumentSnapshot | null>}
   */
  async getStudentProfileByAuthUid(authUid) {
    const db = getFirestore();
    const studentsRef = db.collection("usersStudentProfiles");
    const snapshot = await studentsRef
        .where("authUid", "==", authUid)
        .limit(1)
        .get();

    if (snapshot.empty) {
      return null;
    }

    return snapshot.docs[0];
  }

  /**
   * Generate password reset link using Firebase Admin SDK
   * @param {string} email - User email
   * @param {string} actionCodeSettings - Action code settings for the reset link
   * @returns {Promise<string>} Password reset link
   */
  async generatePasswordResetLink(email, actionCodeSettings) {
    try {
      const user = await this.getUserByEmail(email);
      const link = await admin.auth().generatePasswordResetLink(
          user.email,
          actionCodeSettings,
      );
      return link;
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        throw new Error('No user found with this email address');
      }
      throw error;
    }
  }

  /**
   * Send password reset email using Firebase REST API
   * @param {string} email - User email
   * @param {Object} actionCodeSettings - Action code settings for the reset link
   * @returns {Promise<void>}
   */
  async sendPasswordResetEmail(email, actionCodeSettings) {
    try {
      // Verify user exists
      await this.getUserByEmail(email);

      // Use Firebase REST API to send password reset email
      const apiKey = process.env.FIREBASE_WEB_API_KEY;
      if (!apiKey) {
        throw new Error('FIREBASE_WEB_API_KEY not configured');
      }

      const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestType: 'PASSWORD_RESET',
          email: email.trim().toLowerCase(),
          continueUrl: actionCodeSettings?.url,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || 'Failed to send password reset email';
        if (errorMessage.includes('USER_NOT_FOUND') || errorMessage.includes('user-not-found')) {
          throw new Error('No user found with this email address');
        }
        throw new Error(errorMessage);
      }
    } catch (error) {
      if (error.code === 'auth/user-not-found' || error.message?.includes('user-not-found') || error.message?.includes('No user found')) {
        throw new Error('No user found with this email address');
      }
      throw error;
    }
  }

  /**
   * Verify password reset code and update password
   * @param {string} oobCode - Password reset code from email
   * @param {string} newPassword - New password
   * @returns {Promise<void>}
   */
  async verifyPasswordResetCode(oobCode, newPassword) {
    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!apiKey) {
      throw new Error('FIREBASE_WEB_API_KEY not configured');
    }

    const url = `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oobCode,
        newPassword,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to reset password');
    }
  }

  /**
   * Update user email address
   * @param {string} uid - User UID
   * @param {string} newEmail - New email address
   * @returns {Promise<void>}
   */
  async updateUserEmail(uid, newEmail) {
    try {
      await admin.auth().updateUser(uid, {
        email: newEmail,
      });
    } catch (error) {
      if (error.code === 'auth/email-already-exists') {
        throw new Error('This email address is already in use');
      }
      if (error.code === 'auth/invalid-email') {
        throw new Error('Invalid email address');
      }
      throw error;
    }
  }

  /**
   * Verify user password for re-authentication
   * @param {string} email - User email
   * @param {string} password - User password
   * @param {string} apiKey - Firebase Web API key
   * @returns {Promise<Object>} User credentials
   */
  async verifyPasswordForReauth(email, password, apiKey) {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to verify password');
    }

    return response.json();
  }
}

module.exports = new AuthService();
