# AI Group Chat (Render + OpenRouter)

A full-stack chat app where real users and AI participants talk in the same group conversation.

This version does **not** require Firebase. It is built for Render deployment with Node.js.

## Features

- Realtime group chat using Socket.IO
- Create groups and join by group ID
- Add AI members to each group with:
  - name
  - persona
  - model
  - temperature
  - reply delay
- Server-side AI requests via OpenRouter (API key stays private on backend)

## Stack

- Backend: Node.js + Express + Socket.IO
- Frontend: Vanilla HTML/CSS/JS
- AI: OpenRouter Chat Completions API
- Hosting: Render Web Service

## Local development

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Fill in `OPENROUTER_API_KEY` in `.env`.

4. Run:

```bash
npm run dev
```

5. Open `http://localhost:3000`.

## Deploy to Render

1. Push this project to GitHub.
2. In Render, create a new **Web Service** from that repo.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add environment variables:
   - `OPENROUTER_API_KEY` (required)
   - `OPENROUTER_SITE_URL` (optional)
   - `OPENROUTER_SITE_NAME` (optional)
5. Deploy.

You can also keep `render.yaml` in the repo and use Render Blueprint deploys.

## Important note

Current data storage is in-memory for fast MVP iteration. If the service restarts, groups/messages reset.

For production persistence, move to PostgreSQL (Render Postgres) and store:

- users
- groups
- memberships
- ai_members
- messages
# AIGroupChat
