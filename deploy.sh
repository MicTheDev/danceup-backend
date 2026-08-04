#!/bin/bash
# Deploy script for danceup-backend.
# Usage: ./deploy.sh <dev|staging|production> [firebase deploy args...]
#   Examples:
#     ./deploy.sh production --only functions
#     ./deploy.sh production --only firestore:indexes
#     ./deploy.sh staging
#
# Fixes a footgun that's bitten this project for real:
#
# firebase.json hardcodes a single Firestore "database" value, but each
# environment's real database has a different name:
#   dev-danceup        -> development
#   staging-danceup     -> staging
#   production-danceup  -> (default)
# Deploying firestore rules/indexes with the wrong value silently creates
# and populates the wrong database instead of erroring — this happened on
# 2026-07-19 (an empty "development" database got created inside
# production-danceup). This script patches firebase.json to the correct
# database for the target environment for the duration of the deploy, then
# always restores it afterward (even on failure/interrupt), so the repo's
# checked-in firebase.json never has to be hand-edited per deploy.
#
# (Previously also re-set FIREBASE_WEB_API_KEY on auth/usersstudent after
# every functions deploy, since it used to be a manually-set env var that
# firebase deploy would wipe. getFirebaseApiKey() now falls back to Secret
# Manager (firebase-web-api-key-{dev,staging,prod}) when the env var is
# unset, so that patch step is no longer needed.)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIREBASE_JSON="$SCRIPT_DIR/firebase.json"

ENV="$1"
shift || true

case "$ENV" in
  dev)
    PROJECT="dev-danceup"
    DATABASE="development"
    ;;
  staging)
    PROJECT="staging-danceup"
    DATABASE="staging"
    ;;
  production)
    PROJECT="production-danceup"
    DATABASE="(default)"
    ;;
  *)
    echo "❌ Unknown environment: '$ENV'. Use 'dev', 'staging', or 'production'."
    echo "   Usage: ./deploy.sh <dev|staging|production> [firebase deploy args...]"
    exit 1
    ;;
esac

ORIGINAL=$(cat "$FIREBASE_JSON")
restore() {
  echo "$ORIGINAL" > "$FIREBASE_JSON"
}
trap restore EXIT

echo "🚀 Deploying to $ENV ($PROJECT), Firestore database: $DATABASE"

jq --arg db "$DATABASE" '.firestore.database = $db' "$FIREBASE_JSON" > "$FIREBASE_JSON.tmp"
mv "$FIREBASE_JSON.tmp" "$FIREBASE_JSON"

firebase deploy --project "$PROJECT" "$@"
