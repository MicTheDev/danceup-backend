import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { getFirestore } from "../utils/firestore";
import attendanceService from "../services/attendance.service";

const DAY_NAME_TO_NUM: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// Cache timezone offsets (lat/lng key → offset minutes) for the duration of a single run.
// A cached `null` means the offset is unknown for that key — distinct from a real UTC (0) offset.
const timezoneCache = new Map<string, number | null>();

// Returns null when the studio's timezone can't be determined — callers must treat that as
// "unknown," not as UTC, since silently assuming UTC caused classes to check in hours early
// for studios without a resolvable location (see incident: Staging Test Account, 2026-07-28).
function getStudioOffsetMinutes(lat: number, lng: number, epochMs: number): number | null {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (timezoneCache.has(key)) return timezoneCache.get(key)!;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { find } = require("geo-tz") as { find: (lat: number, lng: number) => string[] };
    const zones = find(lat, lng);
    const zone = zones[0];
    if (!zone) {
      timezoneCache.set(key, null);
      return null;
    }

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
    timezoneCache.set(key, null);
    return null;
  }
}

function parseMinutes(time: string): number {
  const parts = time.split(":");
  return (Number(parts[0] ?? 0)) * 60 + Number(parts[1] ?? 0);
}

// Compares against the studio's own local minutes-of-day (see localMinutes
// below) — both sides are already in the same local frame, so no UTC
// conversion happens here. Converting the class's local time to a UTC
// minutes-of-day value (the previous approach) breaks the moment that
// conversion crosses a UTC calendar-day boundary, which it does for every
// evening class west of UTC.
function isInWindow(localMinutes: number, startTime: string, endTime: string): boolean {
  const start = parseMinutes(startTime);
  const end = parseMinutes(endTime);
  return localMinutes >= start - 30 && localMinutes <= end;
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
    const epochMs = now.getTime();

    console.log(`[AutoCheckIn] Running at ${now.toISOString()}`);

    const profilesSnap = await db.collection("usersStudentProfiles").get();

    type AutoCheckInEntry = { classId: string; dependentId: string | null };
    const entriesForProfile = (profile: admin.firestore.DocumentData): AutoCheckInEntry[] => {
      const rawEntries = profile["autoCheckInEntries"] as { classId: string; dependentId?: string | null }[] | undefined;
      if (rawEntries && rawEntries.length > 0) {
        return rawEntries.map((e) => ({ classId: e.classId, dependentId: e.dependentId || null }));
      }
      const legacyClassIds = (profile["autoCheckInClassIds"] ?? []) as string[];
      return legacyClassIds.map((classId) => ({ classId, dependentId: null }));
    };

    const profilesWithEntries = profilesSnap.docs.filter((d) => entriesForProfile(d.data()).length > 0);
    console.log(`[AutoCheckIn] ${profilesSnap.size} profiles, ${profilesWithEntries.length} with auto check-in entries`);

    const classCache = new Map<string, admin.firestore.DocumentData>();
    const studioCache = new Map<string, admin.firestore.DocumentData>();

    for (const profileDoc of profilesSnap.docs) {
      const profile = profileDoc.data();
      const entries = entriesForProfile(profile);
      if (entries.length === 0) continue;

      const authUid = profile["authUid"] as string;
      const fcmToken = profile["fcmToken"] as string | undefined;
      console.log(`[AutoCheckIn] ${authUid} fcmToken=${fcmToken ? "present" : "MISSING"}`);

      for (const entry of entries) {
        const { classId, dependentId } = entry;
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
            : null;

          if (offsetMinutes == null) {
            // Unknown timezone (missing studio lat/lng, or lookup failed) — skip rather than
            // assume UTC, which would silently check students in hours before/after class.
            console.warn(`[AutoCheckIn] Unknown timezone for studio "${studioName}" (studioOwnerId=${studioOwnerId}, lat=${lat}, lng=${lng}) — skipping "${className}"`);
            continue;
          }

          // Derive the studio's own local day-of-week and minutes-of-day from
          // its offset, rather than comparing the class's local day/time
          // against UTC's. Comparing "today" as `now.getUTCDay()` against a
          // class stored in local time is wrong every evening west of UTC —
          // UTC's calendar date rolls over hours before local midnight, so a
          // class scheduled for tonight gets compared against tomorrow's UTC
          // day and skipped (see incident: auto check-in never fired for any
          // evening class once the timezone-fallback fix above went in,
          // 2026-07-29).
          const localNow = new Date(epochMs + offsetMinutes * 60000);
          const localDow = localNow.getUTCDay();
          const localMinutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();

          // Label the attendance record with the studio's local calendar date
          // (also derived from localNow), not UTC's — otherwise an evening
          // check-in west of UTC gets stamped with tomorrow's date.
          const localY = localNow.getUTCFullYear();
          const localMo = String(localNow.getUTCMonth() + 1).padStart(2, "0");
          const localD = String(localNow.getUTCDate()).padStart(2, "0");
          const instanceDateStr = `${localY}-${localMo}-${localD}T12:00:00.000Z`;

          console.log(`[AutoCheckIn] Class "${className}" DOW=${classDow}(${dayOfWeekName}) ${startTime}-${endTime} | studioLocalDow=${localDow} studioLocalMinutes=${localMinutes} studioLat=${lat} studioLng=${lng} offset=${offsetMinutes}`);

          if (classDow !== localDow) continue;

          if (!isInWindow(localMinutes, startTime, endTime)) {
            console.log(`[AutoCheckIn] Outside time window for "${className}"`);
            continue;
          }

          const studentId = await attendanceService.getStudentIdByAuthUidAndStudio(authUid, studioOwnerId, dependentId);
          if (!studentId) {
            console.log(`[AutoCheckIn] No student record for ${authUid}${dependentId ? ` (dependent ${dependentId})` : ""} in studio ${studioOwnerId}`);
            continue;
          }

          try {
            // "student" here, not a distinct "auto" value — the current attendance
            // service's checkedInBy type only recognizes "studio" | "student" (matching
            // every frontend consumer of this field), and resolves checkedInById to
            // studentId for any non-"studio" value either way, so this preserves the
            // exact same stored checkedInById this cron has always produced.
            await attendanceService.createAttendanceRecord(
              { studentId, classId, classInstanceDate: instanceDateStr, checkedInBy: "student" },
              studioOwnerId,
            );

            console.log(`[AutoCheckIn] Checked in ${authUid}${dependentId ? ` (dependent ${dependentId})` : ""} → class "${className}"`);

            if (fcmToken) {
              await sendFcmNotification(fcmToken, "Checked in ✓", `${className} at ${studioName}`)
                .catch((e) => console.warn("[AutoCheckIn] FCM failed:", (e as Error).message));
            }

            try {
              await db.collection("studentNotifications").add({
                authUid,
                type: "auto_checkin",
                title: "Checked In ✓",
                body: `${className} at ${studioName}`,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            } catch (e) {
              console.warn("[AutoCheckIn] Student notification write failed:", (e as Error).message);
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
