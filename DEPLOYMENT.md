# Firebase Deployment Guide

## Use `./deploy.sh` — not raw `firebase deploy`

```bash
./deploy.sh <dev|staging|production> [firebase deploy args...]
```

Examples:

```bash
./deploy.sh production --only functions
./deploy.sh production --only firestore:indexes
./deploy.sh staging --only functions,firestore:indexes
./deploy.sh dev
```

This wraps `firebase deploy` and automatically handles two things that are
easy to get wrong by hand and have both caused real production issues:

1. **Firestore database targeting.** `firebase.json` only has a single
   hardcoded `firestore.database` value. Each environment's actual database
   has a different name, and deploying rules/indexes with the wrong one
   doesn't error — it silently creates and populates the wrong database:

   | Environment | Project             | Firestore database |
   |-------------|----------------------|---------------------|
   | dev         | `dev-danceup`        | `development`       |
   | staging     | `staging-danceup`    | `staging`            |
   | production  | `production-danceup` | `(default)`          |

   `deploy.sh` patches `firebase.json` to the right value for the target
   environment before deploying, then always restores it afterward (even on
   failure). You should never need to hand-edit `firebase.json`'s database
   field.

2. **`FIREBASE_WEB_API_KEY`.** This env var is required by the `auth` and
   `usersstudent` functions (used for login, registration, and Google/Apple
   sign-in — anything that calls `exchangeCustomTokenForIdToken`). It is
   **not** part of Firebase's own function config — it was only ever set via
   a manual `gcloud run services update --update-env-vars`, so every
   `firebase deploy --only functions` creates a fresh Cloud Run revision
   that **wipes it**, with no error or warning. `deploy.sh` re-sets it
   automatically after any deploy that touches functions.

   Current keys per environment (Firebase's own Web API key for each
   project — verify with `firebase apps:sdkconfig WEB <webAppId> --project
   <project>` if these ever look wrong, don't just trust this doc):

   - `dev-danceup`: `AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY`
   - `staging-danceup`: `AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8`
   - `production-danceup`: `AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec`

## Verifying a deploy

After deploying functions, sanity-check the routes are actually live and
not returning stale/404 responses (deploys can succeed while the code
behavior is still wrong for unrelated reasons — verify, don't assume):

```bash
curl -X POST "https://us-central1-<project>.cloudfunctions.net/usersstudent/google-signin" \
  -H "Content-Type: application/json" -d '{"idToken":"test"}'
```

A `401` with `"Invalid or expired ... token"` means the route exists and
ran real verification logic. A `404` means the deploy didn't actually
include that route.

To confirm the API key restored correctly:

```bash
gcloud run services describe usersstudent --project=<project> --region=us-central1 \
  --format="get(spec.template.spec.containers[0].env)" | grep FIREBASE_WEB_API_KEY
```

## Manual fallback (only if `deploy.sh` can't be used)

If you must run `firebase deploy` directly, remember to do both of these
extra steps yourself:

```bash
# 1. Set the correct firestore.database value in firebase.json for your
#    target environment (see table above), deploy, then set it back to
#    "development" afterward.
firebase deploy --project <project> --only functions

# 2. Re-set FIREBASE_WEB_API_KEY (wiped by the functions deploy above)
bash scripts/set-env-vars-after-deploy.sh   # uses whatever `firebase use` is currently active
```

### Troubleshooting

If you see "Configuration Error" or "Server configuration error" on
login/sign-in, or social sign-in silently fails after a functions deploy,
`FIREBASE_WEB_API_KEY` is almost certainly missing. Check with the
`gcloud run services describe` command above, and re-run `./deploy.sh
<env>` (or the manual step 2 above) to fix it. Allow 1-2 minutes for the
change to propagate.
