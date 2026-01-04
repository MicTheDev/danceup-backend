/**
 * Script to create attendance data using document IDs directly
 * Usage: GCLOUD_PROJECT=dev-danceup node scripts/create-attendance-with-doc-ids.js
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

// Use document IDs directly
// Note: fzPZ4xcGZ41bLkpUE4Ta is the user profile ID, the actual student document ID is ml0PYNNI1hjlacLsUP4f
const STUDENT_DOC_ID = "ml0PYNNI1hjlacLsUP4f"; // Found by looking up authUid from user profile fzPZ4xcGZ41bLkpUE4Ta
const STUDIO_OWNER_DOC_ID = "RGg6m2dDrRX23NcfAudn";

/**
 * Verify student document exists and belongs to studio owner
 */
async function verifyStudent(studentId, studioOwnerId) {
  const db = getFirestore();
  const studentDoc = await db.collection("students").doc(studentId).get();
  
  if (!studentDoc.exists) {
    throw new Error(`Student document ${studentId} not found`);
  }
  
  const studentData = studentDoc.data();
  if (studentData.studioOwnerId !== studioOwnerId) {
    throw new Error(`Student ${studentId} does not belong to studio owner ${studioOwnerId}. Student's studioOwnerId: ${studentData.studioOwnerId}`);
  }
  
  console.log(`✓ Verified student: ${studentData.firstName} ${studentData.lastName} (${studentData.email || 'no email'})`);
  return studentData;
}

/**
 * Verify studio owner document exists
 */
async function verifyStudioOwner(studioOwnerId) {
  const db = getFirestore();
  const studioOwnerDoc = await db.collection("users").doc(studioOwnerId).get();
  
  if (!studioOwnerDoc.exists) {
    throw new Error(`Studio owner document ${studioOwnerId} not found`);
  }
  
  const studioOwnerData = studioOwnerDoc.data();
  console.log(`✓ Verified studio owner: ${studioOwnerData.profile?.studioName || studioOwnerData.email || 'Unknown'}`);
  return studioOwnerData;
}

/**
 * Get classes for a studio owner
 */
async function getClassesForStudio(studioOwnerId) {
  const db = getFirestore();
  const classesRef = db.collection("classes");
  const snapshot = await classesRef
      .where("studioOwnerId", "==", studioOwnerId)
      .where("isActive", "==", true)
      .get();

  const classes = [];
  snapshot.forEach((doc) => {
    classes.push({
      id: doc.id,
      ...doc.data(),
    });
  });

  return classes;
}

/**
 * Create attendance record
 */
