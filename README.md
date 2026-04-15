<!-- vercel-redeploy-trigger -->
# 🎬 Lumiere | Real-Time Collaborative Workspace

**Lumiere** is a full-stack collaborative platform where users can **watch, listen, read, study, and interact together in real time** inside private synchronized rooms.

It combines **Firebase Authentication**, **Socket.IO-powered live collaboration**, **MongoDB-backed social data**, and a polished React frontend to create a premium shared digital space for couples, friends, and families.

---

## 🌐 Live Links

- **Frontend (Vercel):** [https://lumiere-sync.vercel.app](https://lumiere-sync.vercel.app)
- **Backend (Render):** [https://lumiere-sha4.onrender.com](https://lumiere-sha4.onrender.com)
- **Backend Health Check:** [https://lumiere-sha4.onrender.com/health](https://lumiere-sha4.onrender.com/health)

---

## ✨ Actual Features Implemented

- **Authentication system** with Google sign-in, email/password login, account creation, email verification, password reset, and username claim flow.
- **Private room creation and join-by-code flow** from the lobby with support for couple, best-friend, and family-style room experiences.
- **Multiple collaborative session modes**:
  - Watch mode
  - Music mode
  - Podcast sync
  - Co-reading mode
  - Study session mode
- **Real-time synchronized media playback** using Socket.IO for room events, playback state sharing, and server-timed sync updates.
- **Shared YouTube and media playback controls** with seek, play, pause, scheduled start handling, and drift correction.
- **Secure PDF co-reading workflow** with temporary room-scoped document upload, download, and synchronized page state.
- **Live room chat and reactions** for group interaction during sessions.
- **WebRTC-based in-room calling support** for richer live collaboration.
- **Room history retrieval** through backend snapshot endpoints.
- **Friend system** with user search, friend requests, accept/reject actions, online presence, and room invites.
- **Notification center** with unread tracking and durable notification history.
- **Dashboard workspace** featuring:
  - Profile editing
  - Friends management
  - Couple Space watchlist
  - Shared memories
  - Activity history
  - Notifications
  - Metadata/admin area
  - Relationship insights and milestones
- **Memory Vault / shared memories system** to store collaborative moments and session-linked notes.
- **Relationship intelligence layer** with watch-session history, milestones, and yearly insight generation.
- **Admin overview endpoint** for project-wide operational data.
- **Secure backend middleware** with Firebase Admin token verification, CORS, Helmet, and rate-limit protection.

---

## 🧠 Technical Challenges Solved

### 1. Clock Skew in Real-Time Sync

One of the hardest engineering problems in Lumiere was keeping media synchronized across **different devices, browsers, and network conditions**.

To solve this, the room sync flow uses a **shared server clock approach** instead of trusting each device's local playback clock. In the room layer:

- playback target time is reconstructed from **server timestamps**
- scheduled starts align users before playback begins
- large drift is corrected with a **hard resync**
- smaller drift is corrected with **temporary playback-rate nudges**

This made synchronized music and media playback much more stable and reduced cross-device timing mismatch.

### 2. Mobile Token Refresh Fix in `useAuthSession.js`

Another important issue appeared during authentication, especially on mobile and popup-based login flows.

To make auth more reliable, `useAuthSession.js` now:

- uses **`onIdTokenChanged`** instead of only `onAuthStateChanged`
- refreshes backend bootstrap whenever Firebase issues a new ID token
- forces a fresh token with **`getIdToken(true)`** during sensitive actions like username claim
- forces token refresh again after email verification success

This prevented stale-token issues on mobile devices and ensured that both the **REST API** and **Socket.IO connection** always receive a valid Firebase token.

---

## 🏗️ Tech Stack

### Frontend

- **React 18**
- **Vite 5**
- **Tailwind CSS**
- **Firebase Web SDK**
- **Socket.IO Client**
- **React PDF**
- **pdfjs-dist**
- **Emoji Mart**
- **Lucide React**

### Backend

- **Node.js**
- **Express.js**
- **Socket.IO**
- **Firebase Admin SDK**
- **Mongoose**
- **Dotenv**
- **Helmet**
- **CORS**

### Root / Tooling

- **Concurrently**
- **Axios**
- **React Router DOM**
- **Nodemon**
- **PostCSS**
- **Autoprefixer**

### Database & Deployment

- **MongoDB**
- **Vercel**
- **Render**

> Architecture style: **MERN-based full-stack application** with Firebase used for authentication and identity management.

---

## 🧩 Core Project Modules

### Frontend Views

- `LandingView.jsx` for authentication entry
- `VerifyEmailView.jsx` for email verification gating
- `LobbyView.jsx` for room creation, joining, invites, and notifications
- `RoomPendingView.jsx` for room transition state
- `RoomView.jsx` for real-time collaboration sessions
- `DashboardView.jsx` for profile, memories, relationships, and settings

### Backend API Modules

- `profile.routes.js`
- `friends.routes.js`
- `watchlist.routes.js`
- `memories.routes.js`
- `rooms.routes.js`
- `notifications.routes.js`
- `insights.routes.js`
- `uploads.routes.js`
- `admin.routes.js`

### Backend Entry Point

- `backend/server.js` wires together:
  - Express server
  - Socket.IO realtime layer
  - Firebase Admin authentication
  - MongoDB initialization
  - route mounting
  - health check
  - heartbeat-based sync handling

---

## 📁 Project Structure

```text
Lumiere/
├── backend/
│   ├── config/
│   ├── middleware/
│   ├── models/
│   ├── routes/
│   ├── services/
│   ├── sockets/
│   ├── utils/
│   ├── .env.example
│   └── server.js
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── views/
│   │   └── App.jsx
│   ├── .env.example
│   └── package.json
├── package.json
└── README.md
```

---

## ⚙️ How To Run Locally

### 1. Clone the repository

```bash
git clone https://github.com/vishalchauhan-code/lumiere.git lumiere-project
cd lumiere-project
```

### 2. Install dependencies

Install dependencies in all three package locations:

```bash
npm install
cd backend && npm install
cd ../frontend && npm install
```

### 3. Configure backend environment

Create the backend environment file:

```bash
cp backend/.env.example backend/.env
```

Update `backend/.env` with your real values:

- `PORT`
- `MONGODB_URI`
- `CLIENT_URL`
- `FIREBASE_SERVICE_ACCOUNT`

You can also use:

- `FIREBASE_SERVICE_ACCOUNT_PATH`

instead of inline JSON if you prefer a local service-account file.

### 4. Configure frontend environment

Create the frontend environment file:

```bash
cp frontend/.env.example frontend/.env
```

The current frontend example uses:

```env
VITE_API_URL=http://localhost:10000
```

### 5. Firebase frontend configuration note

The current repository keeps the Firebase web-app config inside:

- `frontend/src/firebase.js`

If you want to run Lumiere with your own Firebase project, update that file with your project's client config.

### 6. Start the project

From the project root:

```bash
npm start
```

This root script starts:

- the **backend server** from `backend/server.js`
- the **frontend Vite app** from `frontend`

### 7. Open the app

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:10000`

---

## 🚀 Available Scripts

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

---

## 🛠️ Troubleshooting

### Vercel still shows an old favicon or logo

If the deployed site still shows the old Vite favicon even after the source code is fixed, the problem is usually cached deployment output or browser favicon caching rather than the current codebase.

Try these steps:

1. Confirm the latest build output is correct locally:

```bash
cd frontend
npm run build
```

Then check that `frontend/dist/index.html` points to:

```html
<link rel="icon" type="image/png" href="/lumiere-sync-logo.png" />
```

2. Redeploy the frontend on Vercel and clear any previous build cache during redeploy if that option is available in the deployment flow.

3. In the browser, do a hard refresh:

- Windows/Linux: `Ctrl + Shift + R`
- macOS: `Cmd + Shift + R`

4. If the old favicon still appears, clear site data for the deployed domain or open the site in an incognito/private window.

5. Verify that there is no `favicon.ico`, `vite.svg`, service worker, or other fallback asset left inside `frontend/public/`.

In this project, the expected favicon source is:

```html
<link rel="icon" type="image/png" href="/lumiere-sync-logo.png" />
```

---

## 📌 Project Summary

Lumiere is more than a watch-party app. It is a **real-time collaborative workspace** designed around synchronized shared experiences, social connection, memory-building, and full-stack engineering concepts such as:

- distributed state synchronization
- token-based authentication
- websocket communication
- REST API design
- MongoDB persistence
- collaborative document/media workflows
- user relationship modeling

This makes it a strong BCA final project because it demonstrates both **product thinking** and **technical depth**.

---

## 👨‍💻 Developed By

**Developed by Vishal Chauhan | BCA 2026**
