#!/bin/bash

# Script to set FIREBASE_WEB_API_KEY environment variable for all Firebase Functions
# This script sets the environment variable for the current Firebase project

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get current Firebase project
PROJECT=$(firebase use 2>&1 | grep -E '^\s+\w' | head -1 | awk '{print $NF}' || echo "")

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
        echo "Please set the API key manually for this project."
        exit 1
        ;;
esac

REGION="us-central1"

# Functions that need FIREBASE_WEB_API_KEY
FUNCTIONS=("auth" "usersstudent")

echo -e "${GREEN}Setting FIREBASE_WEB_API_KEY for project: ${PROJECT}${NC}"
echo -e "${YELLOW}API Key: ${API_KEY:0:20}...${NC}"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}Error: gcloud CLI is not installed.${NC}"
    exit 1
fi

# Function to set environment variable for a function
set_env_for_function() {
    local func_name=$1
    local project=$2
    local api_key=$3
    local region=$4
    
    echo -e "${YELLOW}Setting environment variable for ${func_name}...${NC}"
    
    # Get existing environment variables
    EXISTING_VARS=$(gcloud functions describe ${func_name} --project=${project} --region=${region} --gen2 --format="value(serviceConfig.environmentVariables)" 2>/dev/null || echo "")
    
    if [ -z "$EXISTING_VARS" ] || [ "$EXISTING_VARS" = "None" ]; then
        ENV_VARS="FIREBASE_WEB_API_KEY=${api_key}"
    else
        # Parse and update existing vars
        ENV_VARS="${EXISTING_VARS},FIREBASE_WEB_API_KEY=${api_key}"
        # Remove any existing FIREBASE_WEB_API_KEY first
        ENV_VARS=$(echo "$ENV_VARS" | sed 's/FIREBASE_WEB_API_KEY=[^,]*//g' | sed 's/,,*/,/g' | sed 's/^,//' | sed 's/,$//')
        ENV_VARS="${ENV_VARS},FIREBASE_WEB_API_KEY=${api_key}"
    fi
    
    # Update the function with new environment variables using Firebase CLI
    # We need to use gcloud to update env vars for gen2 functions
    if gcloud functions deploy ${func_name} \
        --project=${project} \
        --region=${region} \
        --gen2 \
        --update-env-vars ${ENV_VARS} \
        --source=functions \
        --quiet 2>&1 | grep -q "Successfully"; then
        echo -e "${GREEN}✓ Successfully set FIREBASE_WEB_API_KEY for ${func_name}${NC}"
        return 0
    else
        echo -e "${RED}✗ Failed to set environment variable for ${func_name}${NC}"
        echo -e "${YELLOW}Note: You may need to redeploy the function first using: firebase deploy --only functions:${func_name}${NC}"
        return 1
    fi
}

# Set environment variables for each function
SUCCESS_COUNT=0
for func in "${FUNCTIONS[@]}"; do
    if set_env_for_function "$func" "$PROJECT" "$API_KEY" "$REGION"; then
        ((SUCCESS_COUNT++))
    fi
    echo ""
done

echo -e "${GREEN}✓ Completed: ${SUCCESS_COUNT}/${#FUNCTIONS[@]} functions updated${NC}"
echo ""
echo "The functions have been updated with the FIREBASE_WEB_API_KEY environment variable."
echo "Please test the login functionality to verify it's working."
