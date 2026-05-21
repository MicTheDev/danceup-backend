import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";

const DAY_NAME_TO_NUM: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// Cache timezone offsets (lat/lng key → offset minutes) for the duration of a single run.
const timezoneCache = new Map<string, number>();

function getStudioOffsetMinutes(lat: number, lng: number, epochMs: number): number {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (timezoneCache.has(key)) return timezoneCache.get(key)!;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { find } = require("geo-tz") as { find: (lat: number, lng: number) => string[] };
    const zones = find(lat, lng);
    const zone = zones[0];
    if (!zone) return 0;

    // Compute UTC offset in minutes for this zone at this epoch.
    const date = new Date(epochMs);
    const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(date.toLocaleString("en-US", { timeZone: zone }));
    const offsetMinutes = (tzDate.getTime() - utcDate.getTime()) / 60000;

    console.log(`[AutoCheckIn] Timezone ${zone} → offset=${offsetMinutes}min`);
    timezoneCache.set(key, offsetMinutes);
    return offsetMinutes;
  } catch (e) {
    console.warn("[AutoCheckIn] Timezone lookup failed:", (e as Error).message);
    return 0;
  }
}

function parseMinutes(time: string): number {
  const parts = time.split(":");
  return (Number(parts[0] ?? 0)) * 60 + Number(parts[1] ?? 0);
}

function isInWindow(nowUtcMinutes: number, startTime: string, endTime: string, offsetMinutes: number): boolean {
  const startUtc = parseMinutes(startTime) - offsetMinutes;
  const endUtc = parseMinutes(endTime) - offsetMinutes;
  return nowUtcMinutes >= startUtc - 30 && nowUtcMinutes <= endUtc;
}

async function sendFcmNotification(token: string, title: string, body: string): Promise<void> {
  await admin.messaging().send({
    token,
    notification: { title, body },
    apns: {
      payload: { aps: { sound: "default" } },
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
}

export const autoCheckIn = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "UTC", memory: "256MiB" },
  async (_event) => {
    const db = getFirestore();
    const now = new Date();
    const todayDow = now.getUTCDay();
    const nowUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const epochMs = now.getTime();

    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    const instanceDateStr = `${y}-${mo}-${d}T12:00:00.000Z`;

    console.log(`[AutoCheckIn] Running at ${now.toISOString()} DOW=${todayDow} nowUtcMinutes=${nowUtcMinutes}`);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const attendanceService = require("../../services/attendance.service");

    const profilesSnap = await db.collection("usersStudentProfiles").get();
    const profilesWithIds = profilesSnap.docs.filter(d => ((d.data()["autoCheckInClassIds"] ?? []) as string[]).length > 0);
    console.log(`[AutoCheckIn] ${profilesSnap.size} profiles, ${profilesWithIds.length} with autoCheckInClassIds`);

    const classCache = new Map<string, admin.firestore.DocumentData>();
    const studioCache = new Map<string, admin.firestore.DocumentData>();

    for (const profileDoc of profilesSnap.docs) {
      const profile = profileDoc.data();
      const classIds = (profile["autoCheckInClassIds"] ?? []) as string[];
      if (classIds.length === 0) continue;

      const authUid = profile["authUid"] as string;
      const fcmToken = profile["fcmToken"] as string | undefined;
      console.log(`[AutoCheckIn] ${authUid} fcmToken=${fcmToken ? "present" : "MISSING"}`);

      for (const classId of classIds) {
        try {
          if (!classCache.has(classId)) {
            const doc = await db.collection("classes").doc(classId).get();
            if (!doc.exists) { console.log(`[AutoCheckIn] Class ${classId} not found`); continue; }
            classCache.set(classId, doc.data()!);
          }
          const classData = classCache.get(classId)!;
          const studioOwnerId = classData["studioOwnerId"] as string;
          const className = (classData["name"] as string) ?? "";

          // Classes store schedule as top-level fields, not a schedule array.
          const dayOfWeekName = classData["dayOfWeek"] as string | undefined;
          const startTime = classData["startTime"] as string | undefined;
          const endTime = classData["endTime"] as string | undefined;

          if (!dayOfWeekName || !startTime || !endTime) {
            console.log(`[AutoCheckIn] Class "${className}" missing dayOfWeek/startTime/endTime — skipping`);
            continue;
          }

          const classDow = DAY_NAME_TO_NUM[dayOfWeekName];
          if (classDow === undefined) {
            console.log(`[AutoCheckIn] Class "${className}" unknown dayOfWeek "${dayOfWeekName}" — skipping`);
            continue;
          }

          if (!studioCache.has(studioOwnerId)) {
            const doc = await db.collection("users").doc(studioOwnerId).get();
            studioCache.set(studioOwnerId, doc.exists ? doc.data()! : {});
          }
          const studioData = studioCache.get(studioOwnerId)!;
          const studioName = (studioData["studioName"] as string | undefined) ?? "";
          const lat = studioData["lat"] as number | undefined;
          const lng = studioData["lng"] as number | undefined;

          const offsetMinutes = (lat != null && lng != null)
            ? getStudioOffsetMinutes(lat, lng, epochMs)
            : 0;

          console.log(`[AutoCheckIn] Class "${className}" DOW=${classDow}(${dayOfWeekName}) ${startTime}-${endTime} | todayDow=${todayDow} nowUtc=${nowUtcMinutes} studioLat=${lat} studioLng=${lng} offset=${offsetMinutes}`);

          if (classDow !== todayDow) continue;
          if (!isInWindow(nowUtcMinutes, startTime, endTime, offsetMinutes)) {
            console.log(`[AutoCheckIn] Outside time window for "${className}"`);
            continue;
          }

          const studentSnap = await db.collection("students")
            .where("authUid", "==", authUid)
            .where("studioOwnerId", "==", studioOwnerId)
            .limit(1)
            .get();
          if (studentSnap.empty) { console.log(`[AutoCheckIn] No student record for ${authUid} in studio ${studioOwnerId}`); continue; }
          const studentId = studentSnap.docs[0]!.id;

          try {
            await attendanceService.createAttendanceRecord(
              { studentId, classId, classInstanceDate: instanceDateStr, checkedInBy: "auto" },
              studioOwnerId,
            );

            console.log(`[AutoCheckIn] Checked in ${authUid} → class "${className}"`);

            if (fcmToken) {
              await sendFcmNotification(fcmToken, "Checked in ✓", `${className} at ${studioName}`)
                .catch((e) => console.warn("[AutoCheckIn] FCM failed:", (e as Error).message));
            }
          } catch (e) {
            const msg = ((e as Error).message ?? "").toLowerCase();
            if (msg.includes("already checked") || msg.includes("duplicate")) {
              // Expected — student already checked in manually
            } else if (msg.includes("insufficient credits") || msg.includes("no credits")) {
              console.log(`[AutoCheckIn] No credits: ${authUid} class "${className}"`);
              if (fcmToken) {
                await sendFcmNotification(
                  fcmToken,
                  "Auto check-in failed",
                  `No credits remaining for ${className}. Open DanceUP to purchase more.`,
                ).catch(() => {});
              }
            } else {
              console.error(`[AutoCheckIn] Error for ${authUid} class "${className}":`, e);
            }
          }
        } catch (e) {
          console.error(`[AutoCheckIn] Unexpected error for class ${classId}:`, e);
        }
      }
    }

    timezoneCache.clear();
    console.log("[AutoCheckIn] Run complete");
  },
);
