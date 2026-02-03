# Firebase Authentication User Migration Guide

This document describes the process for copying Firebase Authentication users from the `dev-danceup` project to the `staging-danceup` project using Firebase CLI commands.

## Overview

The migration process involves:
1. Exporting all Firebase Authentication users from the source project
2. Importing the exported users into the destination project
3. Verifying the import was successful (user counts and UIDs)

**Important**: This process will **overwrite** existing users with matching email addresses in the destination project. User UIDs are preserved during the import.

## Prerequisites

### 1. Install and Authenticate Firebase CLI

Ensure you have the Firebase CLI installed and authenticated:

```bash
# Check if Firebase CLI is installed
which firebase
firebase --version

# Authenticate (if not already done)
firebase login
```

### 2. Verify Project Access

Verify you have access to both projects:

```bash
# List accessible projects
firebase projects:list

# Switch to source project
firebase use dev-danceup

# Switch to destination project
firebase use staging-danceup
```

### 3. Required Permissions

You need the following IAM roles:
- **Source Project (dev-danceup)**: `roles/firebase.admin` or `roles/identityplatform.admin`
- **Destination Project (staging-danceup)**: `roles/firebase.admin` or `roles/identityplatform.admin`

### 4. Create Export Directory

Create a directory to store the export file:

```bash
mkdir -p auth-export
```

## Step-by-Step Migration Process

### Step 1: Export Users from Development

Export all users from the `dev-danceup` project:

```bash
# Switch to source project
firebase use dev-danceup

# Export users to JSON file
firebase auth:export auth-export/users.json --project dev-danceup
```

**Output**: The command will create a JSON file containing all user accounts with:
- User UIDs (`localId`)
- Email addresses
- Password hashes and salts (if available)
- Display names and photos
- Provider information (OAuth providers)
- Custom claims
- Metadata (creation time, last sign-in, etc.)

**Note**: The export file contains sensitive information (password hashes). Keep it secure and delete it after migration.

### Step 2: Import Users into Staging

Import the exported users into the `staging-danceup` project:

```bash
# Switch to destination project
firebase use staging-danceup

# Import users from JSON file
firebase auth:import auth-export/users.json --project staging-danceup
```

