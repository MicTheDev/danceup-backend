# Firebase Functions Deployment Guide

## Important: Environment Variables

After deploying Firebase Functions, you **must** set the `FIREBASE_WEB_API_KEY` environment variable for functions that require it.

### Functions Requiring FIREBASE_WEB_API_KEY

- `auth` - Used for login/authentication
- `usersstudent` - Used for student user operations

### Setting Environment Variables After Deployment

After running `firebase deploy --only functions`, run:

```bash
bash scripts/set-env-vars-after-deploy.sh
```

This script will automatically:
1. Detect the current Firebase project (dev-danceup, staging-danceup, or production-danceup)
2. Set the appropriate API key for that environment
3. Update both `auth` and `usersstudent` functions

### Manual Setup

If you need to set environment variables manually:

```bash
# For dev environment
gcloud run services update auth --project=dev-danceup --region=us-central1 \
  --update-env-vars FIREBASE_WEB_API_KEY=AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY

gcloud run services update usersstudent --project=dev-danceup --region=us-central1 \
  --update-env-vars FIREBASE_WEB_API_KEY=AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY
```

### API Keys by Environment

- **dev-danceup**: `AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY`
- **staging-danceup**: `AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8`
- **production-danceup**: `AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec`

### Complete Deployment Workflow

1. Deploy functions:
   ```bash
   firebase deploy --only functions
   ```

2. Set environment variables:
   ```bash
   bash scripts/set-env-vars-after-deploy.sh
   ```

3. Verify deployment:
   - Test login functionality in the studio-owners-app
   - Check function logs if issues occur

### Troubleshooting

If you see "Configuration Error" or "Server configuration error" when logging in:

1. Verify the environment variable is set:
   ```bash
   gcloud run services describe auth --project=dev-danceup --region=us-central1 \
     --format="get(spec.template.spec.containers[0].env)"
   ```

2. If not set, run the setup script again:
   ```bash
   bash scripts/set-env-vars-after-deploy.sh
   ```

3. Wait 1-2 minutes for the update to propagate, then test again.
