# Lumiere

Lumiere is a shared online space for spending time together in sync. It combines realtime rooms, chat, and relationship-driven social features so people can watch videos, listen to music or podcasts, co-read documents, and hang out in study sessions from one app.

## What it does

- Create private rooms for friends, couples, family, or small groups
- Sync shared sessions across multiple modes: watch, music, podcast, reading, and study
- Chat live inside each room and keep room state in sync with Socket.IO
- Use Firebase Authentication for sign-in and identity
- Track shared memories, invites, notifications, and relationship insights
- Manage profiles, friends, couple watchlists, and dashboard settings

## Tech stack

- Frontend: React, Vite, Tailwind CSS, Firebase Web SDK, Socket.IO client
- Backend: Node.js, Express, Socket.IO, Firebase Admin, Mongoose
- Data/Auth: MongoDB and Firebase Authentication

## Project structure

```text
.
├── backend/    # Express + Socket.IO server, routes, services, Firebase admin
├── frontend/   # React + Vite client application
├── output/     # Generated output assets
├── tmp/        # Local helper scripts and temporary assets
└── package.json
```

## Local setup

### 1. Install dependencies

Install dependencies in all three package roots:

```bash
npm install
cd backend && npm install
cd ../frontend && npm install
```

### 2. Configure environment variables

Create your local backend env file from the example:

```bash
cp backend/.env.example backend/.env
```

Then fill in the real values in `backend/.env`.

Minimum values you will usually need:

- `PORT`
- `MONGODB_URI`
- `CLIENT_URL`
- `FIREBASE_SERVICE_ACCOUNT` or `FIREBASE_SERVICE_ACCOUNT_PATH`

Important: never commit real secrets. `backend/.env` is ignored on purpose.

### 3. Start the app

From the project root:

```bash
npm start
```

This starts:

- the backend server from `backend/server.js`
- the frontend Vite dev server from `frontend`

## Useful scripts

### Root

```bash
npm start
```

### Backend

```bash
cd backend
npm start
npm run dev
```

### Frontend

```bash
cd frontend
npm run dev
npm run build
npm run preview
```

## Core product areas

- Realtime rooms with synchronized playback and presence
- Shared watch, music, podcast, reading, and study experiences
- Friend requests, room invites, and notification flows
- Shared memory tracking and relationship analytics
- Couple-space watchlists and dashboard management

## Notes

- The backend expects Firebase Admin credentials for authenticated API and socket flows.
- MongoDB is required for persistent profile, room, memory, and relationship data.
- The frontend ships from the `frontend` app and the backend API lives in `backend`.

## Repository

GitHub: `https://github.com/vishalchauhan-code/lumiere`
