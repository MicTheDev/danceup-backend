import {getFirestore} from "./firestore";

// The platform tiers a studio account can hold. Mirrors MembershipTier in
// studio-owners-app user-registration.service.ts.
export const MEMBERSHIP_TIERS = [
  "event_host", "individual_instructor", "studio_owner", "studio_owner_pro_plus",
] as const;
export type MembershipTier = typeof MEMBERSHIP_TIERS[number];

export const PRO_PLUS_MEMBERSHIP: MembershipTier = "studio_owner_pro_plus";

export function isMembershipTier(value: unknown): value is MembershipTier {
  return typeof value === "string" && (MEMBERSHIP_TIERS as readonly string[]).includes(value);
}

// Plan limits enforced server-side. null = unlimited. Mirrors TIER_LIMITS in
// studio-owners-app tier-limits.service.ts — keep the two in sync.
export type LimitResource = "events" | "workshops" | "emailRecipients";
export const TIER_LIMITS: Record<MembershipTier, Record<LimitResource, number | null>> = {
  event_host: {events: 20, workshops: 0, emailRecipients: 1000},
  individual_instructor: {events: null, workshops: null, emailRecipients: null},
  studio_owner: {events: null, workshops: 10, emailRecipients: 1000},
  studio_owner_pro_plus: {events: null, workshops: null, emailRecipients: null},
};

/** Limit for a studio's tier; unknown or missing tiers get no limit, matching the frontend. */
export function getTierLimit(membership: unknown, resource: LimitResource): number | null {
  return isMembershipTier(membership) ? TIER_LIMITS[membership][resource] : null;
}

/**
 * Pro+ access = on the Pro+ tier with a subscription that hasn't lapsed.
 * subscriptionActive is only ever set false on a failed/canceled subscription or an
 * expired trial; legacy accounts without the field are treated as active, matching
 * the frontend subscription guard.
 */
export function hasProPlusAccess(userData: Record<string, unknown> | undefined): boolean {
  if (!userData) return false;
  return userData["membership"] === PRO_PLUS_MEMBERSHIP && userData["subscriptionActive"] !== false;
}

/**
 * Studio tools (classes, instructors, spreadsheet import) = Studio Owner or Pro+
 * with a subscription that hasn't lapsed.
 */
export function hasStudioPlanAccess(userData: Record<string, unknown> | undefined): boolean {
  if (!userData) return false;
  const membership = userData["membership"];
  const isStudioPlan = membership === "studio_owner" || membership === PRO_PLUS_MEMBERSHIP;
  return isStudioPlan && userData["subscriptionActive"] !== false;
}

export async function getStudioOwnerData(studioOwnerId: string): Promise<Record<string, unknown> | undefined> {
  const doc = await getFirestore().collection("users").doc(studioOwnerId).get();
  return doc.exists ? (doc.data() as Record<string, unknown>) : undefined;
}

export async function studioHasProPlus(studioOwnerId: string): Promise<boolean> {
  return hasProPlusAccess(await getStudioOwnerData(studioOwnerId));
}

export function proPlusRequiredMessage(feature: string): string {
  return `${feature} is included with Studio Owner Pro+. Upgrade your plan to use it.`;
}

export async function studioHasStudioPlan(studioOwnerId: string): Promise<boolean> {
  return hasStudioPlanAccess(await getStudioOwnerData(studioOwnerId));
}

export const STUDIO_PLAN_REQUIRED_MESSAGE =
  "Spreadsheet import is included with Studio Owner and Studio Owner Pro+. Upgrade your plan to use it.";
