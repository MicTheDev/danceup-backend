/**
 * Script to find student document from user document ID
 * Usage: GCLOUD_PROJECT=dev-danceup node scripts/find-student-from-user-id.js
 */

const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  const projectId = process.env.GCLOUD_PROJECT || "dev-danceup";
  process.env.GCLOUD_PROJECT = projectId;
  
  admin.initializeApp({
    projectId: projectId,
  });
}

const USER_DOC_ID = "fzPZ4xcGZ41bLkpUE4Ta";
const STUDIO_OWNER_DOC_ID = "RGg6m2dDrRX23NcfAudn";

async function main() {
  try {
    const db = getFirestore();
    
    console.log("Checking user document...");
    const userDoc = await db.collection("usersStudentProfiles").doc(USER_DOC_ID).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      console.log("Found user in usersStudentProfiles:");
      console.log("  Email:", userData.email);
      console.log("  AuthUid:", userData.authUid);
      console.log("  Name:", userData.firstName, userData.lastName);
      
      // Find student document by authUid and studioOwnerId
      if (userData.authUid) {
        console.log("\nSearching for student document with authUid:", userData.authUid);
        const studentsRef = db.collection("students");
        const snapshot = await studentsRef
            .where("authUid", "==", userData.authUid)
            .where("studioOwnerId", "==", STUDIO_OWNER_DOC_ID)
            .limit(1)
            .get();
        
        if (!snapshot.empty) {
          const studentDoc = snapshot.docs[0];
          console.log("\n✅ Found student document:");
          console.log("  Student Document ID:", studentDoc.id);
          console.log("  Student Data:", JSON.stringify(studentDoc.data(), null, 2));
        } else {
          console.log("\n❌ No student document found for this authUid and studioOwnerId");
          console.log("Checking all students for this authUid...");
          const allStudentsSnapshot = await studentsRef
              .where("authUid", "==", userData.authUid)
              .get();
          
          if (!allStudentsSnapshot.empty) {
            console.log(`Found ${allStudentsSnapshot.size} student document(s):`);
            allStudentsSnapshot.docs.forEach((doc) => {
              const data = doc.data();
              console.log(`  - Student ID: ${doc.id}, Studio Owner ID: ${data.studioOwnerId}`);
            });
          } else {
            console.log("No student documents found for this authUid at all.");
          }
        }
      }
    } else {
      console.log("User document not found in usersStudentProfiles");
      
      // Try students collection directly
      console.log("\nChecking students collection directly...");
      const studentDoc = await db.collection("students").doc(USER_DOC_ID).get();
      if (studentDoc.exists) {
        const studentData = studentDoc.data();
        console.log("✅ Found student document directly:");
        console.log("  Student Document ID:", USER_DOC_ID);
        console.log("  Student Data:", JSON.stringify(studentData, null, 2));
        console.log("  Studio Owner ID:", studentData.studioOwnerId);
        
        if (studentData.studioOwnerId !== STUDIO_OWNER_DOC_ID) {
          console.log("\n⚠️  WARNING: Student's studioOwnerId doesn't match provided studio owner ID");
          console.log("  Student's studioOwnerId:", studentData.studioOwnerId);
          console.log("  Provided studioOwnerId:", STUDIO_OWNER_DOC_ID);
        }
      } else {
        console.log("Document not found in students collection either");
      }
    }
    
    // Also check the studio owner
    console.log("\n\nChecking studio owner document...");
    const studioOwnerDoc = await db.collection("users").doc(STUDIO_OWNER_DOC_ID).get();
    if (studioOwnerDoc.exists) {
      const studioOwnerData = studioOwnerDoc.data();
      console.log("✅ Found studio owner:");
      console.log("  Studio Owner ID:", STUDIO_OWNER_DOC_ID);
      console.log("  Email:", studioOwnerData.email);
      console.log("  Studio Name:", studioOwnerData.profile?.studioName || "N/A");
    } else {
      console.log("❌ Studio owner document not found");
    }
    
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();

