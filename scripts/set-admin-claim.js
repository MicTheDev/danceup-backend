/**
 * One-time script to grant the superAdmin custom claim to the DanceUp admin account.
 *
 * Usage:
 *   node scripts/set-admin-claim.js <admin-uid>
 *
 * To find the UID: Firebase Console → Authentication → Users → search info@danceup.app → copy the UID
 *
 * After running, the admin must sign out and sign back in so their ID token refreshes
 * and picks up the new claim. Custom claims propagate on the next token refresh (≤1 hour).
 */

const admin = require("firebase-admin");
const serviceAccount = require("./service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uid = process.argv[2];

if (!uid) {
  console.error("Usage: node set-admin-claim.js <admin-uid>");
  process.exit(1);
}

admin.auth().setCustomUserClaims(uid, { superAdmin: true })
  .then(() => {
    console.log(`superAdmin claim set for UID: ${uid}`);
    console.log("The admin must sign out and back in for the new claim to take effect.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed to set custom claim:", err.message);
    process.exit(1);
  });
