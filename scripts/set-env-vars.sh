#!/bin/bash

# Script to set FIREBASE_WEB_API_KEY environment variable for Firebase Functions
# This script sets the environment variable for dev, staging, and production environments

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# API Keys for each environment
DEV_API_KEY="AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY"
STAGING_API_KEY="AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8"
PROD_API_KEY="AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec"

# Function name and region
FUNCTION_NAME="api"
REGION="us-central1"

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}Error: gcloud CLI is not installed.${NC}"
    echo ""
    echo "Please install gcloud CLI using one of the following methods:"
    echo ""
    echo "Option 1: Install via Homebrew (macOS):"
    echo "  brew install --cask google-cloud-sdk"
    echo ""
    echo "Option 2: Install via installer script:"
    echo "  curl https://sdk.cloud.google.com | bash"
    echo "  exec -l \$SHELL"
    echo ""
    echo "After installing, run:"
    echo "  gcloud auth login"
    echo "  gcloud auth application-default login"
    echo ""
    exit 1
fi

# Check if user is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1 &> /dev/null; then
    echo -e "${YELLOW}Warning: You may not be authenticated with gcloud.${NC}"
    echo "Run: gcloud auth login"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo -e "${GREEN}Setting FIREBASE_WEB_API_KEY environment variable for all environments...${NC}"
echo ""

# Function to set environment variable
set_env_var() {
    local project=$1
    local api_key=$2
    local env_name=$3
    
    echo -e "${YELLOW}Setting environment variable for ${env_name} (${project})...${NC}"
    
    # Check if function exists
    if ! gcloud functions describe ${FUNCTION_NAME} --project=${project} --region=${REGION} &> /dev/null; then
        echo -e "${RED}Error: Function '${FUNCTION_NAME}' not found in project '${project}'.${NC}"
        echo "Make sure the function is deployed first."
        return 1
    fi
    
    # Get existing environment variables
    EXISTING_VARS=$(gcloud functions describe ${FUNCTION_NAME} --project=${project} --region=${REGION} --format="value(environmentVariables)" 2>/dev/null || echo "")
    
    if [ -z "$EXISTING_VARS" ]; then
        # No existing env vars, set new one
        ENV_VARS="FIREBASE_WEB_API_KEY=${api_key}"
    else
        # Parse existing vars and update/add FIREBASE_WEB_API_KEY
        ENV_VARS=$(echo "$EXISTING_VARS" | sed "s/FIREBASE_WEB_API_KEY=[^,;]*//g" | sed 's/,,*/,/g' | sed 's/^,//' | sed 's/,$//')
        if [ -n "$ENV_VARS" ]; then
            ENV_VARS="${ENV_VARS},FIREBASE_WEB_API_KEY=${api_key}"
        else
            ENV_VARS="FIREBASE_WEB_API_KEY=${api_key}"
        fi
    fi
    
    # Update the function with new environment variables
    if gcloud functions deploy ${FUNCTION_NAME} \
        --project=${project} \
        --region=${REGION} \
        --update-env-vars ${ENV_VARS} \
        --quiet 2>&1; then
        echo -e "${GREEN}✓ Successfully set FIREBASE_WEB_API_KEY for ${env_name}${NC}"
    else
        echo -e "${RED}✗ Failed to set environment variable for ${env_name}${NC}"
        return 1
    fi
    
    echo ""
}

# Ask which environments to update
echo "Which environments would you like to update?"
echo "1) All environments (dev, staging, production)"
echo "2) Dev only"
echo "3) Staging only"
echo "4) Production only"
echo "5) Custom selection"
read -p "Enter choice [1-5] (default: 1): " choice
choice=${choice:-1}

case $choice in
    1)
        set_env_var "dev-danceup" "$DEV_API_KEY" "Development"
        set_env_var "staging-danceup" "$STAGING_API_KEY" "Staging"
        set_env_var "production-danceup" "$PROD_API_KEY" "Production"
        ;;
    2)
        set_env_var "dev-danceup" "$DEV_API_KEY" "Development"
        ;;
    3)
        set_env_var "staging-danceup" "$STAGING_API_KEY" "Staging"
        ;;
    4)
        set_env_var "production-danceup" "$PROD_API_KEY" "Production"
        ;;
    5)
        read -p "Update dev? (y/n): " update_dev
        read -p "Update staging? (y/n): " update_staging
        read -p "Update production? (y/n): " update_prod
        
        if [[ $update_dev =~ ^[Yy]$ ]]; then
            set_env_var "dev-danceup" "$DEV_API_KEY" "Development"
        fi
        if [[ $update_staging =~ ^[Yy]$ ]]; then
            set_env_var "staging-danceup" "$STAGING_API_KEY" "Staging"
        fi
        if [[ $update_prod =~ ^[Yy]$ ]]; then
            set_env_var "production-danceup" "$PROD_API_KEY" "Production"
        fi
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo -e "${GREEN}✓ Environment variable setup complete!${NC}"
echo ""
echo "The functions are being redeployed with the new environment variables."
echo "Please wait a few minutes for the deployment to complete before testing."



