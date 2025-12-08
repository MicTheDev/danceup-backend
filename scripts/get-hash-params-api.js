/**
 * Script to get Firebase Auth hash parameters using Identity Platform API
 * Run: node scripts/get-hash-params-api.js
 */

const { execSync } = require('child_process');

async function getHashParams() {
  try {
    console.log('Getting hash parameters from Firebase Console...');
    console.log('\nPlease follow these steps:');
    console.log('1. Go to: https://console.firebase.google.com/project/dev-danceup/authentication/users');
    console.log('2. Click the three-dot menu (⋮) above the user list');
    console.log('3. Select "Password Hash Parameters"');
    console.log('4. Copy the following values:');
    console.log('   - Base64 signer key');
    console.log('   - Base64 salt separator');
    console.log('   - Rounds (usually 8)');
    console.log('   - Memory cost (usually 14)');
    console.log('\nThen use them in the import command:');
    console.log('firebase auth:import auth-export/users.json \\');
    console.log('  --project staging-danceup \\');
    console.log('  --hash-algo=SCRYPT \\');
    console.log('  --hash-key=<YOUR_BASE64_SIGNER_KEY> \\');
    console.log('  --salt-separator=<YOUR_BASE64_SALT_SEPARATOR> \\');
    console.log('  --rounds=8 \\');
    console.log('  --mem-cost=14');
  } catch (error) {
    console.error('Error:', error);
  }
}

getHashParams();



