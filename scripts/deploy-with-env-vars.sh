#!/bin/bash

# Script to deploy Firebase Functions with FIREBASE_WEB_API_KEY environment variable set
# This script will deploy the functions if they don't exist, or update them with env vars if they do

set -e

export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# API Keys
DEV_API_KEY="AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY"
STAGING_API_KEY="AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8"
PROD_API_KEY="AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec"

FUNCTION_NAME="api"
REGION="us-central1"

cd "$(dirname "$0")/.."

echo -e "${GREEN}Deploying Firebase Functions with Environment Variables${NC}"
echo ""

# Function to deploy with env var
deploy_function() {
    local project=$1
    local api_key=$2
    local env_name=$3
    
    echo -e "${YELLOW}========================================${NC}"
    echo -e "${YELLOW}Deploying ${env_name} (${project})...${NC}"
    echo -e "${YELLOW}========================================${NC}"
    
    # Switch to the correct Firebase project
    firebase use $project 2>&1 | grep -v "Now using" || true
    
    # First, deploy the function using Firebase CLI (this will create it if it doesn't exist)
    echo "Deploying function using Firebase CLI..."
    if firebase deploy --only functions --project $project --non-interactive 2>&1 | tee /tmp/deploy-output.txt; then
        echo -e "${GREEN}✓ Function deployed successfully${NC}"
    else
        echo -e "${RED}✗ Deployment failed${NC}"
        cat /tmp/deploy-output.txt
        return 1
    fi
    
    # Now set the environment variable using gcloud
    echo ""
    echo "Setting FIREBASE_WEB_API_KEY environment variable..."
    
    # Get existing environment variables
    EXISTING_VARS=$(gcloud functions describe ${FUNCTION_NAME} --project=${project} --region=${REGION} --format="value(environmentVariables)" 2>/dev/null || echo "")
    
    if [ -z "$EXISTING_VARS" ] || [ "$EXISTING_VARS" = "" ]; then
        ENV_VARS="FIREBASE_WEB_API_KEY=${api_key}"
    else
        # Remove existing FIREBASE_WEB_API_KEY if present and add new one
        ENV_VARS=$(echo "$EXISTING_VARS" | sed "s/FIREBASE_WEB_API_KEY=[^,;]*//g" | sed 's/,,*/,/g' | sed 's/^,//' | sed 's/,$//')
        if [ -n "$ENV_VARS" ]; then
            ENV_VARS="${ENV_VARS},FIREBASE_WEB_API_KEY=${api_key}"
        else
            ENV_VARS="FIREBASE_WEB_API_KEY=${api_key}"
        fi
    fi
    
    # Update the function with environment variable
    if gcloud functions deploy ${FUNCTION_NAME} \
        --project=${project} \
        --region=${REGION} \
        --update-env-vars ${ENV_VARS} \
        --quiet 2>&1; then
        echo -e "${GREEN}✓ Environment variable set successfully${NC}"
    else
        echo -e "${YELLOW}⚠ Warning: Failed to set environment variable via gcloud${NC}"
        echo "The function is deployed but you may need to set the env var manually in Google Cloud Console"
        return 1
    fi
    
    echo ""
}

# Ask which environments to deploy
echo "Which environments would you like to deploy?"
echo "1) Production only (recommended for quick fix)"
echo "2) All environments (dev, staging, production)"
echo "3) Dev only"
echo "4) Staging only"
read -p "Enter choice [1-4] (default: 1): " choice
choice=${choice:-1}

case $choice in
    1)
        deploy_function "production" "$PROD_API_KEY" "Production"
        ;;
    2)
        deploy_function "dev" "$DEV_API_KEY" "Development"
        deploy_function "staging" "$STAGING_API_KEY" "Staging"
        deploy_function "production" "$PROD_API_KEY" "Production"
        ;;
    3)
        deploy_function "dev" "$DEV_API_KEY" "Development"
        ;;
    4)
        deploy_function "staging" "$STAGING_API_KEY" "Staging"
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✓ Deployment complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "The functions are now deployed with FIREBASE_WEB_API_KEY set."
echo "Wait 2-3 minutes for the deployment to fully complete, then test login."






