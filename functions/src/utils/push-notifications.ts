import * as admin from "firebase-admin";
import authService from "../services/auth.service";

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
