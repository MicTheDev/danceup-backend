# Fix 403 "caller does not have permission" when deploying functions

The error happens because the Firebase CLI calls the **Firebase Extensions API** during deploy, and your account or project doesn't have permission to list extension instances.

## Fix in Google Cloud Console (dev-danceup)

### 1. Enable the Firebase Extensions API

1. Open: [Enable Firebase Extensions API](https://console.cloud.google.com/apis/library/firebaseextensions.googleapis.com?project=dev-danceup)
2. Select project **dev-danceup** (top bar).
3. Click **Enable**.

### 2. Grant your account permission to use Extensions

1. Open: [IAM & Admin – dev-danceup](https://console.cloud.google.com/iam-admin/iam?project=dev-danceup)
2. Find your account (the one you use for `firebase login`).
3. If you already have **Owner** or **Editor**, you’re done. Otherwise:
   - Click **Grant access** (or edit your user).
   - Add role **Firebase Admin** (`roles/firebase.admin`), **or**
   - Add role **Firebase Extensions Viewer** (`roles/firebaseextensions.viewer`) – beta role that includes `firebaseextensions.instances.list`.

If you’re not a project owner, ask one to enable the API and add one of these roles for your account.

### 3. Deploy again

```bash
cd danceup-backend && firebase deploy --only functions:marketing
```
