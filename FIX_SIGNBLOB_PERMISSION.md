# Fix: Permission 'iam.serviceAccounts.signBlob' denied

## The Problem

When creating custom tokens, Firebase Admin SDK needs the `iam.serviceAccounts.signBlob` permission. This error occurs because the Cloud Function's service account doesn't have the necessary permissions.

## Solution: Grant Service Account Token Creator Role

The App Engine default service account needs the "Service Account Token Creator" role **on itself**.

### Step-by-Step Fix for dev-danceup:

1. **Go to IAM & Admin → Service Accounts** (not IAM):
   - [Dev Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=dev-danceup)
   - [Staging Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=staging-danceup)
   - [Production Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=production-danceup)

2. **Find the App Engine default service account**:
   - Look for: `dev-danceup@appspot.gserviceaccount.com`
   - It should be named "App Engine default service account"

3. **Click on the service account** (not the edit icon)

4. **Go to the "Permissions" tab**

5. **Click "GRANT ACCESS"**

6. **In "New principals"**, enter the same service account email:
   - `dev-danceup@appspot.gserviceaccount.com`

7. **In "Select a role"**, choose: **"Service Account Token Creator"**

8. **Click "SAVE"**

### Alternative: Using IAM Page

1. Go to [IAM & Admin → IAM](https://console.cloud.google.com/iam-admin/iam?project=dev-danceup)

2. Find: `dev-danceup@appspot.gserviceaccount.com`

3. Click the **pencil icon (Edit)**

4. Click **"ADD ANOTHER ROLE"**

5. Select **"Service Account Token Creator"**

6. **Important**: Make sure the principal is `dev-danceup@appspot.gserviceaccount.com` (the service account itself)

7. Click **"SAVE"**

## Why This Works

The service account needs permission to sign blobs on itself. When Firebase Admin SDK creates a custom token, it uses the service account's private key to sign a JWT. The `iam.serviceAccounts.signBlob` permission allows the service account to perform this operation on itself.

## Verify the Fix

After granting the role:

1. Wait 1-2 minutes for permissions to propagate
2. Try registering a new account
3. Check the function logs to confirm the service account being used

## If It Still Doesn't Work

If you've granted the role and it still doesn't work, check:

1. **Which service account is actually being used**:
   - Check the Cloud Function logs
   - Look for: "Function service account (likely):"

2. **Grant the role to the correct service account**:
   - For 2nd gen functions, it's usually: `<project-id>@appspot.gserviceaccount.com`
   - But it could also be: `<number>-compute@developer.gserviceaccount.com`

3. **Ensure the role is granted correctly**:
   - The service account must have the role on itself
   - Check IAM → IAM to verify the role is listed

## Alternative Solution: Use Firebase Admin SDK Service Account

Instead of using the App Engine service account, you can explicitly initialize Firebase Admin with the Firebase Admin SDK service account credentials. This requires:

1. Setting the service account JSON as an environment variable or secret
2. Initializing Firebase Admin with explicit credentials

This approach is more secure but requires additional configuration.






