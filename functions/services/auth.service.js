const admin = require("firebase-admin");
const {getFirestore} = require("firebase-admin/firestore");

// Get database name based on project
function getDatabaseName() {
  // Ensure admin is initialized
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  
  const project = process.env.GCLOUD_PROJECT || 
                 (process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId : null);
  
  if (project === 'dev-danceup') {
    return 'development';
  } else if (project === 'staging-danceup') {
    return 'staging';
  } else if (project === 'production-danceup') {
    return 'production';
  }
  
  // Default fallback
  return '(default)';
}

// Initialize Firestore with the correct database name
const db = getFirestore(admin.app(), getDatabaseName());

/**
 * Service for authentication operations using Firebase Admin SDK
 */
class AuthService {
  /**
   * Create a new Firebase Auth user
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<admin.auth.UserRecord>}
   */
  async createUser(email, password) {
    try {
      const userRecord = await admin.auth().createUser({
        email: email.toLowerCase().trim(),
        password: password,
        emailVerified: false,
      });
      return userRecord;
    } catch (error) {
      console.error("Error creating user:", error);
      throw this.handleAuthError(error);
    }
  }

  /**
   * Get user by email
   * @param {string} email - User email
   * @returns {Promise<admin.auth.UserRecord>}
   */
  async getUserByEmail(email) {
    try {
      const userRecord = await admin.auth().getUserByEmail(
          email.toLowerCase().trim(),
      );
      return userRecord;
    } catch (error) {
      console.error("Error getting user by email:", error);
      throw this.handleAuthError(error);
    }
  }

