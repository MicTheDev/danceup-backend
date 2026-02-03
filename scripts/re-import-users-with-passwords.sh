#!/bin/bash

# Script to re-import Firebase Auth users with password hashes
# 
# Prerequisites:
# 1. Get hash parameters from Firebase Console:
#    - Go to: https://console.firebase.google.com/project/dev-danceup/authentication/users
#    - Click three-dot menu (⋮) > "Password Hash Parameters"
#    - Copy: Base64 signer key, Base64 salt separator, Rounds, Memory cost
#
# 2. Set the variables below with the values from the console

# Hash parameters from Firebase Console
HASH_KEY="SuYuMnlxXTJQoiOk7U+THB2dYRZK9XnQMdE4oKW83hrl8NnRNLnp+qp/Uu4R1GuxdKQAq2YTTa7gj/7kFrXYjw=="
SALT_SEPARATOR="Bw=="
ROUNDS=8
MEM_COST=14

# Project configuration
SOURCE_PROJECT="dev-danceup"
DEST_PROJECT="staging-danceup"
EXPORT_FILE="auth-export/users.json"

# Check if hash parameters are set
if [[ "$HASH_KEY" == "<PASTE_BASE64_SIGNER_KEY_HERE>" ]] || [[ "$SALT_SEPARATOR" == "<PASTE_BASE64_SALT_SEPARATOR_HERE>" ]]; then
  echo "❌ Error: Please set HASH_KEY and SALT_SEPARATOR with values from Firebase Console"
  echo ""
  echo "To get the values:"
  echo "1. Go to: https://console.firebase.google.com/project/dev-danceup/authentication/users"
  echo "2. Click the three-dot menu (⋮) above the user list"
  echo "3. Select 'Password Hash Parameters'"
  echo "4. Copy 'Base64 signer key' to HASH_KEY"
  echo "5. Copy 'Base64 salt separator' to SALT_SEPARATOR"
  exit 1
fi

# Check if export file exists
if [ ! -f "$EXPORT_FILE" ]; then
  echo "❌ Error: Export file not found: $EXPORT_FILE"
  echo "Please export users first:"
  echo "  firebase auth:export $EXPORT_FILE --project $SOURCE_PROJECT"
  exit 1
fi

# Switch to destination project
echo "Switching to $DEST_PROJECT..."
firebase use $DEST_PROJECT

# Re-import users with hash parameters
echo "Re-importing users with password hashes..."
firebase auth:import "$EXPORT_FILE" \
  --project $DEST_PROJECT \
  --hash-algo=SCRYPT \
  --hash-key="$HASH_KEY" \
  --salt-separator="$SALT_SEPARATOR" \
  --rounds=$ROUNDS \
  --mem-cost=$MEM_COST

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Users imported successfully with password hashes!"
  echo "Users should now be able to log in with their original passwords."
else
  echo ""
  echo "❌ Import failed. Please check the error message above."
  exit 1
fi



