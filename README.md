# AI Group Chat (Firebase Auth + Firestore + OpenRouter)

Realtime group chat where humans and AI companions talk together.

## Stack

- Backend: Node.js + Express + Socket.IO + Firebase Admin SDK
- Frontend: Vanilla HTML/CSS/JS + Firebase Web Auth
- Database: Firestore
- AI: OpenRouter chat completions

## What Firebase Handles

- Authentication: Firebase Auth (Google sign-in)
- Persistence: Firestore stores groups, members, AI members, and messages
- Authorization: server verifies Firebase ID tokens before API access

## Local Setup

1. Install:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Fill all required Firebase + OpenRouter values in `.env`:

- `OPENROUTER_API_KEY`
- `FIREBASE_PROJECT_ID`
- one of:
  - `FIREBASE_SERVICE_ACCOUNT_JSON`
  - `FIREBASE_SERVICE_ACCOUNT_BASE64`
- frontend Firebase web config:
  - `FIREBASE_WEB_API_KEY`
  - `FIREBASE_AUTH_DOMAIN`
  - `FIREBASE_STORAGE_BUCKET`
  - `FIREBASE_MESSAGING_SENDER_ID`
  - `FIREBASE_APP_ID`

4. Start app:

```bash
npm start
```

5. Open `http://localhost:3000` and sign in with Google.

## Render Deployment

1. Push to GitHub.
2. Create Render Web Service.
3. Build: `npm install`
4. Start: `npm start`
5. Add the same env vars from `.env.example`.

## Firestore Data Model (current)

- `groups/{groupId}`
  - core metadata (`name`, `ownerId`, counts, timestamps, `memberIds`)
- `groups/{groupId}/members/{uid}`
- `groups/{groupId}/ai_members/{aiId}`
- `groups/{groupId}/messages/{messageId}`