  /**
   * Verify email and password using Firebase Auth REST API
   * @param {string} email - User email
   * @param {string} password - User password
   * @param {string} apiKey - Firebase Web API key
   * @returns {Promise<{idToken: string, localId: string}>}
   */
  async verifyPassword(email, password, apiKey) {
    try {
      const response = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email: email.toLowerCase().trim(),
              password: password,
              returnSecureToken: true,
            }),
          },
      );

      const data = await response.json();

      if (!response.ok) {
        if (data.error) {
          throw this.handleAuthError({
            code: data.error.message,
            message: data.error.message,
          });
        }
        throw new Error("Failed to verify password");
      }

      return {
        idToken: data.idToken,
        localId: data.localId,
      };
    } catch (error) {
      console.error("Error verifying password:", error);
      throw this.handleAuthError(error);
    }
  }

  /**
   * Generate a custom token for a user
   * @param {string} uid - User UID
   * @returns {Promise<string>}
   */
  async createCustomToken(uid) {
    try {
      // Ensure admin is initialized
      if (!admin.apps.length) {
        console.warn("Firebase Admin not initialized, initializing now...");
        admin.initializeApp();
      }

      // Log which service account is being used (for debugging)
      try {
        const app = admin.app();
        const projectId = app.options.projectId;
        console.log("Firebase Admin initialized with project:", projectId);
        
        // Try to get the service account email from the credentials
        if (app.options.credential) {
          // For service account credentials, try to extract the email
          console.log("Firebase Admin using explicit service account credentials");
          // Try to extract email if it's a cert credential
          if (app.options.credential.getAccessToken) {
            console.log("Using certificate-based credentials");
            // Try to get the service account email from the credential
            try {
              // For cert credentials, we can access the service account email
              if (app.options.credential.projectId) {
                // The credential object might have the email in its internal structure
                // We'll try to get it from the FIREBASE_SERVICE_ACCOUNT env var if available
                if (process.env.FIREBASE_SERVICE_ACCOUNT) {
                  try {
                    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                    console.log("Service account email:", sa.client_email);
                    console.log("This service account needs 'Service Account Token Creator' role on itself");
                    console.log("Grant the role to:", sa.client_email);
                  } catch (e) {
                    console.log("Could not parse service account from env var");
                  }
                }
              }
            } catch (e) {
              console.log("Could not extract service account email from credentials");
            }
          }
        } else {
          console.log("Firebase Admin using Application Default Credentials (ADC)");
          // In Cloud Functions, this means it's using the function's service account
          // For 2nd gen functions, this is typically: <project-id>@appspot.gserviceaccount.com
          const functionServiceAccount = `${projectId}@appspot.gserviceaccount.com`;
          console.log("Function service account (likely):", functionServiceAccount);
          console.log("This service account needs 'Service Account Token Creator' role on itself");
          console.log("Grant the role to:", functionServiceAccount);
        }
      } catch (logError) {
        console.warn("Could not log service account info:", logError.message);
      }

      // Validate UID
      if (!uid || typeof uid !== 'string' || uid.trim() === '') {
        throw new Error("Invalid UID provided for token creation");
      }

      // Verify user exists before creating token
      let userRecord;
      try {
        userRecord = await admin.auth().getUser(uid);
        console.log("User verified for token creation:", {
          uid: userRecord.uid,
          email: userRecord.email,
        });
      } catch (getUserError) {
        console.error("User does not exist when creating custom token:", {
          uid,
          error: getUserError.message,
          code: getUserError.code,
        });
        throw new Error(`User with UID ${uid} does not exist`);
      }

      // Create custom token
      const customToken = await admin.auth().createCustomToken(uid);
      console.log("Custom token created successfully for user:", uid);
      return customToken;
    } catch (error) {
      console.error("Error creating custom token:", {
        uid,
        error: error.message,
        code: error.code,
        stack: error.stack,
        adminInitialized: admin.apps.length > 0,
      });
      
      // Preserve original error message if it's already user-friendly
      if (error.message && !error.message.includes("Failed to create authentication token")) {
        throw error;
      }
      
      throw new Error(`Failed to create authentication token: ${error.message || error.code || 'Unknown error'}`);
    }
  }

  /**
   * Get user document from Firestore by authUid
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<FirebaseFirestore.DocumentSnapshot>}
   */
  async getUserDocumentByAuthUid(authUid) {
    try {
      const usersRef = db.collection("users");
      const snapshot = await usersRef
          .where("authUid", "==", authUid)
          .limit(1)
          .get();

      if (snapshot.empty) {
        return null;
      }

      return snapshot.docs[0];
    } catch (error) {
      console.error("Error getting user document:", error);
      throw new Error("Failed to retrieve user data");
    }
  }

  /**
   * Create user document in Firestore
   * @param {string} authUid - Firebase Auth UID
   * @param {Object} userData - User data to store
   * @returns {Promise<string>} Document ID
   */
  async createUserDocument(authUid, userData) {
    try {
      const usersRef = db.collection("users");
      const docRef = await usersRef.add({
        ...userData,
        authUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return docRef.id;
    } catch (error) {
      console.error("Error creating user document:", error);
      throw new Error("Failed to create user profile");
    }
  }

  /**
   * Verify user has studio_owner role
   * @param {FirebaseFirestore.DocumentSnapshot} userDoc - User document
   * @returns {boolean}
   */
  hasStudioOwnerRole(userDoc) {
    if (!userDoc || !userDoc.exists) {
      return false;
    }

    const data = userDoc.data();
    const roles = data.roles || [];
    return roles.includes("studio_owner");
  }

  /**
   * Delete a Firebase Auth user
   * @param {string} uid - User UID
   * @returns {Promise<void>}
   */
  async deleteUser(uid) {
    try {
      await admin.auth().deleteUser(uid);
    } catch (error) {
      console.error("Error deleting user:", error);
      // Don't throw - this is usually called in cleanup
    }
  }

  /**
   * Handle Firebase Auth errors and convert to user-friendly messages
   * @param {Error} error - Firebase error
   * @returns {Error}
   */
  handleAuthError(error) {
    if (error.code === "auth/email-already-exists") {
      return new Error("An account with this email already exists");
    }
    if (error.code === "auth/invalid-email") {
      return new Error("Invalid email address");
    }
    if (error.code === "auth/weak-password") {
      return new Error("Password is too weak");
    }
    if (error.code === "auth/user-not-found") {
      return new Error("No account found with this email");
    }
    if (error.code === "auth/wrong-password") {
      return new Error("Incorrect password");
    }
    if (error.code === "auth/invalid-credential") {
      return new Error("Invalid email or password");
    }

    return new Error(error.message || "Authentication failed");
  }
}

module.exports = new AuthService();

