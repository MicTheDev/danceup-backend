#!/bin/bash

# Script to set up Cloud Scheduler job for expireCredits function
# This creates a scheduled job that runs daily at 2 AM UTC to expire student credits

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
JOB_NAME="expire-credits-daily"
SCHEDULE="0 2 * * *"  # Daily at 2 AM UTC
TIMEZONE="UTC"
REGION="us-central1"

# Get current Firebase project
PROJECT=$(firebase use 2>&1 | tail -1 | awk '{print $NF}' | tr -d '()' || echo "")

if [ -z "$PROJECT" ]; then
    echo -e "${RED}Error: Could not determine Firebase project.${NC}"
    echo "Please run: firebase use <project>"
    exit 1
fi

# Function URL - this should match the deployed function URL
# For dev-danceup, the function URL is: https://expirecredits-oaunjndvbq-uc.a.run.app
# We'll construct it dynamically based on the project
FUNCTION_NAME="expireCredits"

echo -e "${BLUE}Setting up Cloud Scheduler job for credit expiration${NC}"
echo -e "Project: ${GREEN}${PROJECT}${NC}"
echo -e "Region: ${GREEN}${REGION}${NC}"
echo -e "Schedule: ${GREEN}${SCHEDULE}${NC} (${TIMEZONE})"
echo ""

# Check if gcloud CLI is available
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}Error: gcloud CLI is not installed or not in PATH${NC}"
    echo "Please install Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if user is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo -e "${RED}Error: No active gcloud authentication found${NC}"
    echo "Please run: gcloud auth login"
    exit 1
fi

# Get the function URL
echo -e "${YELLOW}Retrieving function URL...${NC}"
FUNCTION_URL=$(gcloud functions describe ${FUNCTION_NAME} \
    --region=${REGION} \
    --project=${PROJECT} \
    --gen2 \
    --format="value(serviceConfig.uri)" 2>/dev/null || echo "")

if [ -z "$FUNCTION_URL" ]; then
    echo -e "${RED}Error: Could not retrieve function URL for ${FUNCTION_NAME}${NC}"
    echo "Please verify the function is deployed: firebase deploy --only functions:expireCredits"
    exit 1
fi

echo -e "${GREEN}✓ Found function URL: ${FUNCTION_URL}${NC}"
echo ""

# Check if job already exists
echo -e "${YELLOW}Checking if scheduler job already exists...${NC}"
if gcloud scheduler jobs describe ${JOB_NAME} \
    --location=${REGION} \
    --project=${PROJECT} &>/dev/null; then
    echo -e "${YELLOW}Job ${JOB_NAME} already exists. Updating...${NC}"
    
    # Update existing job
    if gcloud scheduler jobs update http ${JOB_NAME} \
        --location=${REGION} \
        --project=${PROJECT} \
        --schedule="${SCHEDULE}" \
        --time-zone="${TIMEZONE}" \
        --uri="${FUNCTION_URL}" \
        --http-method=GET \
        --attempt-deadline=540s \
        --max-retry-attempts=3 \
        --min-backoff=10s \
        --max-backoff=300s; then
        echo -e "${GREEN}✓ Successfully updated scheduler job: ${JOB_NAME}${NC}"
    else
        echo -e "${RED}✗ Failed to update scheduler job${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}Creating new scheduler job...${NC}"
    
    # Create new job
    if gcloud scheduler jobs create http ${JOB_NAME} \
        --location=${REGION} \
        --project=${PROJECT} \
        --schedule="${SCHEDULE}" \
        --time-zone="${TIMEZONE}" \
        --uri="${FUNCTION_URL}" \
        --http-method=GET \
        --attempt-deadline=540s \
        --max-retry-attempts=3 \
        --min-backoff=10s \
        --max-backoff=300s \
        --description="Daily job to expire student credits that have passed their expiration date"; then
        echo -e "${GREEN}✓ Successfully created scheduler job: ${JOB_NAME}${NC}"
    else
        echo -e "${RED}✗ Failed to create scheduler job${NC}"
        exit 1
    fi
fi

echo ""

# Verify the job was created/updated successfully
echo -e "${YELLOW}Verifying scheduler job...${NC}"
if gcloud scheduler jobs describe ${JOB_NAME} \
    --location=${REGION} \
    --project=${PROJECT} &>/dev/null; then
    echo -e "${GREEN}✓ Job verified successfully${NC}"
    echo ""
    echo -e "${BLUE}Job Details:${NC}"
    gcloud scheduler jobs describe ${JOB_NAME} \
        --location=${REGION} \
        --project=${PROJECT} \
        --format="table(
            name.basename():label=NAME,
            schedule:label=SCHEDULE,
            timeZone:label=TIMEZONE,
            state:label=STATE,
            httpTarget.uri:label=URL
        )"
    echo ""
    echo -e "${GREEN}✓ Cloud Scheduler job setup complete!${NC}"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "1. The job will run automatically daily at 2 AM UTC"
    echo "2. You can manually trigger it with:"
    echo "   ${YELLOW}gcloud scheduler jobs run ${JOB_NAME} --location=${REGION} --project=${PROJECT}${NC}"
    echo "3. View logs in: Google Cloud Console → Cloud Scheduler → ${JOB_NAME} → View logs"
    echo "4. Monitor function execution: Google Cloud Console → Cloud Functions → expireCredits → Logs"
else
    echo -e "${RED}✗ Failed to verify scheduler job${NC}"
    exit 1
fi
