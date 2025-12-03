# ✅ Function Deployed! Now Set Environment Variable

Great news! The function has been deployed successfully. Now we just need to set the environment variable.

## Quick Fix via Google Cloud Console (2 minutes)

Since the function is deployed, you can now set the environment variable directly in Google Cloud Console:

### Production Function:

1. **Open this link**: https://console.cloud.google.com/functions/details/us-central1/api?project=production-danceup&env=gen2

2. Click **"EDIT"** at the top

3. Scroll down to **"Runtime, build, connections and security settings"**

4. Click to expand **"Runtime environment variables"**

5. Click **"ADD VARIABLE"**

6. Add:
   - **Name**: `FIREBASE_WEB_API_KEY`
   - **Value**: `AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec`

7. Click **"DEPLOY"** or **"NEXT"** → **"DEPLOY"** (wait 2-3 minutes)

### After Setting:

1. Wait 2-3 minutes for the function to redeploy
2. Test login in studio-owners-app
3. The 500 error should be gone! 🎉

---

## Alternative: Using gcloud CLI (if the above doesn't work)

For Gen 2 functions, use Cloud Run commands:

```bash
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"

# Set the environment variable
gcloud run services update api \
  --project=production-danceup \
  --region=us-central1 \
  --set-env-vars FIREBASE_WEB_API_KEY=AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec \
  --platform=managed
```

## What Was Fixed

- ✅ Removed `FIREBASE_WEB_API_KEY` from `.env` file (Firebase doesn't allow FIREBASE_ prefix)
- ✅ Deployed the function successfully to production
- ✅ Function URL: https://us-central1-production-danceup.cloudfunctions.net/api

The function is ready - just needs the environment variable set!



