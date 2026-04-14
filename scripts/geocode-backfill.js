/**
 * One-time backfill script: geocodes existing events, workshops, classes,
 * and studio (user) documents that are missing lat/lng coordinates.
 *
 * Usage (run from danceup-backend/functions/):
 *   GCLOUD_PROJECT=dev-danceup DRY_RUN=true node ../scripts/geocode-backfill.js
 *   GCLOUD_PROJECT=production-danceup node ../scripts/geocode-backfill.js
 *
 * Optional env vars:
 *   FIRESTORE_DATABASE_ID   — override the Firestore database (e.g. "development")
 *   DRY_RUN=true            — log what would be updated without writing to Firestore
 */

"use strict";

// Ensure Node can resolve firebase-admin from functions/node_modules regardless
// of which directory the script was invoked from.
const path = require("path");
const functionsDir = path.join(__dirname, "..", "functions");
if (!process.env.NODE_PATH || !process.env.NODE_PATH.includes(functionsDir)) {
  const sep = process.platform === "win32" ? ";" : ":";
  process.env.NODE_PATH = functionsDir + "/node_modules" +
    (process.env.NODE_PATH ? sep + process.env.NODE_PATH : "");
  require("module").Module._initPaths();
}

const admin = require("firebase-admin");
const {Firestore} = require("@google-cloud/firestore");

// Initialise Firebase Admin (uses GOOGLE_APPLICATION_CREDENTIALS env var)
if (!admin.apps.length) {
  admin.initializeApp();
}

// ---------- Inline helpers so the script is self-contained ----------

const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
const RATE_LIMIT_MS = 1200; // slightly over 1 s to be safe

let lastRequestTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

const https = require("https");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "THELDC-DanceUp-Backfill/1.0",
        "Accept": "application/json",
      },
    };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function geocodeAddress(addressLine, city, state, zip) {
  try {
    await rateLimit();
    const q = encodeURIComponent(`${addressLine}, ${city}, ${state} ${zip}, USA`);
    const results = await fetchJson(
        `${NOMINATIM_BASE_URL}/search?q=${q}&format=json&limit=1&countrycodes=us`,
    );
    if (results && results.length > 0) {
      return {lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon)};
    }

    // Fallback: city + state only
    await rateLimit();
    const q2 = encodeURIComponent(`${city}, ${state} ${zip}, USA`);
    const fallback = await fetchJson(
        `${NOMINATIM_BASE_URL}/search?q=${q2}&format=json&limit=1&countrycodes=us`,
    );
    if (fallback && fallback.length > 0) {
      return {lat: parseFloat(fallback[0].lat), lng: parseFloat(fallback[0].lon)};
    }
    return null;
  } catch (err) {
    console.error("Geocode error:", err.message);
    return null;
  }
}

function getFirestore() {
  const projectId = process.env.GCLOUD_PROJECT || admin.app().options.projectId;
  let databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";

  if (!process.env.FIRESTORE_DATABASE_ID) {
    if (projectId === "dev-danceup") databaseId = "development";
    else if (projectId === "staging-danceup") databaseId = "staging";
    else if (projectId === "production-danceup") databaseId = "production";
  }

  if (databaseId === "(default)") return admin.firestore();

  return new Firestore({projectId, databaseId});
}

// ---------- Backfill logic ----------

const DRY_RUN = process.env.DRY_RUN === "true";

let updated = 0;
let skipped = 0;
let failed = 0;

