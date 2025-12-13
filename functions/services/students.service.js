const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling student management operations
 */
class StudentsService {
  /**
   * Get studio owner ID from Firebase Auth UID
   * @param {string} authUid - Firebase Auth UID
   * @returns {Promise<string | null>} Studio owner document ID
   */
  async getStudioOwnerId(authUid) {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) {
      return null;
    }
    return userDoc.id;
  }

  /**
   * Get all students for a studio owner
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Array>} Array of students
   */
  async getStudents(studioOwnerId) {
    const db = getFirestore();
    const studentsRef = db.collection("students");
    const snapshot = await studentsRef
        .where("studioOwnerId", "==", studioOwnerId)
        .get();

    const students = [];
    snapshot.forEach((doc) => {
      students.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return students;
  }

  /**
   * Get a single student by ID
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<Object | null>} Student data or null if not found
   */
  async getStudentById(studentId, studioOwnerId) {
    const db = getFirestore();
    const studentRef = db.collection("students").doc(studentId);
    const doc = await studentRef.get();

    if (!doc.exists) {
      return null;
    }

    const studentData = doc.data();
    if (studentData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }

    return {
      id: doc.id,
      ...studentData,
    };
  }

  /**
   * Create a new student
   * @param {Object} studentData - Student data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<string>} Created student document ID
   */
  async createStudent(studentData, studioOwnerId) {
    const db = getFirestore();
    const studentDataWithMetadata = {
      ...studentData,
      studioOwnerId,
      credits: studentData.credits || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("students").add(studentDataWithMetadata);
    return docRef.id;
  }

  /**
   * Update an existing student
   * @param {string} studentId - Student document ID
   * @param {Object} studentData - Updated student data
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async updateStudent(studentId, studentData, studioOwnerId) {
    const db = getFirestore();
    const studentRef = db.collection("students").doc(studentId);
    const doc = await studentRef.get();

    if (!doc.exists) {
      throw new Error("Student not found");
    }

    const existingData = doc.data();
    if (existingData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }

    const updateData = {
      ...studentData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await studentRef.update(updateData);
  }

  /**
   * Delete a student
   * @param {string} studentId - Student document ID
   * @param {string} studioOwnerId - Studio owner document ID
   * @returns {Promise<void>}
   */
  async deleteStudent(studentId, studioOwnerId) {
    const db = getFirestore();
    const studentRef = db.collection("students").doc(studentId);
    const doc = await studentRef.get();

    if (!doc.exists) {
      throw new Error("Student not found");
    }

    const studentData = doc.data();
    if (studentData.studioOwnerId !== studioOwnerId) {
      throw new Error("Access denied: Student does not belong to this studio owner");
    }

    await studentRef.delete();
  }
}

module.exports = new StudentsService();