**Important Notes**:
- **UID Preservation**: User UIDs (`localId`) are automatically preserved during import
- **Password Hashes**: If you see a warning about "No hash algorithm specified", password users may not be imported with their passwords. See the [Password Handling](#password-handling) section below.
- **Overwrite Behavior**: Users with matching email addresses will be overwritten
- **OAuth Providers**: OAuth provider accounts (Google, Facebook, etc.) are preserved

### Step 3: Verify Import

Verify that users were imported correctly:

```bash
# Export users from staging to verify
firebase auth:export auth-export/staging-users.json --project staging-danceup

# Compare user counts
jq '.users | length' auth-export/users.json        # Source count
jq '.users | length' auth-export/staging-users.json # Destination count

# Verify UIDs match
jq -r '.users[] | "\(.localId) - \(.email)"' auth-export/users.json
jq -r '.users[] | "\(.localId) - \(.email)"' auth-export/staging-users.json
```

The UIDs and email addresses should match between source and destination.

### Step 4: Test Authentication (Optional)

Test that users can authenticate in the staging environment:

1. Try logging in with a test account
2. Verify user profile data is correct
3. Check that OAuth providers work (if applicable)

### Step 5: Cleanup (Recommended)

After verifying the import, delete the export files containing sensitive data:

```bash
# Remove export directory
rm -rf auth-export
```

**Security Note**: The export files contain password hashes and other sensitive information. Always delete them after migration is complete.

## Complete Example Script

Here's a complete script that automates the entire process:

```bash
#!/bin/bash

# Configuration
SOURCE_PROJECT="dev-danceup"
DEST_PROJECT="staging-danceup"
EXPORT_DIR="auth-export"
EXPORT_FILE="$EXPORT_DIR/users.json"
STAGING_EXPORT_FILE="$EXPORT_DIR/staging-users.json"

# Create export directory
mkdir -p $EXPORT_DIR

# Export users from source
echo "Exporting users from $SOURCE_PROJECT..."
firebase use $SOURCE_PROJECT
firebase auth:export $EXPORT_FILE --project $SOURCE_PROJECT

# Get user count
SOURCE_COUNT=$(jq '.users | length' $EXPORT_FILE)
echo "Exported $SOURCE_COUNT user(s) from $SOURCE_PROJECT"

# Import users to destination
echo "Importing users into $DEST_PROJECT..."
firebase use $DEST_PROJECT
firebase auth:import $EXPORT_FILE --project $DEST_PROJECT

# Verify import
echo "Verifying import..."
firebase auth:export $STAGING_EXPORT_FILE --project $DEST_PROJECT
DEST_COUNT=$(jq '.users | length' $STAGING_EXPORT_FILE)
echo "Imported $DEST_COUNT user(s) into $DEST_PROJECT"

# Compare UIDs
echo "Comparing UIDs..."
SOURCE_UIDS=$(jq -r '.users[].localId' $EXPORT_FILE | sort)
DEST_UIDS=$(jq -r '.users[].localId' $STAGING_EXPORT_FILE | sort)

if [ "$SOURCE_UIDS" == "$DEST_UIDS" ]; then
    echo "✅ UIDs match! Migration successful."
else
    echo "⚠️  UIDs do not match. Please verify manually."
fi

# Cleanup prompt
read -p "Delete export files? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf $EXPORT_DIR
    echo "Export files deleted."
fi
```

## Password Handling

### Warning About Password Hashes

When importing users, you may see this warning:

```
⚠  No hash algorithm specified. Password users cannot be imported.
```

This warning appears because Firebase Auth requires you to specify the hash algorithm when importing password-protected users. However, the import may still succeed for:
- Users without passwords (OAuth-only accounts)
- Users where the password hash format is recognized

### Options for Password Users

If password users are not imported correctly, you have several options:

#### Option 1: Specify Hash Algorithm (Recommended)

If you know the hash algorithm used, you can specify it during import:

```bash
firebase auth:import auth-export/users.json \
  --project staging-danceup \
  --hash-algorithm=SCRYPT \
  --hash-key=<base64-encoded-key> \
  --salt-separator=<base64-encoded-separator> \
  --rounds=8 \
  --mem-cost=14
```

**Note**: You need to know the exact hash parameters used by Firebase Auth. These are typically:
- **Algorithm**: `SCRYPT`
- **Key**: Base64-encoded key (specific to your Firebase project)
- **Salt Separator**: Base64-encoded separator
- **Rounds**: 8
- **Memory Cost**: 14

#### Option 2: Users Reset Passwords

If you cannot preserve password hashes:
1. Users will need to use "Forgot Password" to reset their passwords
2. Or you can programmatically send password reset emails
3. Or use custom tokens for initial access

#### Option 3: Use Custom Tokens

Generate custom tokens for users to sign in initially:

```javascript
// Using Firebase Admin SDK
const admin = require('firebase-admin');
const customToken = await admin.auth().createCustomToken(uid);
```

## Troubleshooting

### Permission Denied Errors

If you encounter permission errors:

1. **Check IAM roles**: Ensure you have `roles/firebase.admin` or `roles/identityplatform.admin` on both projects
2. **Check project access**: Verify you can access both projects with `firebase projects:list`
3. **Re-authenticate**: Try `firebase login --reauth`

### Import Fails with "Invalid Format"

If the import fails:

1. **Check JSON format**: Ensure the export file is valid JSON
2. **Check file encoding**: The file should be UTF-8 encoded
3. **Verify export**: Re-export from source if the file appears corrupted

### Users Not Imported

If some users are missing after import:

1. **Check import warnings**: Review any warnings during import
2. **Check email conflicts**: Users with duplicate emails may be skipped
3. **Verify export**: Ensure all users were exported from source
4. **Check logs**: Review Firebase Console logs for import errors

### UIDs Don't Match

If UIDs don't match between source and destination:

1. **Re-import**: Delete users in staging and re-import
2. **Check export file**: Verify the export file contains the correct UIDs
3. **Manual verification**: Compare UIDs manually using the verification commands

### Password Users Can't Sign In

If users can't sign in after migration:

1. **Check password hash warning**: Review import warnings about password hashes
2. **Use password reset**: Have users reset their passwords
3. **Use custom tokens**: Generate custom tokens for initial access
4. **Specify hash algorithm**: Re-import with correct hash algorithm parameters

## Important Notes

1. **UID Preservation**: User UIDs are automatically preserved during import. This is critical for maintaining relationships with Firestore documents that reference user UIDs.

2. **Email Uniqueness**: Each email address can only be associated with one user account. If a user with the same email exists in staging, it will be overwritten.

3. **Password Hashes**: Password hashes may not be directly transferable without specifying the hash algorithm. Users may need to reset passwords.

4. **OAuth Providers**: OAuth provider accounts (Google, Facebook, etc.) are preserved during import.

5. **Custom Claims**: Custom claims are preserved in the export/import process.

6. **User Metadata**: Display names, photos, and other metadata are preserved.

7. **Security**: Export files contain sensitive information (password hashes). Always:
   - Store export files securely
   - Delete export files after migration
   - Never commit export files to version control

8. **Time Considerations**: Large user bases (1000+ users) may take several minutes to export and import.

9. **Rate Limits**: Firebase Auth has rate limits. Very large imports may need to be done in batches.

## Export File Format

The export file is a JSON file with the following structure:

```json
{
  "users": [
    {
      "localId": "user-uid-here",
      "email": "user@example.com",
      "emailVerified": true,
      "passwordHash": "base64-encoded-hash",
      "salt": "base64-encoded-salt",
      "displayName": "User Name",
      "photoUrl": "https://...",
      "lastSignedInAt": "1234567890",
      "createdAt": "1234567890",
      "disabled": false,
      "providerUserInfo": [
        {
          "providerId": "google.com",
          "federatedId": "google-user-id",
          "email": "user@gmail.com",
          "displayName": "User Name",
          "photoUrl": "https://..."
        }
      ],
      "customClaims": {
        "role": "admin"
      }
    }
  ]
}
```

## Related Documentation

- [Firebase Auth Export/Import Documentation](https://firebase.google.com/docs/auth/admin/import-users)
- [Firebase CLI Auth Commands](https://firebase.google.com/docs/cli#auth-commands)
- [Firebase Admin SDK Auth](https://firebase.google.com/docs/auth/admin)
- [Password Hash Import](https://firebase.google.com/docs/auth/admin/import-users#import_users_with_hashed_passwords)

## Migration History

- **2025-12-04**: Initial migration from dev-danceup to staging-danceup
  - Source: `dev-danceup`
  - Destination: `staging-danceup`
  - Users exported: 7
  - Users imported: 7
  - UIDs preserved: ✅ Yes
  - Status: ✅ Completed successfully
  - Note: Password hash warning appeared but import succeeded. Users may need to reset passwords if they cannot sign in.




