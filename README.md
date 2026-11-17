# Admin-Controlled Private Real-Time Chat Web App

React + Vite + Tailwind frontend with Firebase (Auth, Firestore, Storage) for real-time chat, admin-managed users, and strict connection-based access.

## Stack
- **Frontend:** React 19, Vite, Tailwind CSS v4, Lucide React
- **Backend/Realtime:** Firebase Authentication, Cloud Firestore, Firebase Storage
- **Media:** `emoji-picker-react`, browser `MediaRecorder` API, `browser-image-compression`

## Features
- **No public signup:** only Controller-created accounts can log in (`/login` with username/password).
- **Admin dashboard (`/admin`):** create users (display name, unique username, password, random generator), list users, copy/share credentials info, suspend/restore, delete profile+connections, create/revoke user pairs (connection matrix).
- **Chat (`/chat`):** sidebar shows only Controller-approved connected contacts with online/offline dot and unread badges; real-time messages via Firestore listeners; typing indicator (`<Name> is typing...`, auto-clears ~2s stale); presence (`is_online`/`last_seen`); read receipts (single = sent, double = seen); emoji picker; image upload (compressed, stored in Storage, inline thumbnail + lightbox); voice messages (MediaRecorder, uploaded to Storage, inline audio player).
- **Security:** Firestore/Storage rules restrict reads/writes to admins or participants of an approved connection.

## Project structure
- `src/pages/LoginPage.jsx` – username/password login
- `src/pages/AdminPage.jsx` – user management and pairing matrix
- `src/pages/ChatPage.jsx` – real-time chat UI
- `src/contexts/AuthContext.jsx` – auth/profile/session presence handling
- `src/lib/firebase.js` – Firebase client init
- `firestore.rules`, `storage.rules`, `firestore.indexes.json` – security/index config
- `scripts/seedAdmin.mjs` – creates initial Controller account (Auth + Firestore profile)

## 1) Prerequisites
- Node.js 18+ and npm
- A Firebase project (you can add your API keys/config later)
- Firebase CLI (recommended): `npm install -g firebase-tools`
- For seeding admin with script: a Firebase **service account** JSON (Project settings ? Service accounts ? Generate new private key)

## 2) Firebase project setup
1. Create/select a Firebase project in [Firebase Console](https://console.firebase.google.com/).
2. Enable products:
   - **Authentication** ? Sign-in method ? enable **Email/Password**.
   - **Cloud Firestore** ? create database (production or test, then apply provided rules).
   - **Storage** ? get started (apply provided rules).
3. Register a **Web app** and copy its config values for `.env`.
4. (Recommended) Deploy rules/indexes from this repo:
   ```bash
   firebase login
   firebase init   # select Firestore and Storage, use existing files when prompted
   firebase deploy --only firestore:rules,firestore:indexes,storage
   ```
   Or paste `firestore.rules` / `storage.rules` into the console editors.

## 3) Environment variables
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   (PowerShell: `Copy-Item .env.example .env`)
2. Fill Firebase web config values:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
3. Set initial Controller credentials (used for seeding/first login):
   - `VITE_ADMIN_EMAIL` (default `admin@chat.local`)
   - `VITE_ADMIN_PASSWORD` (change from default)
   - `VITE_ADMIN_DISPLAY_NAME` (default `Controller`)

> Note: user logins use **username + password** in the UI. Internally usernames map to `${username}@chat.local` in Firebase Auth.

## 4) Install and run
```bash
npm install
npm run dev
```
Build/lint:
```bash
npm run build
npm run lint
```

## 5) Create the initial Controller (super-admin)
You need an admin account before you can manage users in `/admin`.

### Option A: Seed script (recommended)
1. Download a service account key JSON and set one of:
   - `FIREBASE_SERVICE_ACCOUNT_PATH=/absolute/path/to/serviceAccount.json`
   - or `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccount.json`
2. Ensure `VITE_ADMIN_EMAIL` / `VITE_ADMIN_PASSWORD` (or `ADMIN_EMAIL` / `ADMIN_PASSWORD`) are set in `.env`.
3. Run:
   ```bash
   npm run seed:admin
   ```
4. The script creates/ensures the Auth user and a Firestore `users/{uid}` doc with `role: "admin"`.

### Option B: Manual (Firebase Console)
1. Authentication ? Add user with email `admin@chat.local` (or your chosen admin email) and password.
2. Copy the created user UID.
3. Firestore ? `users` collection ? add document with **document ID = UID**:
   ```json
   {
     "username": "admin",
     "display_name": "Controller",
     "role": "admin",
     "suspended": false,
     "is_online": false,
     "created_at": "<timestamp>",
     "last_seen": "<timestamp>"
   }
   ```

## 6) Log in as Controller
1. Open the app and go to `/login`.
2. Enter **Username:** `admin` (or the local-part of your admin email) and the admin password.
3. Admins are redirected to `/admin`.

## 7) Admin usage notes
- **Create users:** from `/admin`, enter display name, unique username, and password (or generate). The dashboard creates the Firebase Auth user via a secondary app instance and writes the Firestore profile. Share the username/password with the user securely.
- **Reset password:** client-side apps cannot change another user's Auth password without Admin SDK/Console. The UI generates a new password to copy; apply it in Firebase Console (Authentication ? user ? reset/update) or via an admin backend. (Documented limitation without server/Admin privileges in-browser.)
- **Suspend/Delete:** suspend toggles `suspended` in Firestore (blocks app access); delete removes Firestore profile and their connections. Remove the corresponding Firebase Auth user in Console/Admin for full cleanup.
- **Pairing matrix:** connect two users to create a `connections/{sortedUid__sortedUid}` doc; revoke to delete it. Chat access is limited to these pairs.

## Data model
- **`users/{uid}`:** `username` (unique), `display_name`, `role` (`admin`|`user`), `suspended`, `is_online`, `last_seen`, `created_at`
- **`connections/{connectionId}`:** `user_one_id`, `user_two_id`, `created_at` (ID is deterministic sorted pair to prevent duplicates)
- **`messages/{id}`:** `connection_id`, `sender_id`, `type` (`text`|`image`|`audio`), `content` (text or download URL), `is_read`, `created_at` (+ optional `seen_at`, `file_name`)
- **`typing/{connectionId_userId}`:** ephemeral typing state (`typing`, `updated_at`) for live indicators
- **Storage:** `chat-media/{connectionId}/{uuid-filename}` for images/voice

## Security notes
- Firestore rules enforce: users read own profile/admin/all-active-user basics as needed; only admins create/delete users & connections; messages readable/creatable/updatable (read receipts) only by participants of the referenced connection; typing writes restricted to the owning user.
- Storage rules require authentication and size limits for `chat-media`.
- Review and harden rules for your production needs (e.g. stricter storage path membership checks via custom metadata/tokens, rate limiting via App Check/Cloud Functions).

## Known limitations / follow-ups
- Password reset for other users from the browser requires Firebase Admin SDK or Console action (not possible securely client-side).
- Presence is best-effort (heartbeat + unload). For robust presence consider Realtime Database presence or Cloud Functions.
- `npm install` must complete successfully with network access to fetch all dependencies listed in `package.json`.
