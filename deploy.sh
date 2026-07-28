#!/bin/bash
# Deploy script for danceup-backend.
# Usage: ./deploy.sh <dev|staging|production> [firebase deploy args...]
#   Examples:
#     ./deploy.sh production --only functions
#     ./deploy.sh production --only firestore:indexes
#     ./deploy.sh staging
#
# Fixes two footguns that have both bitten this project for real:
#
# 1. firebase.json hardcodes a single Firestore "database" value, but each
#    environment's real database has a different name:
#      dev-danceup        -> development
#      staging-danceup     -> staging
#      production-danceup  -> (default)
#    Deploying firestore rules/indexes with the wrong value silently creates
#    and populates the wrong database instead of erroring — this happened on
#    2026-07-19 (an empty "development" database got created inside
#    production-danceup). This script patches firebase.json to the correct
#    database for the target environment for the duration of the deploy, then
#    always restores it afterward (even on failure/interrupt), so the repo's
#    checked-in firebase.json never has to be hand-edited per deploy.
#
# 2. `firebase deploy --only functions` resets each function's Cloud Run
#    revision, which wipes FIREBASE_WEB_API_KEY — it was only ever set via a
#    manual `gcloud run services update`, so Firebase's own deploy pipeline
#    doesn't know about it and doesn't preserve it. Forgetting to re-set it
#    breaks login and Google/Apple sign-in silently. This script re-sets it
#    automatically after any deploy that touches functions.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIREBASE_JSON="$SCRIPT_DIR/firebase.json"

ENV="$1"
shift || true

case "$ENV" in
  dev)
    PROJECT="dev-danceup"
    DATABASE="development"
    API_KEY="AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY"
    ;;
  staging)
    PROJECT="staging-danceup"
    DATABASE="staging"
    API_KEY="AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8"
    ;;
  production)
    PROJECT="production-danceup"
    DATABASE="(default)"
    API_KEY="AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec"
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

# Re-set FIREBASE_WEB_API_KEY whenever this deploy touched functions (no
# --only at all means a full deploy, which includes functions).
NEEDS_ENV_FIX=false
if [ "$#" -eq 0 ]; then
  NEEDS_ENV_FIX=true
else
  for arg in "$@"; do
    if [[ "$arg" == *functions* ]]; then
      NEEDS_ENV_FIX=true
    fi
  done
fi

if [ "$NEEDS_ENV_FIX" = true ]; then
  echo "🔑 Re-setting FIREBASE_WEB_API_KEY on auth/usersstudent (wiped by every functions deploy)..."
  for func in auth usersstudent; do
    gcloud run services update "$func" \
      --project="$PROJECT" \
      --region=us-central1 \
      --update-env-vars FIREBASE_WEB_API_KEY="$API_KEY" \
      --quiet
  done
  echo "✓ FIREBASE_WEB_API_KEY set for $ENV"
fi