async function createAttendanceRecord(data) {
  const db = getFirestore();
  const attendanceRef = db.collection("attendance");
  
  const attendanceDoc = {
    studentId: data.studentId,
    classId: data.classId,
    classInstanceDate: admin.firestore.Timestamp.fromDate(data.classInstanceDate),
    checkedInBy: data.checkedInBy,
    checkedInById: data.checkedInById,
    checkedInAt: admin.firestore.Timestamp.fromDate(data.checkedInAt),
    studioOwnerId: data.studioOwnerId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = await attendanceRef.add(attendanceDoc);
  return docRef.id;
}

/**
 * Generate test dates for 2 months (past dates for history)
 */
function generateTestDates(classes) {
  const dates = [];
  const now = new Date();
  
  // Go back 2 months (approximately 8-9 weeks)
  const weeksBack = 9;
  const classesPerWeek = 2; // Assume 2 classes per week on average
  
  // Generate dates going back in time
  for (let week = 0; week < weeksBack; week++) {
    for (let classInWeek = 0; classInWeek < classesPerWeek; classInWeek++) {
      const date = new Date(now);
      // Go back by weeks, and add some variation within the week
      const daysBack = (week * 7) + (classInWeek * 3); // 3 days apart within the week
      date.setDate(date.getDate() - daysBack);
      
      // Set time based on class schedule (if available) or default to evening
      const hour = classInWeek % 2 === 0 ? 18 : 19; // Alternate between 6 PM and 7 PM
      date.setHours(hour, 0, 0, 0);
      
      dates.push(date);
    }
  }
  
  // Sort dates (oldest first)
  dates.sort((a, b) => a.getTime() - b.getTime());
  
  return dates;
}

/**
 * Delete existing attendance records for this student and studio owner
 */
async function deleteExistingAttendance(studentId, studioOwnerId) {
  const db = getFirestore();
  const attendanceRef = db.collection("attendance");
  const snapshot = await attendanceRef
      .where("studentId", "==", studentId)
      .where("studioOwnerId", "==", studioOwnerId)
      .get();

  if (snapshot.empty) {
    console.log("No existing attendance records found to delete.");
    return 0;
  }

  console.log(`Found ${snapshot.size} existing attendance records. Deleting...`);
  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();
  console.log(`✓ Deleted ${snapshot.size} existing attendance records.`);
  return snapshot.size;
}

/**
 * Main function
 */
async function main() {
  try {
    console.log("Creating attendance data using document IDs...");
    console.log(`Student Document ID: ${STUDENT_DOC_ID}`);
    console.log(`Studio Owner Document ID: ${STUDIO_OWNER_DOC_ID}`);
    console.log("");
    
    // Verify documents exist
    console.log("Verifying documents...");
    const studentData = await verifyStudent(STUDENT_DOC_ID, STUDIO_OWNER_DOC_ID);
    await verifyStudioOwner(STUDIO_OWNER_DOC_ID);
    console.log("");
    
    // Delete existing attendance records for this student/studio combination
    console.log("Cleaning up existing attendance records...");
    await deleteExistingAttendance(STUDENT_DOC_ID, STUDIO_OWNER_DOC_ID);
    console.log("");
    
    // Get classes for the studio
    console.log(`Fetching classes for studio owner: ${STUDIO_OWNER_DOC_ID}`);
    const classes = await getClassesForStudio(STUDIO_OWNER_DOC_ID);
    if (classes.length === 0) {
      throw new Error("No active classes found for this studio. Please create classes first.");
    }
    console.log(`Found ${classes.length} active classes:`, classes.map(c => c.name).join(", "));
    console.log("");
    
    // Generate test dates for 2 months
    const testDates = generateTestDates(classes);
    console.log(`Generating ${testDates.length} attendance records over 2 months...`);
    console.log("");
    
    // Create attendance records
    const createdIds = [];
    let classIndex = 0;
    
    for (let i = 0; i < testDates.length; i++) {
      const classData = classes[classIndex % classes.length];
      const classDate = testDates[i];
      
      // Check-in time is typically a few minutes before or at class start
      const checkedInAt = new Date(classDate);
      const minutesOffset = Math.floor(Math.random() * 10) - 5; // -5 to +5 minutes
      checkedInAt.setMinutes(checkedInAt.getMinutes() + minutesOffset);
      
      // Alternate between studio and student check-ins (70% studio, 30% student)
      const checkedInBy = Math.random() < 0.7 ? "studio" : "student";
      
      const attendanceData = {
        studentId: STUDENT_DOC_ID,
        classId: classData.id,
        classInstanceDate: classDate,
        checkedInBy: checkedInBy,
        checkedInById: checkedInBy === "studio" ? STUDIO_OWNER_DOC_ID : STUDENT_DOC_ID,
        checkedInAt: checkedInAt,
        studioOwnerId: STUDIO_OWNER_DOC_ID,
      };
      
      const attendanceId = await createAttendanceRecord(attendanceData);
      createdIds.push(attendanceId);
      
      const dateStr = classDate.toLocaleDateString('en-US', { 
        weekday: 'short', 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      console.log(`[${i + 1}/${testDates.length}] Created: ${attendanceId} | Class: "${classData.name}" | Date: ${dateStr} | Check-in: ${checkedInBy}`);
      
      classIndex++;
      
      // Small delay to avoid overwhelming Firestore
      if (i < testDates.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log("");
    console.log("✅ Successfully created test attendance data!");
    console.log(`Total records created: ${createdIds.length}`);
    console.log(`Student Document ID: ${STUDENT_DOC_ID}`);
    console.log(`Studio Owner Document ID: ${STUDIO_OWNER_DOC_ID}`);
    console.log(`Student Name: ${studentData.firstName} ${studentData.lastName}`);
    console.log(`Student Email: ${studentData.email || 'N/A'}`);
    console.log("");
    console.log("Attendance Record IDs:");
    createdIds.forEach((id, index) => {
      console.log(`  ${index + 1}. ${id}`);
    });
    
    process.exit(0);
  } catch (error) {
    console.error("");
    console.error("❌ Error creating test attendance data:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();

