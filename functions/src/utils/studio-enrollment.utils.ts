import type { StudiosMap } from "../types/firebase";

/**
 * Convert studioIds array to studios object structure.
 */
export function convertStudioIdsToStudios(studioIds: string[]): StudiosMap {
  if (!Array.isArray(studioIds)) {
    return {};
  }
  const studios: StudiosMap = {};
  studioIds.forEach((studioId) => {
    studios[studioId] = {};
  });
  return studios;
}

/**
 * Ensure studios object structure exists in user profile data.
 */
export function ensureStudiosStructure(userProfileData: Record<string, unknown> | null | undefined): StudiosMap {
  if (!userProfileData) {
    return {};
  }

  if (userProfileData["studios"] && typeof userProfileData["studios"] === "object") {
    return userProfileData["studios"] as StudiosMap;
  }

  if (Array.isArray(userProfileData["studioIds"])) {
    return convertStudioIdsToStudios(userProfileData["studioIds"] as string[]);
  }

  return {};
}
