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


