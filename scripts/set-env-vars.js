#!/usr/bin/env node

/**
 * Script to set FIREBASE_WEB_API_KEY environment variable for Firebase Functions
 * This script uses the Google Cloud Functions API to update environment variables
 * without requiring a full redeployment.
 * 
 * Prerequisites:
 * 1. Authenticated with Firebase CLI: firebase login
 * 2. Application default credentials set: gcloud auth application-default login
 */

const { execSync } = require('child_process');
const path = require('path');

// API Keys for each environment
const API_KEYS = {
  'dev-danceup': 'AIzaSyBdXsPyCq4DM5SzbjSj8ZjnzvFSrlJaULY',
  'staging-danceup': 'AIzaSyC9HuYCmv8oSkQQf_9hFjosfemcRMNKJi8',
  'production-danceup': 'AIzaSyDCZuVCy4EDroXrIwgZ0uBSmEfzePRE-ec'
};

const FUNCTION_NAME = 'api';
const REGION = 'us-central1';

function checkGcloudInstalled() {
  try {
    execSync('which gcloud', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkGcloudAuth() {
  try {
    const accounts = execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
      encoding: 'utf-8',
      stdio: 'pipe'
    }).trim();
    return accounts.length > 0;
  } catch {
    return false;
  }
}

function getExistingEnvVars(project) {
  try {
    const output = execSync(
      `gcloud functions describe ${FUNCTION_NAME} --project=${project} --region=${REGION} --format="value(environmentVariables)"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();
    
    if (!output || output === '') {
      return {};
    }
    
    // Parse key=value pairs
    const vars = {};
    output.split(',').forEach(pair => {
      const [key, ...valueParts] = pair.split('=');
      if (key && valueParts.length > 0) {
        vars[key.trim()] = valueParts.join('=').trim();
      }
    });
    return vars;
  } catch (error) {
    console.error(`Error getting existing env vars for ${project}:`, error.message);
    return {};
  }
}

function setEnvVar(project, apiKey, envName) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Setting environment variable for ${envName} (${project})...`);
  console.log(`${'='.repeat(60)}`);
  
  // Check if function exists
  try {
    execSync(
      `gcloud functions describe ${FUNCTION_NAME} --project=${project} --region=${REGION}`,
      { stdio: 'ignore' }
    );
  } catch (error) {
    console.error(`❌ Error: Function '${FUNCTION_NAME}' not found in project '${project}'`);
    console.error('   Make sure the function is deployed first.');
    return false;
  }
  
  // Get existing environment variables
  const existingVars = getExistingEnvVars(project);
  
  // Update/add FIREBASE_WEB_API_KEY
  existingVars.FIREBASE_WEB_API_KEY = apiKey;
  
  // Build env vars string
  const envVarsString = Object.entries(existingVars)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  
  console.log(`Updating function with environment variables...`);
  console.log(`Setting: FIREBASE_WEB_API_KEY=${apiKey.substring(0, 20)}...`);
  
  try {
    // Update the function with new environment variables
    execSync(
      `gcloud functions deploy ${FUNCTION_NAME} ` +
      `--project=${project} ` +
      `--region=${REGION} ` +
      `--update-env-vars ${envVarsString} ` +
      `--quiet`,
      { stdio: 'inherit' }
    );
    
    console.log(`✅ Successfully set FIREBASE_WEB_API_KEY for ${envName}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to set environment variable for ${envName}`);
    console.error('   Error:', error.message);
    return false;
  }
}

// Main execution
async function main() {
  console.log('Firebase Functions Environment Variable Setup');
  console.log('='.repeat(60));
  
  // Check if gcloud is installed
  if (!checkGcloudInstalled()) {
    console.error('\n❌ Error: gcloud CLI is not installed.');
    console.log('\nPlease install gcloud CLI:');
    console.log('  brew install --cask google-cloud-sdk');
    console.log('\nAfter installing, restart your terminal and run this script again.');
    process.exit(1);
  }
  
  // Check authentication
  if (!checkGcloudAuth()) {
    console.error('\n❌ Error: Not authenticated with gcloud.');
    console.log('\nPlease authenticate:');
    console.log('  1. Run: gcloud auth login');
    console.log('  2. Run: gcloud auth application-default login');
    console.log('\nThen run this script again.');
    process.exit(1);
  }
  
  console.log('✓ gcloud CLI is installed and authenticated\n');
  
  // Get user input for which environments to update
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
  
  console.log('Which environments would you like to update?');
  console.log('1) All environments (dev, staging, production)');
  console.log('2) Dev only');
  console.log('3) Staging only');
  console.log('4) Production only');
  
  const choice = await question('\nEnter choice [1-4] (default: 4 for production): ');
  rl.close();
  
  const selectedChoice = choice.trim() || '4';
  const results = [];
  
  switch (selectedChoice) {
    case '1':
      results.push(setEnvVar('dev-danceup', API_KEYS['dev-danceup'], 'Development'));
      results.push(setEnvVar('staging-danceup', API_KEYS['staging-danceup'], 'Staging'));
      results.push(setEnvVar('production-danceup', API_KEYS['production-danceup'], 'Production'));
      break;
    case '2':
      results.push(setEnvVar('dev-danceup', API_KEYS['dev-danceup'], 'Development'));
      break;
    case '3':
      results.push(setEnvVar('staging-danceup', API_KEYS['staging-danceup'], 'Staging'));
      break;
    case '4':
      results.push(setEnvVar('production-danceup', API_KEYS['production-danceup'], 'Production'));
      break;
    default:
      console.error('Invalid choice');
      process.exit(1);
  }
  
  const successCount = results.filter(r => r).length;
  const totalCount = results.length;
  
  console.log('\n' + '='.repeat(60));
  if (successCount === totalCount) {
    console.log(`✅ Successfully updated ${successCount}/${totalCount} environment(s)`);
  } else {
    console.log(`⚠️  Partially completed: ${successCount}/${totalCount} environment(s) updated`);
  }
  console.log('='.repeat(60));
  console.log('\nThe functions are being redeployed with the new environment variables.');
  console.log('Please wait a few minutes for the deployment to complete before testing.');
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});






