# Local Development Setup

This guide explains how to run the DanceUp backend locally using Firebase Emulators and connect the frontend applications to it.

## Prerequisites

- Node.js 20+ installed
- Firebase CLI installed (`npm install -g firebase-tools`)
- Firebase project access (for authentication)

## Quick Start

### 1. Start Backend Emulators

From the `danceup-backend` directory:

```bash
# Start all emulators (Functions, Auth, Firestore, Storage)
npm run dev

# Or start only Functions emulator
npm run dev:functions
```

This will start:
- **Functions Emulator**: `http://localhost:5001`
- **Auth Emulator**: `http://localhost:9099`
- **Firestore Emulator**: `http://localhost:8080`
- **Storage Emulator**: `http://localhost:9199`
- **Emulator UI**: `http://localhost:4000`

### 2. Start Frontend Application

From the `studio-owners-app` directory:

```bash
npm start
```

The frontend will automatically detect that it's running on `localhost` and connect to the local emulators instead of the deployed services.

## How It Works

### Auto-Detection

The frontend automatically detects local development by checking if `window.location.hostname === 'localhost'`. When detected:

- **API URLs**: Switches from `https://us-central1-dev-danceup.cloudfunctions.net` to `http://localhost:5001`
- **Firebase Auth**: Connects to `http://localhost:9099`
- **Firestore**: Connects to `http://localhost:8080`
- **Storage**: Connects to `http://localhost:9199`

### Backend Configuration

The backend emulators are configured in `firebase.json`:

```json
{
  "emulators": {
    "functions": { "port": 5001, "host": "0.0.0.0" },
    "auth": { "port": 9099, "host": "0.0.0.0" },
    "firestore": { "port": 8080, "host": "0.0.0.0" },
    "storage": { "port": 9199, "host": "0.0.0.0" },
    "ui": { "enabled": true, "port": 4000, "host": "0.0.0.0" }
  }
}
```

### Frontend Configuration

The frontend uses `environment.development.ts` which auto-detects localhost:

```typescript
const isLocalhost = typeof window !== 'undefined' && 
  (window.location.hostname === 'localhost' || 
   window.location.hostname === '127.0.0.1');

const apiUrl = isLocalhost 
  ? 'http://localhost:5001' 
  : 'https://us-central1-dev-danceup.cloudfunctions.net';
```

## Available Scripts

### Backend (`danceup-backend/`)

- `npm run dev` - Start all emulators (Functions, Auth, Firestore, Storage)
- `npm run dev:functions` - Start only Functions emulator
- `npm run serve` - Alias for `dev:functions` (legacy)

### Frontend (`studio-owners-app/`)

- `npm start` - Start Angular dev server (auto-connects to emulators on localhost)

## Emulator UI

Access the Firebase Emulator Suite UI at `http://localhost:4000` to:

- View and manage Firestore data
- Manage Auth users
- View Functions logs
- Monitor Storage files

## Environment Variables

### Backend

The emulators automatically set these environment variables:

- `FIRESTORE_EMULATOR_HOST=localhost:8080`
- `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099`
- `FUNCTIONS_EMULATOR_HOST=localhost:5001`

### Frontend

No manual environment variables needed. The frontend auto-detects localhost.

## Testing Local Development

1. **Start emulators**: `cd danceup-backend && npm run dev`
2. **Start frontend**: `cd studio-owners-app && npm start`
3. **Verify connection**: Check browser console for:
   - `[App Config] Connected to Auth emulator at http://localhost:9099`
   - `[App Config] Connected to Firestore emulator at localhost:8080`
   - `[ApiClientService] Environment: { apiUrl: 'http://localhost:5001' }`
4. **Test API calls**: Make API requests and verify they go to `localhost:5001`

## Troubleshooting

### Frontend not connecting to emulators

**Problem**: Frontend still uses deployed URLs even on localhost.

**Solution**: 
- Verify you're accessing the app via `http://localhost:4200` (not `127.0.0.1`)
- Check browser console for environment logs
- Restart the Angular dev server

### CORS errors

**Problem**: CORS errors when making API requests.

**Solution**: 
- The backend CORS configuration already allows `localhost:4200`
- Verify the Functions emulator is running on port 5001
- Check that the request origin is `http://localhost:4200`

### Firestore emulator not working

**Problem**: Firestore operations fail or don't persist.

**Solution**:
- Verify Firestore emulator is running: `http://localhost:4000` → Firestore tab
- Check that `FIRESTORE_EMULATOR_HOST` is set (auto-set by Firebase CLI)
- Restart emulators if needed

### Auth emulator not working

**Problem**: Authentication fails or users don't persist.

**Solution**:
- Verify Auth emulator is running: `http://localhost:4000` → Authentication tab
- Check that `FIREBASE_AUTH_EMULATOR_HOST` is set (auto-set by Firebase CLI)
- Clear browser cache and localStorage if needed

### Functions not responding

**Problem**: API calls to Functions return errors.

**Solution**:
- Check Functions emulator logs in terminal
- Verify Functions are deployed to emulator (check `http://localhost:4000` → Functions tab)
- Ensure Functions emulator is running on port 5001
- Check that the frontend is using `http://localhost:5001` for API calls

### Port already in use

**Problem**: Error that port is already in use.

**Solution**:
- Find and kill the process using the port:
  ```bash
  # For port 5001 (Functions)
  lsof -ti:5001 | xargs kill -9
  
  # For port 4000 (UI)
  lsof -ti:4000 | xargs kill -9
  ```
- Or change the port in `firebase.json`

## Data Persistence

### Firestore

Firestore emulator data is stored in memory by default and is lost when emulators stop. To persist data:

1. Create a directory: `mkdir -p .firebase/emulator-data`
2. Update `firebase.json`:
   ```json
   {
     "emulators": {
       "firestore": {
         "port": 8080,
         "host": "0.0.0.0"
       }
     }
   }
   ```
3. Start emulators with: `firebase emulators:start --import=.firebase/emulator-data --export-on-exit`

### Auth

Auth emulator users are stored in memory and lost when emulators stop. Use the Emulator UI to create test users.

## Production vs Local

When running locally:
- ✅ All API calls go to `http://localhost:5001`
- ✅ Firebase services use emulators
- ✅ Data is isolated from production
- ✅ No charges for Firebase usage
- ✅ Fast iteration and debugging

When deployed:
- ✅ Automatically uses production URLs
- ✅ Connects to real Firebase services
- ✅ Uses production data
- ✅ No code changes needed

## Additional Resources

- [Firebase Emulator Suite Documentation](https://firebase.google.com/docs/emulator-suite)
- [Angular Firebase Documentation](https://github.com/angular/angularfire)


