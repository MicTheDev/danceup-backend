# DanceUp Backend

Firebase Functions backend for DanceUp user-app and studio-owners-app. This project provides REST API endpoints that connect to the same Firestore databases used by the frontend applications.

## Overview

This backend service is built using:
- **Firebase Functions** - Serverless cloud functions
- **Express.js** - Web framework for REST APIs
- **Firebase Admin SDK** - Server-side Firebase access
- **Jest** - Testing framework

## Project Structure

```
danceup-backend/
├── functions/
│   ├── index.js              # Main entry point with Express app
│   ├── routes/              # API route handlers (to be implemented)
│   ├── middleware/          # Express middleware (auth, error handling, etc.)
│   ├── services/            # Business logic services
│   ├── utils/               # Utility functions
│   ├── tests/               # Jest test files
│   ├── package.json         # Functions dependencies
│   └── jest.config.js       # Jest configuration
├── .firebaserc              # Firebase project aliases
├── firebase.json            # Firebase configuration
├── package.json             # Root package.json with scripts
└── README.md                # This file
```

## Firebase Projects

The backend connects to three Firebase projects:

- **Development**: `dev-danceup`
- **Staging**: `staging-danceup`
- **Production**: `production-danceup`

Each project has its own Firestore database that matches the frontend applications.

## Prerequisites

- Node.js 20 or higher
- npm or yarn
- Firebase CLI (`npm install -g firebase-tools`)
- Firebase account with access to the projects above

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/MicTheDev/danceup-backend.git
cd danceup-backend
```

### 2. Install Dependencies

```bash
# Install root dependencies (Firebase CLI)
npm install

# Install functions dependencies
npm run install-functions
```

### 3. Firebase Authentication

Authenticate with Firebase CLI:

```bash
firebase login
```

### 4. Configure Firebase Projects

The `.firebaserc` file is already configured with project aliases:
- `dev` → `dev-danceup`
- `staging` → `staging-danceup`
- `production` → `production-danceup`

To use a specific project:

```bash
firebase use dev        # Switch to development
firebase use staging    # Switch to staging
firebase use production # Switch to production
```

### 5. Environment Variables

For local development, create a `.env` file in the `functions/` directory (not committed to git):

```env
NODE_ENV=development
```

Firebase Functions automatically have access to Firebase project configuration when deployed.

## Local Development

### Start Firebase Emulators

```bash
npm run serve
```

This starts the Firebase Functions emulator. The API will be available at:
- `http://localhost:5001/<project-id>/<region>/api`

### Health Check

Test the health endpoint:

```bash
curl http://localhost:5001/dev-danceup/us-central1/api/health
```

## Testing

### Run Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Test Structure

Tests are located in `functions/tests/` and use Jest. Example test file:
- `functions/tests/health.test.js` - Health endpoint tests

## Linting

Run ESLint to check code quality:

```bash
npm run lint
```

## Deployment

### Manual Deployment

Deploy to a specific environment:

```bash
# Deploy to development
npm run deploy:dev

# Deploy to staging
npm run deploy:staging

# Deploy to production
npm run deploy:production
```

Or use Firebase CLI directly:

```bash
firebase deploy --only functions --project dev
firebase deploy --only functions --project staging
firebase deploy --only functions --project production
```

### CI/CD Deployment

The project includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that:

1. **Automatically runs tests** on push to `main` or `master`
2. **Allows manual deployment** via GitHub Actions UI with environment selection
3. **Deploys to one environment at a time** (dev, staging, or production)

#### Setting Up GitHub Secrets

For CI/CD to work, you need to add Firebase service account secrets to GitHub:

1. Go to your Firebase project settings
2. Navigate to Service Accounts
3. Generate a new private key
4. Add the JSON content as a GitHub secret:
   - `FIREBASE_SERVICE_ACCOUNT_DEV` - For dev-danceup
   - `FIREBASE_SERVICE_ACCOUNT_STAGING` - For staging-danceup
   - `FIREBASE_SERVICE_ACCOUNT_PRODUCTION` - For production-danceup

