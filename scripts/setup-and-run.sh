#!/bin/bash

# Simple script to authenticate gcloud and set environment variables

set -e

export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"

echo "=========================================="
echo "Firebase Functions Environment Setup"
echo "=========================================="
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found in PATH"
    echo "Adding gcloud to PATH..."
    export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
    
    if ! command -v gcloud &> /dev/null; then
        echo "❌ gcloud CLI is not installed."
        echo ""
        echo "Installing gcloud CLI via Homebrew..."
        brew install --cask google-cloud-sdk
        export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
    fi
fi

echo "✓ gcloud CLI found"
echo ""

# Check authentication
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
    echo "🔐 Authentication required"
    echo ""
    echo "You'll need to authenticate gcloud. This will open your browser."
    echo "Please sign in with: micahjthedev@gmail.com"
    echo ""
    read -p "Press Enter to continue with authentication..."
    
    gcloud auth login
    gcloud auth application-default login
else
    echo "✓ Already authenticated with gcloud"
    ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1)
    echo "  Account: $ACTIVE_ACCOUNT"
fi

echo ""
echo "=========================================="
echo "Setting Environment Variables"
echo "=========================================="
echo ""

# Run the Node.js script
cd "$(dirname "$0")/.."
node scripts/set-env-vars.js






