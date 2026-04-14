const https = require("https");

const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
const RATE_LIMIT_MS = 1100; // Nominatim requires max 1 req/sec

let lastRequestTime = 0;

/**
 * Enforces Nominatim's 1 req/sec rate limit
 */
async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Makes a GET request to a URL and returns parsed JSON
 * @param {string} url
 * @returns {Promise<any>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "THELDC-DanceUp/1.0",
        "Accept": "application/json",
      },
    };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse Nominatim response"));
        }
      });
    }).on("error", reject);
  });
}

/**
 * Geocodes an address to lat/lng coordinates using Nominatim (OpenStreetMap).
 * Falls back to city+state+zip if the full address yields no results.
 * @param {string} addressLine - Street address line
 * @param {string} city
 * @param {string} state - Two-letter state code
 * @param {string} zip
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
async function geocodeAddress(addressLine, city, state, zip) {
  try {
    await rateLimit();

    const query = encodeURIComponent(`${addressLine}, ${city}, ${state} ${zip}, USA`);
    const url = `${NOMINATIM_BASE_URL}/search?q=${query}&format=json&limit=1&countrycodes=us`;

    const results = await fetchJson(url);

    if (results && results.length > 0) {
      return {
        lat: parseFloat(results[0].lat),
        lng: parseFloat(results[0].lon),
      };
    }

    // Fallback: city + state + zip only
    await rateLimit();
    const fallbackQuery = encodeURIComponent(`${city}, ${state} ${zip}, USA`);
    const fallbackUrl = `${NOMINATIM_BASE_URL}/search?q=${fallbackQuery}&format=json&limit=1&countrycodes=us`;
    const fallbackResults = await fetchJson(fallbackUrl);

    if (fallbackResults && fallbackResults.length > 0) {
      return {
        lat: parseFloat(fallbackResults[0].lat),
        lng: parseFloat(fallbackResults[0].lon),
      };
    }

    return null;
  } catch (error) {
    console.error("Geocoding error:", error.message);
    return null;
  }
}

/**
 * Reverse geocodes coordinates to city and state using Nominatim.
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{city: string, state: string} | null>}
 */
async function reverseGeocode(lat, lng) {
  try {
    await rateLimit();

    const url = `${NOMINATIM_BASE_URL}/reverse?lat=${lat}&lon=${lng}&format=json`;
    const result = await fetchJson(url);

    if (!result || !result.address) {
      return null;
    }

    const addr = result.address;
    const city = addr.city || addr.town || addr.village || addr.county || "";
    // ISO3166-2-lvl4 is "US-TX" format; fall back to full state name
    const stateCode = addr["ISO3166-2-lvl4"]
      ? addr["ISO3166-2-lvl4"].split("-")[1]
      : addr.state || "";

    return { city, state: stateCode };
  } catch (error) {
    console.error("Reverse geocoding error:", error.message);
    return null;
  }
}

module.exports = { geocodeAddress, reverseGeocode };
