import * as https from "https";

const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
const RATE_LIMIT_MS = 1100; // Nominatim requires max 1 req/sec

let lastRequestTime = 0;

interface NominatimResult {
  lat: string;
  lon: string;
  display_name?: string;
}

interface NominatimReverseResult {
  address?: {
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    state?: string;
    "ISO3166-2-lvl4"?: string;
  };
}

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "THELDC-DanceUp/1.0",
        "Accept": "application/json",
      },
    };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (_e) {
          reject(new Error("Failed to parse Nominatim response"));
        }
      });
    }).on("error", reject);
  });
}

/**
 * Geocodes an address to lat/lng coordinates using Nominatim (OpenStreetMap).
 * Falls back to city+state+zip if the full address yields no results.
 */
export async function geocodeAddress(
  addressLine: string,
  city: string,
  state: string,
  zip: string,
): Promise<{ lat: number; lng: number } | null> {
  try {
    await rateLimit();

    const query = encodeURIComponent(`${addressLine}, ${city}, ${state} ${zip}, USA`);
    const url = `${NOMINATIM_BASE_URL}/search?q=${query}&format=json&limit=1&countrycodes=us`;

    const results = await fetchJson<NominatimResult[]>(url);

    if (results && results.length > 0) {
      const first = results[0];
      if (!first) return null;
      return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
    }

    // Fallback: city + state + zip only
    await rateLimit();
    const fallbackQuery = encodeURIComponent(`${city}, ${state} ${zip}, USA`);
    const fallbackUrl = `${NOMINATIM_BASE_URL}/search?q=${fallbackQuery}&format=json&limit=1&countrycodes=us`;
    const fallbackResults = await fetchJson<NominatimResult[]>(fallbackUrl);

    if (fallbackResults && fallbackResults.length > 0) {
      const first = fallbackResults[0];
      if (!first) return null;
      return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
    }

    return null;
  } catch (error) {
    console.error("Geocoding error:", (error as Error).message);
    return null;
  }
}

/**
 * Reverse geocodes coordinates to city and state using Nominatim.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<{ city: string; state: string } | null> {
  try {
    await rateLimit();

    const url = `${NOMINATIM_BASE_URL}/reverse?lat=${lat}&lon=${lng}&format=json`;
    const result = await fetchJson<NominatimReverseResult>(url);

    if (!result || !result.address) {
      return null;
    }

    const addr = result.address;
    const city = addr.city ?? addr.town ?? addr.village ?? addr.county ?? "";
    const stateCode = addr["ISO3166-2-lvl4"]
      ? addr["ISO3166-2-lvl4"].split("-")[1] ?? ""
      : addr.state ?? "";

    return { city, state: stateCode };
  } catch (error) {
    console.error("Reverse geocoding error:", (error as Error).message);
    return null;
  }
}
