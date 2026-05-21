import * as https from "https";
import { getSecret } from "./secret-manager";

const GOOGLE_GEOCODE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";

interface GoogleGeocodeResult {
  results: Array<{
    geometry: {
      location: { lat: number; lng: number };
    };
  }>;
  status: string;
}

interface GoogleReverseGeocodeResult {
  results: Array<{
    address_components: Array<{
      long_name: string;
      short_name: string;
      types: string[];
    }>;
  }>;
  status: string;
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (_e) {
          reject(new Error("Failed to parse geocoding response"));
        }
      });
    }).on("error", reject);
  });
}

async function getApiKey(): Promise<string> {
  try {
    return await getSecret("google-maps-api-key");
  } catch {
    const envKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!envKey) throw new Error("No Google Maps API key available");
    return envKey;
  }
}

/**
 * Geocodes an address to lat/lng using the Google Maps Geocoding API.
 */
export async function geocodeAddress(
  addressLine: string,
  city: string,
  state: string,
  zip: string,
): Promise<{ lat: number; lng: number } | null> {
  try {
    const apiKey = await getApiKey();
    const address = encodeURIComponent(`${addressLine}, ${city}, ${state} ${zip}, USA`);
    const url = `${GOOGLE_GEOCODE_BASE}?address=${address}&key=${apiKey}`;

    const result = await fetchJson<GoogleGeocodeResult>(url);

    if (result.status === "OK" && result.results.length > 0 && result.results[0]) {
      const loc = result.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }

    console.warn(`Geocoding returned status ${result.status} for: ${addressLine}, ${city}, ${state} ${zip}`);
    return null;
  } catch (error) {
    console.error("Geocoding error:", (error as Error).message);
    return null;
  }
}

/**
 * Reverse geocodes coordinates to city and state using the Google Maps Geocoding API.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<{ city: string; state: string } | null> {
  try {
    const apiKey = await getApiKey();
    const url = `${GOOGLE_GEOCODE_BASE}?latlng=${lat},${lng}&key=${apiKey}`;

    const result = await fetchJson<GoogleReverseGeocodeResult>(url);

    if (result.status !== "OK" || !result.results.length || !result.results[0]) return null;

    let city = "";
    let stateCode = "";

    for (const component of result.results[0].address_components) {
      if (component.types.includes("locality")) city = component.long_name;
      if (component.types.includes("administrative_area_level_1")) stateCode = component.short_name;
    }

    return { city, state: stateCode };
  } catch (error) {
    console.error("Reverse geocoding error:", (error as Error).message);
    return null;
  }
}
