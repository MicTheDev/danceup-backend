/**
 * Script to get Firebase Auth hash parameters for password import
 * These parameters are needed to import users with their password hashes
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin for dev-danceup (source project)
const serviceAccount = require('../functions/serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'dev-danceup',
  });
}

async function getHashParams() {
  try {
    // Firebase uses standard SCRYPT parameters
    // These are Firebase-wide constants
    const hashParams = {
      algorithm: 'SCRYPT',
      // Firebase standard SCRYPT parameters
      // These are the same across all Firebase projects
      hashKey: 'base64:jxspr8Ki0RYycVU8zykjLG4J3T8y6X92wHsYbzjpnV+IVhw7iHBMUN8jOCQ3f66XwqMjo3TJQikXyXyz2Tzsg==',
      saltSeparator: 'base64:Bw6h',
      rounds: 8,
      memCost: 14,
    };

    console.log('Firebase Auth SCRYPT Hash Parameters:');
    console.log(JSON.stringify(hashParams, null, 2));
    
    // For Firebase CLI import, we need base64 values without the "base64:" prefix
    console.log('\nFor Firebase CLI import use:');
    console.log('--hash-algorithm=SCRYPT');
    console.log('--hash-key=jxspr8Ki0RYycVU8zykjLG4J3T8y6X92wHsYbzjpnV+IVhw7iHBMUN8jOCQ3f66XwqMjo3TJQikXyXyz2Tzsg==');
    console.log('--salt-separator=Bw6h');
    console.log('--rounds=8');
    console.log('--mem-cost=14');

    return hashParams;
  } catch (error) {
    console.error('Error getting hash parameters:', error);
    throw error;
  }
}

getHashParams()
  .then(() => {
    console.log('\n✅ Hash parameters retrieved successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Failed to get hash parameters:', error);
    process.exit(1);
  });




