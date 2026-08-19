import { getFirestore } from "../utils/firestore";
import * as flyerGen from "./flyer-generator.service";
import * as flyersService from "./flyers.service";

// Shared date/price formatting used by both the manual "Generate Flyer" flow
// (routes/flyers.ts) and the automatic on-creation flow below — kept in one
// place so the two never drift out of sync.

export function formatEventDate(isoStr?: string): string {
  if (!isoStr) return "";
  try {
    return new Date(isoStr).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return isoStr;
  }
}

export function formatEventTime(isoStr?: string): string {
  if (!isoStr) return "";
  try {
    return new Date(isoStr).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoStr;
  }
}

export function formatPrice(tiers?: Array<{ price?: number }>): string {
  if (!tiers || tiers.length === 0) return "";
  const lowestPrice = tiers
    .map((t) => t.price ?? Infinity)
    .filter((p) => p < Infinity)
    .sort((a, b) => a - b)[0];
  return lowestPrice !== undefined ? `$${lowestPrice}` : "";
}

export interface AutoFlyerResult {
  id: string;
  contentName: string;
}

async function getStudioName(studioOwnerId: string): Promise<string> {
  const db = getFirestore();
  const userDoc = await db.collection("users").doc(studioOwnerId).get();
  const userData = userDoc.data() as Record<string, unknown> | undefined;
  return (userData?.["studioName"] as string) || "My Studio";
}

/**
 * Best-effort — a flyer-generation failure should never block the content creation
 * itself, so every call site treats a null return as "no flyer, move on."
 */
export async function autoGenerateClassFlyer(
  classBody: Record<string, unknown>, studioOwnerId: string,
): Promise<AutoFlyerResult | null> {
  try {
    const studioName = await getStudioName(studioOwnerId);

    const name = (classBody["name"] as string) || "Dance Class";
    const danceGenre = classBody["danceGenre"] as string | undefined;
    const level = classBody["level"] as string | undefined;
    const dayOfWeek = classBody["dayOfWeek"] as string | undefined;
    const startTime = classBody["startTime"] as string | undefined;
    const endTime = classBody["endTime"] as string | undefined;
    const cost = classBody["cost"] as number | undefined;
    const timeStr = startTime && endTime ? `${startTime} – ${endTime}` : startTime;

    const copy = await flyerGen.generateFlyerCopy({
      type: "class",
      name,
      studioName,
      danceGenre,
      level,
      dateStr: dayOfWeek || "",
      price: cost != null ? `$${cost}` : undefined,
    });

    const svgContent = flyerGen.buildClassFlyer({
      studioName,
      name,
      danceGenre,
      level,
      dayOfWeek,
      timeStr,
      price: cost != null ? `$${cost} per class` : undefined,
      copy,
    });

    const flyer = await flyersService.saveFlyer(studioOwnerId, {
      type: "class",
      contentName: name,
      svgContent,
      flyerHeight: 1350,
    });

    return { id: flyer.id, contentName: name };
  } catch (error) {
    console.error("Error auto-generating class flyer:", error);
    return null;
  }
}

export async function autoGenerateEventOrWorkshopFlyer(
  body: Record<string, unknown>, studioOwnerId: string, type: "event" | "workshop",
): Promise<AutoFlyerResult | null> {
  try {
    const studioName = await getStudioName(studioOwnerId);

    const name = (body["name"] as string) || (type === "event" ? "Event" : "Workshop");
    const rawGenre = body["danceGenre"];
    const danceGenre = Array.isArray(rawGenre) ? (rawGenre as string[]).join(", ") : (rawGenre as string | undefined);
    const startTime = body["startTime"] as string | undefined;
    const endTime = body["endTime"] as string | undefined;
    const dateStr = formatEventDate(startTime);
    const timeStr = startTime && endTime
      ? `${formatEventTime(startTime)} – ${formatEventTime(endTime)}`
      : formatEventTime(startTime);
    const location = [body["locationName"], body["city"], body["state"]].filter(Boolean).join(", ");
    const price = formatPrice(body["priceTiers"] as Array<{ price?: number }> | undefined);
    const description = body["description"] as string | undefined;
    const rawLevels = body["levels"];
    const level = type === "workshop" && Array.isArray(rawLevels) ? (rawLevels as string[]).join(", ") : undefined;

    const copy = await flyerGen.generateFlyerCopy({
      type,
      name,
      studioName,
      danceGenre,
      level,
      dateStr,
      price: price || undefined,
      location: location || undefined,
      description,
    });

    const svgContent = flyerGen.buildEventOrWorkshopFlyer({
      studioName,
      name,
      danceGenre,
      dateStr: dateStr || undefined,
      timeStr: timeStr || undefined,
      location: location || undefined,
      price: price || undefined,
      description,
      copy,
    });

    const flyer = await flyersService.saveFlyer(studioOwnerId, {
      type,
      contentName: name,
      svgContent,
      flyerHeight: 1350,
    });

    return { id: flyer.id, contentName: name };
  } catch (error) {
    console.error(`Error auto-generating ${type} flyer:`, error);
    return null;
  }
}