async function processCollection(db, collectionName, getAddressFn) {
  console.log(`\n--- Processing collection: ${collectionName} ---`);
  const snapshot = await db.collection(collectionName).get();
  console.log(`  Found ${snapshot.size} documents`);

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Skip if already geocoded
    if (data.lat != null && data.lng != null) {
      skipped++;
      continue;
    }

    const address = getAddressFn(data);
    if (!address) {
      console.warn(`  [SKIP] ${doc.id} — missing address fields`);
      skipped++;
      continue;
    }

    const {addressLine, city, state, zip} = address;
    if (!addressLine || !city || !state) {
      console.warn(`  [SKIP] ${doc.id} — incomplete address: "${addressLine}, ${city}, ${state}"`);
      skipped++;
      continue;
    }

    const coords = await geocodeAddress(addressLine, city, state, zip || "");
    if (!coords) {
      console.warn(`  [FAIL] ${doc.id} — could not geocode: "${addressLine}, ${city}, ${state}"`);
      failed++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] ${doc.id} → lat=${coords.lat}, lng=${coords.lng}`);
    } else {
      await db.collection(collectionName).doc(doc.id).update({
        lat: coords.lat,
        lng: coords.lng,
      });
      console.log(`  [OK] ${doc.id} → lat=${coords.lat}, lng=${coords.lng}`);
    }
    updated++;
  }
}

async function main() {
  console.log("=== DanceUp Geocode Backfill ===");
  console.log(`DRY_RUN: ${DRY_RUN}`);

  const db = getFirestore();

  // Events — use their own addressLine1, city, state, zip
  await processCollection(db, "events", (data) => ({
    addressLine: data.addressLine1 || "",
    city: data.city || "",
    state: data.state || "",
    zip: data.zip || "",
  }));

  // Workshops — same
  await processCollection(db, "workshops", (data) => ({
    addressLine: data.addressLine1 || "",
    city: data.city || "",
    state: data.state || "",
    zip: data.zip || "",
  }));

  // Classes — use studio owner fields stored on the class doc
  // The enriched class embeds studio data but the raw doc may not.
  // Fall back to checking the studioOwnerId to fetch from users if needed.
  await processCollection(db, "classes", (data) => {
    // Some class docs embed studio address fields directly from creation
    if (data.studio && data.studio.addressLine1) {
      return {
        addressLine: data.studio.addressLine1,
        city: data.studio.city || "",
        state: data.studio.state || "",
        zip: data.studio.zip || "",
      };
    }
    // Otherwise we don't have enough info in the raw doc —
    // the backfill will handle this via the studioOwner lookup below.
    return null;
  });

  // Studios (users with studio_owner role) — use studioAddressLine1, city, state, zip
  await processCollection(db, "users", (data) => {
    if (!data.roles || !data.roles.includes("studio_owner")) return null;
    return {
      addressLine: data.studioAddressLine1 || "",
      city: data.city || "",
      state: data.state || "",
      zip: data.zip || "",
    };
  });

  // Second pass for classes missing coords via studio owner lookup
  console.log("\n--- Second pass: classes without studio address on doc ---");
  const classSnapshot = await db.collection("classes").get();
  for (const doc of classSnapshot.docs) {
    const data = doc.data();
    if (data.lat != null && data.lng != null) continue;
    if (!data.studioOwnerId) continue;

    const ownerDoc = await db.collection("users").doc(data.studioOwnerId).get();
    if (!ownerDoc.exists) continue;
    const owner = ownerDoc.data();

    if (!owner.studioAddressLine1 || !owner.city || !owner.state) {
      console.warn(`  [SKIP] class ${doc.id} — studio owner has incomplete address`);
      skipped++;
      continue;
    }

    const coords = await geocodeAddress(
        owner.studioAddressLine1,
        owner.city,
        owner.state,
        owner.zip || "",
    );
    if (!coords) {
      console.warn(`  [FAIL] class ${doc.id} — geocoding failed`);
      failed++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] class ${doc.id} → lat=${coords.lat}, lng=${coords.lng}`);
    } else {
      await db.collection("classes").doc(doc.id).update({lat: coords.lat, lng: coords.lng});
      console.log(`  [OK] class ${doc.id} → lat=${coords.lat}, lng=${coords.lng}`);
    }
    updated++;
  }

  console.log("\n=== Backfill complete ===");
  console.log(`  Updated : ${updated}`);
  console.log(`  Skipped : ${skipped}`);
  console.log(`  Failed  : ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
