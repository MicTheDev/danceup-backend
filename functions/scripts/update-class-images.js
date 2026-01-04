const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");

/**
 * Script to update all existing classes with their studio's image or placeholder
 * Run this script to backfill imageUrl for existing classes
 */
async function updateClassImages() {
  const db = getFirestore();
  const classesRef = db.collection("classes");
  
  // Get all classes
  const classesSnapshot = await classesRef.get();
  
  if (classesSnapshot.empty) {
    console.log("No classes found to update.");
    return;
  }
  
  console.log(`Found ${classesSnapshot.size} classes to update.`);
  
  // Get unique studio owner IDs
  const studioOwnerIds = new Set();
  classesSnapshot.forEach((doc) => {
    const classData = doc.data();
    if (classData.studioOwnerId) {
      studioOwnerIds.add(classData.studioOwnerId);
    }
  });
  
  console.log(`Found ${studioOwnerIds.size} unique studio owners.`);
  
  // Fetch all studio owner documents
  const studioOwnersMap = new Map();
  const studioOwnersRef = db.collection("users");
  const studioOwnerIdsArray = Array.from(studioOwnerIds);
  
  // Batch queries if more than 10 studio owners (Firestore 'in' limit)
  const batchSize = 10;
  for (let i = 0; i < studioOwnerIdsArray.length; i += batchSize) {
    const batch = studioOwnerIdsArray.slice(i, i + batchSize);
    const studioOwnersSnapshot = await studioOwnersRef
        .where(admin.firestore.FieldPath.documentId(), "in", batch)
        .get();

    studioOwnersSnapshot.forEach((doc) => {
      studioOwnersMap.set(doc.id, doc.data());
    });
  }
  
  // Placeholder image
  const placeholderImage = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiM2MzY2ZjEiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNlYzQ4OTkiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2EpIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIyNCIgZmlsbD0id2hpdGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5TdHVkaW88L3RleHQ+PC9zdmc+";
  
  // Update each class
  let updatedCount = 0;
  const maxBatchSize = 500; // Firestore batch limit
  let batch = db.batch();
  let batchCount = 0;
  
  for (const doc of classesSnapshot.docs) {
    const classData = doc.data();
    const studioOwnerId = classData.studioOwnerId;
    
    // Skip if already has imageUrl
    if (classData.imageUrl) {
      continue;
    }
    
    // Get studio owner data
    const studioOwner = studioOwnersMap.get(studioOwnerId);
    let imageUrl = placeholderImage; // Default to placeholder
    
    if (studioOwner) {
      // Use studio's image if available, otherwise use placeholder
      imageUrl = studioOwner.studioImageUrl || placeholderImage;
    }
    
    // Update the class with imageUrl
    const classRef = classesRef.doc(doc.id);
    batch.update(classRef, {
      imageUrl: imageUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    batchCount++;
    updatedCount++;
    
    // Commit batch if it reaches the limit
    if (batchCount >= maxBatchSize) {
      await batch.commit();
      batch = db.batch(); // Create new batch
      batchCount = 0;
      console.log(`Committed batch. Updated ${updatedCount} classes so far...`);
    }
  }
  
  // Commit remaining updates
  if (batchCount > 0) {
    await batch.commit();
    console.log(`Committed final batch.`);
  }
  
  console.log(`Successfully updated ${updatedCount} classes with imageUrl.`);
}

// Run the script if called directly
if (require.main === module) {
  // Initialize Firebase Admin if not already initialized
  if (!admin.apps.length) {
    // Try to get project ID from environment or default to dev-danceup
    const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "dev-danceup";
    admin.initializeApp({
      projectId: projectId,
    });
  }
  
  updateClassImages()
      .then(() => {
        console.log("Script completed successfully.");
        process.exit(0);
      })
      .catch((error) => {
        console.error("Error running script:", error);
        process.exit(1);
      });
}

module.exports = {updateClassImages};
