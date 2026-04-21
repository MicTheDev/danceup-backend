import * as admin from "firebase-admin";
import authService from "./auth.service";
import { getFirestore } from "../utils/firestore";

export class NotificationsService {
  async getStudioOwnerId(authUid: string): Promise<string | null> {
    const userDoc = await authService.getUserDocumentByAuthUid(authUid);
    if (!userDoc) return null;
    return userDoc.id;
  }

  async createNotification(
    studioId: string,
    bookingId: string | null,
    type: string,
    title: string,
    message: string,
    studentId: string | null = null,
  ): Promise<string> {
    const db = getFirestore();
    const notificationData: Record<string, unknown> = {
      studioId,
      type,
      title,
      message,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (bookingId) notificationData["bookingId"] = bookingId;
    if (studentId) notificationData["studentId"] = studentId;
    const docRef = await db.collection("notifications").add(notificationData);
    return docRef.id;
  }

  async getNotificationsByStudio(
    studioId: string, limit = 50, startAfter: string | null = null,
  ): Promise<Array<Record<string, unknown> & { id: string }>> {
    const db = getFirestore();
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(ninetyDaysAgo);

    let query = db.collection("notifications")
      .where("studioId", "==", studioId)
      .where("createdAt", ">=", ninetyDaysAgoTimestamp)
      .orderBy("createdAt", "desc")
      .limit(limit) as FirebaseFirestore.Query;

    if (startAfter) {
      const startAfterDoc = await db.collection("notifications").doc(startAfter).get();
      if (startAfterDoc.exists) query = query.startAfter(startAfterDoc);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
  }

  async markNotificationAsRead(notificationId: string, studioId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("notifications").doc(notificationId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Notification not found");
    const data = doc.data() as Record<string, unknown>;
    if (data["studioId"] !== studioId) throw new Error("Access denied: Notification does not belong to this studio");
    await ref.update({ read: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  async markNotificationAsUnread(notificationId: string, studioId: string): Promise<void> {
    const db = getFirestore();
    const ref = db.collection("notifications").doc(notificationId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("Notification not found");
    const data = doc.data() as Record<string, unknown>;
    if (data["studioId"] !== studioId) throw new Error("Access denied: Notification does not belong to this studio");
    await ref.update({ read: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  async getUnreadCount(studioId: string): Promise<number> {
    const db = getFirestore();
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(ninetyDaysAgo);
    const snapshot = await db.collection("notifications")
      .where("studioId", "==", studioId)
      .where("read", "==", false)
      .where("createdAt", ">=", ninetyDaysAgoTimestamp)
      .get();
    return snapshot.size;
  }
}

export default new NotificationsService();
