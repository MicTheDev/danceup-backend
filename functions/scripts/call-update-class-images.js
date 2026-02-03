const admin = require("firebase-admin");

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

// Get the function URL
const projectId = "dev-danceup";
const region = "us-central1";
const functionName = "updateClassImages";
const functionUrl = `https://${region}-${projectId}.cloudfunctions.net/${functionName}`;

async function callUpdateClassImages() {
  try {
    // Create a custom token for authentication
    // Note: You'll need to use a service account or authenticated user
    // For now, let's try calling it directly via HTTP
    const https = require("https");
    const url = require("url");
    
    console.log(`Calling function at: ${functionUrl}`);
    
    // Since this is a callable function, we need to authenticate
    // Let's use the Firebase Admin SDK to get an ID token
    // For now, let's just run the script directly instead
    console.log("Note: Callable functions require authentication.");
    console.log("Running the update script directly instead...");
    
    // Import and run the update script directly
    const {updateClassImages} = require("./update-class-images");
    await updateClassImages();
    
    console.log("Script completed successfully!");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

callUpdateClassImages();

