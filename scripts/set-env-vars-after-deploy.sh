#!/bin/bash

# Script to set FIREBASE_WEB_API_KEY environment variable after deploying functions
# This should be run after: firebase deploy --only functions

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Get current Firebase project
PROJECT=$(firebase use 2>&1 | tail -1 | awk '{print $NF}' | tr -d '()' || echo "")

if [ -z "$PROJECT" ]; then
    echo -e "${RED}Error: Could not determine Firebase project.${NC}"
    echo "Please run: firebase use <project>"
    exit 1
fi

# API Keys for each environment
case "$PROJECT" in
    "dev-danceup")
        API_KEY="AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY"
        ;;
    "staging-danceup")
        API_KEY="AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8"
        ;;
    "production-danceup")
        API_KEY="AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec"
        ;;
    *)
        echo -e "${RED}Error: Unknown project: $PROJECT${NC}"
        exit 1
        ;;
esac

REGION="us-central1"

# Functions that need FIREBASE_WEB_API_KEY
FUNCTIONS=("auth" "usersstudent")

echo -e "${GREEN}Setting FIREBASE_WEB_API_KEY for project: ${PROJECT}${NC}"
echo ""

for func in "${FUNCTIONS[@]}"; do
    echo -e "${YELLOW}Updating ${func}...${NC}"
    if gcloud run services update ${func} \
        --project=${PROJECT} \
        --region=${REGION} \
        --update-env-vars FIREBASE_WEB_API_KEY=${API_KEY} \
        --quiet 2>&1 | grep -q "Done"; then
        echo -e "${GREEN}✓ Successfully set FIREBASE_WEB_API_KEY for ${func}${NC}"
    else
        echo -e "${RED}✗ Failed to set environment variable for ${func}${NC}"
    fi
    echo ""
done

echo -e "${GREEN}✓ Environment variables set!${NC}"
echo "You can now test the login functionality."
