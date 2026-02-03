/**
 * Script to create test attendance data
 * Usage: node create-test-attendance.js
 * 
 * This script creates attendance records for:
 * - Student authUid: STNj2HaOM0WKOwlPAOUKW6xwFFg2
 * - Studio Owner authUid: CHCwzb2AOSQhFi9gMhotGdEIJ7m2
 */

const admin = require("firebase-admin");
const {getFirestore} = require("../utils/firestore");

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  // Set project ID from environment or default
  const projectId = process.env.GCLOUD_PROJECT || "dev-danceup";
  process.env.GCLOUD_PROJECT = projectId;
  
  admin.initializeApp({
    projectId: projectId,
  });
}

const STUDENT_AUTH_UID = "STNj2HaOM0WKOwlPAOUKW6xwFFg2";
const STUDIO_OWNER_AUTH_UID = "CHCwzb2AOSQhFi9gMhotGdEIJ7m2";

/**
 * Get student document ID from authUid
 */
async function getStudentIdByAuthUid(authUid) {
  const db = getFirestore();
  const studentsRef = db.collection("students");
  const snapshot = await studentsRef
      .where("authUid", "==", authUid)
      .limit(1)
      .get();

  if (snapshot.empty) {
    return null;
  }

  return snapshot.docs[0].id;
}

/**
 * Get studio owner document ID from authUid
 */
async function getStudioOwnerIdByAuthUid(authUid) {
  const db = getFirestore();
  const usersRef = db.collection("users");
  const snapshot = await usersRef
      .where("authUid", "==", authUid)
      .limit(1)
      .get();

  if (snapshot.empty) {
    return null;
  }

  return snapshot.docs[0].id;
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
 * Creates attendance records spread over the past 2 months
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
      // For now, use evening times (6 PM or 7 PM)
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
 * Main function
 */
async function main() {
  try {
    console.log("Starting test attendance data creation...");
    
    // Get student document ID
    console.log(`Finding student with authUid: ${STUDENT_AUTH_UID}`);
    const studentId = await getStudentIdByAuthUid(STUDENT_AUTH_UID);
    if (!studentId) {
      throw new Error(`Student not found with authUid: ${STUDENT_AUTH_UID}`);
    }
    console.log(`Found student document ID: ${studentId}`);
    
    // Get studio owner document ID
    console.log(`Finding studio owner with authUid: ${STUDIO_OWNER_AUTH_UID}`);
    const studioOwnerId = await getStudioOwnerIdByAuthUid(STUDIO_OWNER_AUTH_UID);
    if (!studioOwnerId) {
      throw new Error(`Studio owner not found with authUid: ${STUDIO_OWNER_AUTH_UID}`);
    }
    console.log(`Found studio owner document ID: ${studioOwnerId}`);
    
    // Get classes for the studio
    console.log("Fetching classes for studio...");
    const classes = await getClassesForStudio(studioOwnerId);
    if (classes.length === 0) {
      throw new Error("No active classes found for this studio. Please create classes first.");
    }
    console.log(`Found ${classes.length} active classes`);
    
    // Generate test dates for 2 months
    const testDates = generateTestDates(classes);
    console.log(`Generating ${testDates.length} attendance records over 2 months...`);
    
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
        studentId: studentId,
        classId: classData.id,
        classInstanceDate: classDate,
        checkedInBy: checkedInBy,
        checkedInById: checkedInBy === "studio" ? studioOwnerId : studentId,
        checkedInAt: checkedInAt,
        studioOwnerId: studioOwnerId,
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
      console.log(`Created attendance record ${i + 1}/${testDates.length}: ${attendanceId} for class "${classData.name}" on ${dateStr} (${checkedInBy} check-in)`);
      
      classIndex++;
      
      // Small delay to avoid overwhelming Firestore
      if (i < testDates.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log("\n✅ Successfully created test attendance data!");
    console.log(`Total records created: ${createdIds.length}`);
    console.log(`Student ID: ${studentId}`);
    console.log(`Studio Owner ID: ${studioOwnerId}`);
    console.log(`Attendance Record IDs: ${createdIds.join(", ")}`);
    
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating test attendance data:", error);
    process.exit(1);
  }
}

// Run the script
main();

