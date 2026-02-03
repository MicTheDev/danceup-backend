#!/bin/bash

# Post-deployment script to set environment variables for functions
# This should be run after deploying functions to ensure API keys are set

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Setting environment variables for functions..."
bash scripts/set-env-vars-for-functions.sh
