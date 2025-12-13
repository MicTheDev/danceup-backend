# Getting Firebase Auth Hash Parameters

To get the correct hash parameters for password import, you need to retrieve them from the Firebase Console:

## Steps:

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select the **dev-danceup** project (source project)
3. Navigate to **Authentication** > **Users** tab
4. Click the **three-dot menu** (⋮) above the user list
5. Select **Password Hash Parameters**
6. Note down the following values:
   - **Algorithm**: Should be `SCRYPT`
   - **Base64 signer key**: This is the hash key
   - **Base64 salt separator**: This is the salt separator
   - **Rounds**: Usually `8`
   - **Memory cost**: Usually `14`

## Alternative: Use Identity Platform API

You can also get these via the Identity Platform API or Firebase Admin SDK, but the Console method is the easiest.

Once you have these values, use them in the import command:

```bash
firebase auth:import auth-export/users.json \
  --project staging-danceup \
  --hash-algo=SCRYPT \
  --hash-key=<base64_signer_key_from_console> \
  --salt-separator=<base64_salt_separator_from_console> \
  --rounds=8 \
  --mem-cost=14
```




