import * as admin from "firebase-admin";
import authService from "../services/auth.service";
import { getFirestore } from "./firestore";

/**
 * Looks up the student's FCM token and sends a push notification.
 * Silently no-ops if the token is missing or the send fails.
 */
export async function sendStudentPush(
  authUid: string,
  title: string,
  body: string
): Promise<void> {
  try {
    const profileDoc = await authService.getStudentProfileByAuthUid(authUid);
    if (!profileDoc) return;
    const fcmToken = (profileDoc.data() as Record<string, unknown>)["fcmToken"] as string | undefined;
    if (!fcmToken) return;

    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      apns: {
        payload: { aps: { sound: "default", badge: 1 } },
      },
      android: {
        notification: {
          sound: "default",
          icon: "ic_notification",
          color: "#4F46E5",
          channelId: "auto_checkin",
        },
      },
    });
  } catch (e) {
    console.warn(`[Push] Failed to send to ${authUid}:`, (e as Error).message);
  }
}

/**
 * Looks up the studio owner's FCM token (set via PATCH /profile/fcm-token, currently only
 * captured by the studio-owners-app web client — see app.config.ts/auth.service.ts there)
 * and sends a push notification. Silently no-ops if the token is missing or the send fails.
 */
export async function sendStudioOwnerPush(
  studioOwnerId: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  try {
    const db = getFirestore();
    const doc = await db.collection("users").doc(studioOwnerId).get();
    if (!doc.exists) return;
    const fcmToken = (doc.data() as Record<string, unknown>)["fcmToken"] as string | undefined;
    if (!fcmToken) return;

    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      ...(data ? { data } : {}),
    });
  } catch (e) {
    console.warn(`[Push] Failed to send to studio owner ${studioOwnerId}:`, (e as Error).message);
  }
}
