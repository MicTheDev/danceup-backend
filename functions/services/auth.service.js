const admin = require("firebase-admin");

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
    const axios = require("axios");
    const response = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
        {
          email,
          password,
          returnSecureToken: true,
        },
    );
    return response.data;
  }

  /**
   * Create user document in Firestore
   * @param {string} authUid - Firebase Auth UID
   * @param {Object} userData - User data to store
   * @returns {Promise<string>} Document ID
   */
  async createUserDocument(authUid, userData) {
    const db = admin.firestore();
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
    const db = admin.firestore();
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
}

module.exports = new AuthService();