#### Manual Deployment via GitHub Actions

1. Go to the Actions tab in GitHub
2. Select "Deploy to Firebase Functions" workflow
3. Click "Run workflow"
4. Select the environment (dev, staging, or production)
5. Click "Run workflow"

## Google Cloud Console Setup

This section covers all the required setup steps in Google Cloud Console for CI/CD deployment to work properly. **You must complete these steps for each environment** (dev, staging, production).

### Prerequisites

Before starting, ensure you have:
- Owner or Editor access to all three Firebase projects
- Access to Google Cloud Console
- The service account JSON files downloaded (from Firebase Console → Project Settings → Service Accounts)

### Step 1: Get Firebase Service Account JSON Files

For each environment (dev, staging, production):

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select the project:
   - **Dev**: `dev-danceup`
   - **Staging**: `staging-danceup`
   - **Production**: `production-danceup`
3. Open **Project Settings** (gear icon next to "Project Overview")
4. Go to **Service Accounts** tab
5. Click **"Generate new private key"**
6. Confirm in the dialog
7. A JSON file will download (e.g., `dev-danceup-firebase-adminsdk-xxxxx.json`)
8. **Save this file securely** - you'll need it for GitHub Secrets

**Important**: Keep these JSON files secure and never commit them to the repository.

### Step 2: Add Service Account Secrets to GitHub

1. Go to your GitHub repository
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **"New repository secret"** for each environment:

   **For Dev:**
   - Name: `FIREBASE_SERVICE_ACCOUNT_DEV`
   - Value: Paste the **entire JSON content** from the dev-danceup service account file
   - Click **"Add secret"**

   **For Staging:**
   - Name: `FIREBASE_SERVICE_ACCOUNT_STAGING`
   - Value: Paste the **entire JSON content** from the staging-danceup service account file
   - Click **"Add secret"**

   **For Production:**
   - Name: `FIREBASE_SERVICE_ACCOUNT_PRODUCTION`
   - Value: Paste the **entire JSON content** from the production-danceup service account file
   - Click **"Add secret"**

**Note**: The JSON must be complete, starting with `{` and ending with `}`. Copy the entire file content.

### Step 3: Initialize Google App Engine

Firebase Functions require App Engine to be initialized in each project.

For each environment:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select the project:
   - **Dev**: `dev-danceup`
   - **Staging**: `staging-danceup`
   - **Production**: `production-danceup`
3. Navigate to **App Engine** in the left menu
4. If you see **"Create Application"**:
   - Click **"Create Application"**
   - Select a region (recommended: `us-central`)
   - Click **"Create"**
   - Wait for initialization (2-5 minutes)
5. If you see a dashboard, App Engine is already initialized

**Alternative via Firebase Console:**
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select the project
3. Navigate to **App Engine** in the left menu
4. Click **"Create App Engine app"** if prompted
5. Select region and create

### Step 4: Grant Firebase Admin Role

The service account needs permission to access Firebase services.

For each environment:

