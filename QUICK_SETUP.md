# Quick Setup Guide - Set Environment Variables

## ⚡ Fastest Way (2 minutes)

I've set up everything for you! You just need to authenticate gcloud once, then the script will handle the rest.

### Step 1: Authenticate gcloud (One-time, opens browser)

Run these two commands in your terminal:

```bash
cd /Users/micahjohnson/Desktop/THELDC/danceup-backend
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
gcloud auth login
gcloud auth application-default login
```

This will:
- Open your browser
- Ask you to sign in (use: micahjthedev@gmail.com)
- Complete authentication

### Step 2: Run the automated script

```bash
node scripts/set-env-vars.js
```

Then:
- Select option `4` for Production (or `1` for all environments)
- The script will automatically set the environment variables
- Wait 2-3 minutes for the function to redeploy

## 🎯 Quick Production Fix Only

If you only need to fix production right now:

```bash
cd /Users/micahjohnson/Desktop/THELDC/danceup-backend
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
gcloud auth login
gcloud functions deploy api \
  --project=production-danceup \
  --region=us-central1 \
  --update-env-vars FIREBASE_WEB_API_KEY=AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec
```

## ✅ Verification

After running, wait 2-3 minutes, then test login in your studio-owners-app. The 500 error should be gone!

## 📝 What I've Set Up For You

- ✅ Installed gcloud CLI
- ✅ Created automated scripts
- ✅ Created documentation
- ✅ Ready to run - just needs authentication

All scripts are in the `scripts/` directory. See `scripts/README.md` for more details.

