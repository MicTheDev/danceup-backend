# Fix: Service Account Token Creator for Compute Service Account

## The Problem

Your Cloud Function is using the **compute service account**: `988466211229-compute@developer.gserviceaccount.com`

This service account needs the "Service Account Token Creator" role **on itself** to create custom tokens.

## Solution: Grant Service Account Token Creator Role

### Step 1: Go to Service Accounts

1. Go to [Service Accounts - dev-danceup](https://console.cloud.google.com/iam-admin/serviceaccounts?project=dev-danceup)

### Step 2: Find the Compute Service Account

1. Look for: `988466211229-compute@developer.gserviceaccount.com`
   - It might be named "Compute Engine default service account" or similar
   - The number `988466211229` is your project number

### Step 3: Grant the Role

**Option A: Via Service Accounts Page (Recommended)**

1. **Click on the service account** (not the edit icon)
2. Go to the **"Permissions"** tab
3. Click **"GRANT ACCESS"**
4. In **"New principals"**, enter:
   ```
   988466211229-compute@developer.gserviceaccount.com
   ```
5. In **"Select a role"**, choose: **"Service Account Token Creator"**
6. Click **"SAVE"**

**Option B: Via IAM Page**

1. Go to [IAM & Admin → IAM](https://console.cloud.google.com/iam-admin/iam?project=dev-danceup)
2. Find: `988466211229-compute@developer.gserviceaccount.com`
3. Click the **pencil icon (Edit)**
4. Click **"ADD ANOTHER ROLE"**
5. Select **"Service Account Token Creator"**
6. Click **"SAVE"**

## Why This Works

The compute service account is what your Cloud Function uses by default. When Firebase Admin SDK tries to create a custom token, it needs the `iam.serviceAccounts.signBlob` permission, which is included in the "Service Account Token Creator" role. The service account needs this role on itself.

## Verify the Fix

1. Wait 1-2 minutes for permissions to propagate
2. Try registering a new account
3. The error should be resolved

## For Other Environments

For staging and production, find the compute service account in the same way:
- Check the function logs or Cloud Function configuration
- Look for: `<project-number>-compute@developer.gserviceaccount.com`
- Grant the same role to that service account







