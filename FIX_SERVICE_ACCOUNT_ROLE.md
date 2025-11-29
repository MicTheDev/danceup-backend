# Fix: Service Account Token Creator Role for Firebase Admin SDK

## The Problem

Your logs show: "Firebase Admin using explicit service account credentials"

This means Firebase Admin is using the service account from the `FIREBASE_SERVICE_ACCOUNT` environment variable. This service account needs the "Service Account Token Creator" role **on itself** to create custom tokens.

## Step 1: Find the Service Account Email

The service account email is logged when the function starts. Check the logs:

```bash
firebase functions:log --project dev
```

Look for: "Service account email: firebase-adminsdk-xxxxx@dev-danceup.iam.gserviceaccount.com"

Or check the `FIREBASE_SERVICE_ACCOUNT` environment variable in Google Cloud Console:
1. Go to [Cloud Functions](https://console.cloud.google.com/functions/list?project=dev-danceup)
2. Click on the `api` function
3. Go to "Configuration" tab
4. Scroll to "Runtime environment variables"
5. Find `FIREBASE_SERVICE_ACCOUNT`
6. The `client_email` field in the JSON is the service account email

## Step 2: Grant the Role

### Option A: Via Service Accounts Page (Recommended)

1. Go to [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=dev-danceup)

2. Find your Firebase Admin SDK service account:
   - Look for: `firebase-adminsdk-xxxxx@dev-danceup.iam.gserviceaccount.com`
   - It should be named something like "Firebase Admin SDK Administrator Service Agent"

3. **Click on the service account** (not the edit icon)

4. Go to the **"Permissions"** tab

5. Click **"GRANT ACCESS"**

6. In **"New principals"**, enter the **same service account email**:
   ```
   firebase-adminsdk-xxxxx@dev-danceup.iam.gserviceaccount.com
   ```
   (Replace xxxxx with your actual service account ID)

7. In **"Select a role"**, choose: **"Service Account Token Creator"**

8. Click **"SAVE"**

### Option B: Via IAM Page

1. Go to [IAM & Admin → IAM](https://console.cloud.google.com/iam-admin/iam?project=dev-danceup)

2. Find your Firebase Admin SDK service account:
   - `firebase-adminsdk-xxxxx@dev-danceup.iam.gserviceaccount.com`

3. Click the **pencil icon (Edit)**

4. Click **"ADD ANOTHER ROLE"**

5. Select **"Service Account Token Creator"**

6. **Important**: The principal should be the same service account (itself)

7. Click **"SAVE"**

## Why This Works

When creating custom tokens, Firebase Admin SDK needs to sign a JWT using the service account's private key. The `iam.serviceAccounts.signBlob` permission allows the service account to perform this operation on itself. This is why the service account needs the "Service Account Token Creator" role on itself.

## Verify the Fix

1. Wait 1-2 minutes for permissions to propagate
2. Try registering a new account
3. Check the logs - you should see the service account email logged
4. The error should be gone

## For All Environments

Repeat these steps for:
- **Staging**: `staging-danceup`
- **Production**: `production-danceup`

Make sure to grant the role to the correct service account for each environment.

