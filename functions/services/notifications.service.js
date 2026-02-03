const admin = require("firebase-admin");
const authService = require("./auth.service");
const {getFirestore} = require("../utils/firestore");

/**
 * Service for handling notification operations
 */
class NotificationsService {
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
   * Create a notification
   * @param {string} studioId - Studio owner document ID
   * @param {string} bookingId - Booking document ID (optional, for booking-related notifications)
   * @param {string} type - Notification type
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {string} studentId - Student document ID (optional, for student-related notifications)
   * @returns {Promise<string>} Created notification document ID
   */
  async createNotification(studioId, bookingId, type, title, message, studentId = null) {
    const db = getFirestore();
    const notificationsRef = db.collection("notifications");

    const notificationData = {
      studioId,
      type,
      title,
      message,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Add bookingId or studentId based on notification type
    if (bookingId) {
      notificationData.bookingId = bookingId;
    }
    if (studentId) {
      notificationData.studentId = studentId;
    }

    const docRef = await notificationsRef.add(notificationData);
    return docRef.id;
  }

  /**
   * Get notifications for a studio owner
   * @param {string} studioId - Studio owner document ID
   * @param {number} limit - Maximum number of notifications to return
   * @param {string} startAfter - Document ID to start after (for pagination)
   * @returns {Promise<Array>} Array of notifications
   */
  async getNotificationsByStudio(studioId, limit = 50, startAfter = null) {
    const db = getFirestore();
    const notificationsRef = db.collection("notifications");

    // Calculate date 90 days ago
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(ninetyDaysAgo);

    let query = notificationsRef
        .where("studioId", "==", studioId)
        .where("createdAt", ">=", ninetyDaysAgoTimestamp)
        .orderBy("createdAt", "desc")
        .limit(limit);

    if (startAfter) {
      const startAfterDoc = await notificationsRef.doc(startAfter).get();
      if (startAfterDoc.exists) {
        query = query.startAfter(startAfterDoc);
      }
    }

    const snapshot = await query.get();
    const notifications = [];
    snapshot.forEach((doc) => {
      notifications.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return notifications;
  }

  /**
   * Mark a notification as read
   * @param {string} notificationId - Notification document ID
   * @param {string} studioId - Studio owner document ID (for verification)
   * @returns {Promise<void>}
   */
  async markNotificationAsRead(notificationId, studioId) {
    const db = getFirestore();
    const notificationRef = db.collection("notifications").doc(notificationId);
    const doc = await notificationRef.get();

    if (!doc.exists) {
      throw new Error("Notification not found");
    }

    const notificationData = doc.data();
    if (notificationData.studioId !== studioId) {
      throw new Error("Access denied: Notification does not belong to this studio");
    }

    await notificationRef.update({
      read: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Mark a notification as unread
   * @param {string} notificationId - Notification document ID
   * @param {string} studioId - Studio owner document ID (for verification)
   * @returns {Promise<void>}
   */
  async markNotificationAsUnread(notificationId, studioId) {
    const db = getFirestore();
    const notificationRef = db.collection("notifications").doc(notificationId);
    const doc = await notificationRef.get();

    if (!doc.exists) {
      throw new Error("Notification not found");
    }

    const notificationData = doc.data();
    if (notificationData.studioId !== studioId) {
      throw new Error("Access denied: Notification does not belong to this studio");
    }

    await notificationRef.update({
      read: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Get count of unread notifications for a studio owner
   * @param {string} studioId - Studio owner document ID
   * @returns {Promise<number>} Count of unread notifications
   */
  async getUnreadCount(studioId) {
    const db = getFirestore();
    const notificationsRef = db.collection("notifications");

    // Calculate date 90 days ago
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(ninetyDaysAgo);

    const snapshot = await notificationsRef
        .where("studioId", "==", studioId)
        .where("read", "==", false)
        .where("createdAt", ">=", ninetyDaysAgoTimestamp)
        .get();

    return snapshot.size;
  }
}

module.exports = new NotificationsService();