1. Go to [Google Cloud Console IAM](https://console.cloud.google.com/iam-admin/iam)
2. Select the project (dev-danceup, staging-danceup, or production-danceup)
3. Find your service account:
   - Look for email like: `firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com`
   - Or check the `client_email` field in your downloaded JSON file
4. Click the **pencil icon (Edit)** next to the service account
5. Click **"ADD ANOTHER ROLE"**
6. Select **"Firebase Admin"** role
7. Click **"SAVE"**

**Direct Links:**
- [Dev IAM](https://console.cloud.google.com/iam-admin/iam?project=dev-danceup)
- [Staging IAM](https://console.cloud.google.com/iam-admin/iam?project=staging-danceup)
- [Production IAM](https://console.cloud.google.com/iam-admin/iam?project=production-danceup)

### Step 5: Grant Service Account User Role

The service account needs permission to act as the App Engine default service account.

For each environment:

1. Go to [Google Cloud Console IAM](https://console.cloud.google.com/iam-admin/iam)
2. Select the project
3. Find your service account (same one from Step 4)
4. Click the **pencil icon (Edit)**
5. Click **"ADD ANOTHER ROLE"**
6. Select **"Service Account User"** role
7. Click **"SAVE"**

**Why this is needed**: Firebase Functions deployment requires the service account to act as the App Engine default service account (`<project-id>@appspot.gserviceaccount.com`).

### Verification Checklist

After completing all steps, verify:

- [ ] Service account JSON files downloaded for all 3 environments
- [ ] GitHub secrets added: `FIREBASE_SERVICE_ACCOUNT_DEV`, `FIREBASE_SERVICE_ACCOUNT_STAGING`, `FIREBASE_SERVICE_ACCOUNT_PRODUCTION`
- [ ] App Engine initialized for all 3 projects
- [ ] "Firebase Admin" role granted to service accounts in all 3 projects
- [ ] "Service Account User" role granted to service accounts in all 3 projects

### Quick Reference: Service Account Emails

To find your service account email, check the `client_email` field in each JSON file:

- **Dev**: `firebase-adminsdk-xxxxx@dev-danceup.iam.gserviceaccount.com`
- **Staging**: `firebase-adminsdk-xxxxx@staging-danceup.iam.gserviceaccount.com`
- **Production**: `firebase-adminsdk-xxxxx@production-danceup.iam.gserviceaccount.com`

### Troubleshooting Setup Issues

**Error: "Missing permissions required for functions deploy"**
- Ensure "Service Account User" role is granted (Step 5)

**Error: "Could not authenticate service account"**
- Verify App Engine is initialized (Step 3)
- Check that service account JSON is correctly added to GitHub secrets

**Error: "The caller does not have permission" (Extensions API)**
- Ensure "Firebase Admin" role is granted (Step 4)

**Error: "credentials_json is empty"**
- Verify GitHub secrets are set correctly (Step 2)
- Check that the entire JSON content was pasted (not just part of it)

**Error: "Functions successfully deployed but could not set up cleanup policy"**
- The `--force` flag is already included in the deployment command to automatically set up the cleanup policy
- This policy automatically deletes old container images to prevent storage costs
- If you still see this error, you can manually set it up: `firebase functions:artifacts:setpolicy`

## API Endpoints

### Health Check

```
GET /health
```

Returns the service status.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "service": "danceup-backend"
}
```

### Future Endpoints

API routes will be added in `functions/routes/` and registered in `functions/index.js`.

Example structure:
```javascript
// functions/routes/users.js
const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  // Implementation
});

module.exports = router;
```

Then in `functions/index.js`:
```javascript
app.use('/api/v1/users', require('./routes/users'));
```

## Environment Configuration

### Development
- Firebase Project: `dev-danceup`
- Firestore Database: `development`

### Staging
- Firebase Project: `staging-danceup`
- Firestore Database: `staging`

### Production
- Firebase Project: `production-danceup`
- Firestore Database: `production`

## Troubleshooting

### Functions Not Deploying

1. Ensure you're authenticated: `firebase login`
2. Check project selection: `firebase use <environment>`
3. Verify Firebase CLI version: `firebase --version`
4. Check function logs: `firebase functions:log`

### Tests Failing

1. Ensure dependencies are installed: `npm run install-functions`
2. Check Node.js version (should be 20+): `node --version`
3. Clear node_modules and reinstall if needed

### Local Emulator Issues

1. Ensure Firebase CLI is installed globally
2. Check if ports 5001, 8080, etc. are available
3. Try clearing emulator cache: `firebase emulators:exec "echo 'cleared'"`

## Contributing

1. Create a feature branch
2. Make your changes
3. Write/update tests
4. Ensure tests pass: `npm test`
5. Ensure linting passes: `npm run lint`
6. Submit a pull request

## License

ISC


