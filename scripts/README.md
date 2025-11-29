# Setting Environment Variables for Firebase Functions

This directory contains scripts to help set the `FIREBASE_WEB_API_KEY` environment variable for your Firebase Functions.

## Quick Start

### Option 1: Automated Script (Recommended)

1. **Authenticate with gcloud** (one-time setup):
   ```bash
   export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
   gcloud auth login
   gcloud auth application-default login
   ```

2. **Run the setup script**:
   ```bash
   cd /Users/micahjohnson/Desktop/THELDC/danceup-backend
   node scripts/set-env-vars.js
   ```

   The script will:
   - Check if gcloud is installed
   - Verify authentication
   - Let you choose which environments to update
   - Set the `FIREBASE_WEB_API_KEY` for the selected environments

### Option 2: Manual Commands

If you prefer to run commands manually, use these:

```bash
# Make sure gcloud is in your PATH
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"

# For Production
gcloud functions deploy api \
  --project=production-danceup \
  --region=us-central1 \
  --update-env-vars FIREBASE_WEB_API_KEY=AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec

# For Staging
gcloud functions deploy api \
  --project=staging-danceup \
  --region=us-central1 \
  --update-env-vars FIREBASE_WEB_API_KEY=AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8

# For Dev
gcloud functions deploy api \
  --project=dev-danceup \
  --region=us-central1 \
  --update-env-vars FIREBASE_WEB_API_KEY=AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY
```

**Note**: The `--update-env-vars` flag will add or update the `FIREBASE_WEB_API_KEY` while preserving any existing environment variables.

### Option 3: Google Cloud Console (GUI)

1. Go to [Google Cloud Console - Cloud Functions](https://console.cloud.google.com/functions)
2. Select the project (dev-danceup, staging-danceup, or production-danceup)
3. Click on the `api` function
4. Click **"EDIT"** at the top
5. Scroll to **"Runtime environment variables"**
6. Click **"ADD VARIABLE"**
7. Add:
   - **Name**: `FIREBASE_WEB_API_KEY`
   - **Value**: Use the appropriate API key:
     - Production: `AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec`
     - Staging: `AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8`
     - Dev: `AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY`
8. Click **"DEPLOY"** to save

## API Keys Reference

- **Development**: `AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY`
- **Staging**: `AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8`
- **Production**: `AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec`

## Troubleshooting

### "gcloud: command not found"

Install gcloud CLI:
```bash
brew install --cask google-cloud-sdk
```

Then add it to your PATH:
```bash
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
```

Add this to your `~/.zshrc` to make it permanent:
```bash
echo 'export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"' >> ~/.zshrc
```

### "You do not currently have an active account selected"

Authenticate with gcloud:
```bash
gcloud auth login
gcloud auth application-default login
```

### Function not found

Make sure the function is deployed first:
```bash
cd /Users/micahjohnson/Desktop/THELDC/danceup-backend
firebase deploy --only functions --project production
```

## Verification

After setting the environment variable, verify it was set correctly:

```bash
gcloud functions describe api \
  --project=production-danceup \
  --region=us-central1 \
  --format="value(environmentVariables)"
```

You should see `FIREBASE_WEB_API_KEY=AIzaSy...` in the output.

## What Happens After Setting

Once the environment variable is set:
1. The function will be automatically redeployed (this takes 1-3 minutes)
2. After deployment completes, login should work without the 500 error
3. You can test by attempting to login in the studio-owners-app

