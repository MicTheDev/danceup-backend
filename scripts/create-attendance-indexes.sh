#!/bin/bash

# Script to create Firestore indexes for attendance collection
# Note: These commands may need to be run manually if there are database mode issues

echo "Creating Firestore indexes for attendance collection..."
echo ""
echo "If these commands fail, please use the Firebase Console:"
echo "https://console.firebase.google.com/project/dev-danceup/firestore/indexes"
echo ""

# Get access token
TOKEN=$(gcloud auth print-access-token 2>/dev/null)

if [ -z "$TOKEN" ]; then
    echo "Error: Could not get access token. Please run: gcloud auth login"
    exit 1
fi

# Create index 1: studentId + classId + classInstanceDate
echo "Creating index 1: studentId + classId + classInstanceDate..."
curl -X POST \
  "https://firestore.googleapis.com/v1/projects/dev-danceup/databases/(default)/collectionGroups/attendance/indexes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "queryScope": "COLLECTION",
    "fields": [
      {"fieldPath": "studentId", "order": "ASCENDING"},
      {"fieldPath": "classId", "order": "ASCENDING"},
      {"fieldPath": "classInstanceDate", "order": "ASCENDING"}
    ]
  }' 2>&1 | grep -E "(name|error|message)" || echo "Response received"

echo ""
echo "Creating index 2: studentId + workshopId + classInstanceDate..."
curl -X POST \
  "https://firestore.googleapis.com/v1/projects/dev-danceup/databases/(default)/collectionGroups/attendance/indexes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "queryScope": "COLLECTION",
    "fields": [
      {"fieldPath": "studentId", "order": "ASCENDING"},
      {"fieldPath": "workshopId", "order": "ASCENDING"},
      {"fieldPath": "classInstanceDate", "order": "ASCENDING"}
    ]
  }' 2>&1 | grep -E "(name|error|message)" || echo "Response received"

echo ""
echo "Creating index 3: studentId + eventId + classInstanceDate..."
curl -X POST \
  "https://firestore.googleapis.com/v1/projects/dev-danceup/databases/(default)/collectionGroups/attendance/indexes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "queryScope": "COLLECTION",
    "fields": [
      {"fieldPath": "studentId", "order": "ASCENDING"},
      {"fieldPath": "eventId", "order": "ASCENDING"},
      {"fieldPath": "classInstanceDate", "order": "ASCENDING"}
    ]
  }' 2>&1 | grep -E "(name|error|message)" || echo "Response received"

echo ""
echo ""
echo "Note: If the above commands failed, the easiest way is to:"
echo "1. Try to check in a student (which will trigger the index error)"
echo "2. Click the link in the error message to create the index automatically"
echo "3. Or create them manually in Firebase Console:"
echo "   https://console.firebase.google.com/project/dev-danceup/firestore/indexes"

