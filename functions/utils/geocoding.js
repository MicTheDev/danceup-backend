const https = require("https");
const {getSecret} = require("./secret-manager");

const GOOGLE_GEOCODE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";
const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
const RATE_LIMIT_MS = 1100;

let lastNominatimRequest = 0;

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers}, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse geocoding response"));
        }
      });
    }).on("error", reject);
  });
}

async function getGoogleMapsApiKey() {
  try {
    return await getSecret("google-maps-api-key");
  } catch {
    // Fall back to env var for local development
    return process.env.GOOGLE_MAPS_API_KEY || null;
  }
}

async function geocodeWithGoogle(addressLine, city, state, zip) {
  const apiKey = await getGoogleMapsApiKey();
  if (!apiKey) return null;

  const address = encodeURIComponent(`${addressLine}, ${city}, ${state} ${zip}, USA`);
  const url = `${GOOGLE_GEOCODE_BASE}?address=${address}&key=${apiKey}`;

  const result = await fetchJson(url);
  if (result.status === "OK" && result.results && result.results.length > 0) {
    const loc = result.results[0].geometry.location;
    return {lat: loc.lat, lng: loc.lng};
  }

  return null;
}

async function geocodeWithNominatim(addressLine, city, state, zip) {
  const now = Date.now();
  const elapsed = now - lastNominatimRequest;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastNominatimRequest = Date.now();

  const query = encodeURIComponent(`${addressLine}, ${city}, ${state} ${zip}, USA`);
  const url = `${NOMINATIM_BASE_URL}/search?q=${query}&format=json&limit=1&countrycodes=us`;
  const results = await fetchJson(url, {
    "User-Agent": "THELDC-DanceUp/1.0",
    "Accept": "application/json",
  });

  if (results && results.length > 0) {
    return {lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon)};
  }

  // Fallback: city + state + zip only
  lastNominatimRequest = Date.now();
  const fallbackQuery = encodeURIComponent(`${city}, ${state} ${zip}, USA`);
  const fallbackUrl = `${NOMINATIM_BASE_URL}/search?q=${fallbackQuery}&format=json&limit=1&countrycodes=us`;
  const fallbackResults = await fetchJson(fallbackUrl, {
    "User-Agent": "THELDC-DanceUp/1.0",
    "Accept": "application/json",
  });

  if (fallbackResults && fallbackResults.length > 0) {
    return {lat: parseFloat(fallbackResults[0].lat), lng: parseFloat(fallbackResults[0].lon)};
  }

  return null;
}

/**
 * Geocodes an address to lat/lng. Uses Google Maps API when a key is available,
 * falls back to Nominatim (OpenStreetMap) otherwise.
 */
async function geocodeAddress(addressLine, city, state, zip) {
  try {
    const googleResult = await geocodeWithGoogle(addressLine, city, state, zip);
    if (googleResult) return googleResult;

    return await geocodeWithNominatim(addressLine, city, state, zip);
  } catch (error) {
    console.error("Geocoding error:", error.message);
    return null;
  }
}

/**
 * Reverse geocodes coordinates to city and state using Nominatim.
 */
async function reverseGeocode(lat, lng) {
  try {
    const now = Date.now();
    const elapsed = now - lastNominatimRequest;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
    }
    lastNominatimRequest = Date.now();

    const url = `${NOMINATIM_BASE_URL}/reverse?lat=${lat}&lon=${lng}&format=json`;
    const result = await fetchJson(url, {
      "User-Agent": "THELDC-DanceUp/1.0",
      "Accept": "application/json",
    });

    if (!result || !result.address) return null;

    const addr = result.address;
    const city = addr.city || addr.town || addr.village || addr.county || "";
    const stateCode = addr["ISO3166-2-lvl4"]
      ? addr["ISO3166-2-lvl4"].split("-")[1]
      : addr.state || "";

    return {city, state: stateCode};
  } catch (error) {
    console.error("Reverse geocoding error:", error.message);
    return null;
  }
}

module.exports = {geocodeAddress, reverseGeocode};
