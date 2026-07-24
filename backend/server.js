/**
 * server.js is the thin 2-GATHER backend bootstrap after the refactor. It wires
 * together config, utilities, models, services, middleware, routers, and the
 * socket layer, but intentionally leaves business logic inside the extracted
 * services/routes/sockets modules.
 *
 * Layer responsibilities:
 * - config/: environment-backed constants, Firebase admin, and CORS policy
 * - utils/: shared sanitization, normalization, rate limiting, presence, and logging helpers
 * - models/: Mongo initialization plus the re-exported Mongoose models
 * - services/: business logic for profiles, friends, sessions, rooms, memories, and more
 * - middleware/: request authentication and final error serialization
 * - routes/: thin HTTP endpoints mounted under /api
 * - sockets/: realtime room state, helpers, auth, and event registration
 */
"use strict";

// Always resolve the backend env file from this directory so `node backend/server.js`
// and root-level `npm start` both load the same Firebase/Mongo credentials.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

// Config imports centralize environment-backed constants, admin checks, CORS,
// and Firebase admin bootstrapping in one place.
const {
  PORT, CLIENT_ORIGIN, CLIENT_ORIGINS, NODE_ENV,
  JSON_BODY_LIMIT, ROOM_EXPIRY_MS, MAX_MESSAGE_LENGTH,
  MAX_ROOM_USERS, MAX_VIDEO_TIME, SYNC_WAIT_THRESHOLD,
  SYNC_RESUME_THRESHOLD, SYNC_WAIT_GRACE_MS,
  SYNC_WAIT_COOLDOWN_MS, SYNC_RESUME_GRACE_MS,
  SYNC_BUFFER_LOW_SECONDS, SYNC_NON_BUFFERING_EXTRA_GAP,
  MEMBER_TIME_TTL_MS, WATCH_MEMORY_MIN_SECONDS,
  MAX_WATCHLIST_ITEMS, MAX_WATCHLIST_TITLE_LENGTH,
  MAX_WATCHLIST_URL_LENGTH, MAX_WATCHLIST_NOTES_LENGTH,
  MAX_SHARED_MEMORY_NOTE_LENGTH, MAX_SHARED_MEMORY_GENRE_LENGTH,
  MAX_SHARED_MEMORY_MOOD_LENGTH,
  MAX_SHARED_MEMORY_HIGHLIGHT_LENGTH,
  MAX_SHARED_MEMORY_SESSION_MINUTES,
  MAX_SHARED_MEMORY_REACTION_COUNT, MAX_ROOM_MOOD_TAG_LENGTH,
  MAX_CONTENT_URL_LENGTH, MAX_SESSION_HIGHLIGHTS,
  MAX_SESSION_REACTIONS, MAX_INSIGHT_SUMMARY_LENGTH,
  MAX_ROOM_HISTORY_ITEMS, MAX_VIDEO_NAME_LENGTH,
  HTTP_RATE_LIMIT_WINDOW_MS, HTTP_RATE_LIMIT_MAX,
  HTTP_AUTH_RATE_LIMIT_MAX, SOCKET_EVENT_WINDOW_MS,
  SOCKET_EVENT_MAX, SYNC_HEARTBEAT_MS, VIDEO_SCHEDULE_LEAD_MS,
  MAX_DOCUMENT_UPLOAD_BYTES, DOCUMENT_UPLOAD_TTL_MS,
  READING_PAGE_LOCK_MS, READING_PAGE_MAX,
  AUDIO_SCHEDULE_LEAD_MS, AUDIO_MUTATION_LOCK_MS,
  AUDIO_TOGGLE_DEBOUNCE_MS, USERNAME_REGEX, MAX_BIO_LENGTH,
  MAX_PHOTO_URL_LENGTH, DEFAULT_SETTINGS, ALLOWED_SESSION_MODES,
  ALLOWED_CONTENT_TYPES, ALLOWED_RELATIONSHIP_TYPES,
  ALLOWED_REACTION_TYPES, DEFAULT_DEV_ORIGINS,
  ADMIN_UIDS, isAdminUser, SESSION_ENGINE_REGISTRY,
} = require("./config/constants.js");
// Utils imports provide shared sanitization, normalization, helper math,
// rate limiting, presence tracking, and structured logging.
const {
  escapeAngleBrackets, sanitize, sanitizeBio,
  sanitizePhotoURL, sanitizeContentUrl,
  sanitizeUploadFileName, sanitizeRoomMoodTag,
  sanitizeActivityPayload, sanitizeSharedMemoryGenre,
  sanitizeSharedMemoryMoodTag,
} = require("./utils/sanitize.js");
const {
  normalizeUsername, normalizeRoomType,
  normalizeSessionMode,
  normalizeContentType, normalizeMetadataForSessionEngine,
  normalizeRoomDocumentPayload,
  normalizeDocumentMimeType, normalizeReadingTotalPages,
} = require("./utils/normalize.js");
const {
  clampTime, clampReadingPage, uniqueStrings,
  buildDocumentSignature,
  deriveDocumentFileNameFromUrl,
  createDocumentUploadId, serializeRoomDocument,
  serializeReadingState, resolveSessionEngine,
  resolveVideoState, addRoomHistory,
  getProfileStoreCopy, pushBounded,
} = require("./utils/helpers.js");
const {
  httpRateLimitHits, httpAuthRateLimitHits,
  socketEventRateLimitHits, cleanupRateLimitStore,
  isRateLimitExceeded, getRequestRateKey,
  applyHttpRateLimit, isSocketEventRateLimited,
  clearSocketEventRateLimits,
} = require("./utils/rateLimit.js");
const {
  onlineSocketsByUid, markOnline, markOffline,
  isOnline, socketIdsForUser,
  touchLastSeen,
} = require("./utils/presence.js");
const { log, warn, error } = require("./utils/logger.js");
// Models are imported through db.js so Mongo init and model re-exports live behind one module boundary.
const { memoryStore } = require("./models/memoryStore.js");
const {
  initMongo, getMongoConnected,
  UserProfileModel, MemoryEventModel,
  CoupleSpaceModel, RelationshipModel,
  RoomModel, RoomParticipantModel,
  InviteModel, ActivityEventModel,
  VideoSessionModel, ChatArchiveModel,
  SharedMemoryModel, NotificationModel,
  WatchSessionModel, SessionReactionModel,
  MilestoneModel, InsightModel,
} = require("./models/db.js");
// Services hold extracted business logic for profiles, social graphs, sessions,
// notifications, documents, insights, admin reporting, and room persistence.
const {
  buildBaseProfile, normalizeProfile,
  publicProfile, relationshipWith,
  getProfileByUid, saveProfile,
  ensureProfile, listProfilesByUids,
  isUsernameAvailable, claimUsername,
  searchProfiles,
} = require("./services/profile.service.js");
const {
  normalizeRelationshipType,
  sortedPairUsers, pairKeyFromUsers,
  normalizeWatchlistItem, mapCoupleSpace,
  getCoupleSpaceByUsers, saveCoupleSpace,
  getRelationshipRow, setRelationshipState,
  setRelationshipType, getRelationshipByPairKey,
} = require("./services/relationship.service.js");
const {
  createEmptyFriendGraph,
  buildFriendGraphFromRows,
  listRelationshipRowsForUser,
  listFriendGraph, areUsersFriends,
  relationshipWithGraph, sendFriendRequest,
  respondFriendRequest,
} = require("./services/friends.service.js");
const {
  getValidatedCoupleUsers,
} = require("./services/watchlist.service.js");
const {
  addMemoryEvent, listMemoryEventsForUser,
  aggregateMemories, sanitizeSharedMemoryNote,
  sanitizeHighlightTimestamp, clampSharedSessionMinutes,
  clampReactionCount, normalizeSharedMemoryRow,
  createSharedMemory, listSharedMemoriesForUser,
} = require("./services/memory.service.js");
const {
  logActivity, touchRoomActivity,
  saveVideoSessionMetadata, archiveChatMessage,
  listActivityForUser, listWatchSessionsForUser,
  listWatchSessionsForRelationship,
  normalizeReactionType, normalizeSessionHighlightRow,
  normalizeWatchSessionRow, getVideoSessionByRoomCode,
} = require("./services/session.service.js");
const {
  normalizeNotificationType, normalizeNotificationRow,
  createNotification, listNotificationsForUser,
  markNotificationRead, markAllNotificationsRead,
  countUnreadNotifications, markNotificationsReadByReference,
} = require("./services/notification.service.js");
const {
  pruneExpiredDocumentUploads,
  getUploadedDocumentById,
  upsertDocumentUpload,
} = require("./services/document.service.js");
const {
  normalizeMilestoneType, normalizeMilestoneRow,
  normalizeInsightRow, milestoneStoreKey,
  upsertMilestone, listMilestonesForUser,
  upsertInsight, getInsightForPairYear,
  regenerateRelationshipInsight,
  listInsightsForUser,
} = require("./services/insight.service.js");
const { createInviteRecord } = require("./services/invite.service.js");
const { getProjectOverview } = require("./services/admin.service.js");
const {
  getRoomMetadataByCode, listRoomParticipantsByCode,
  normalizePlaybackStatus, clampSessionDuration,
  toUtcDayTimestamp, computeRollingStreak,
  timeSlotFromDate, topLabelsFromCounter,
  normalizeSessionReactionRow, relationshipTypeFromRoomType,
  buildPreferenceSnapshotFromSessions,
  createWatchSession, recordSessionReaction,
  listRoomReactions, countRoomReactions,
  attachSessionIdToRoomReactions, summarizeMoodTrend,
  summarizeWatchPattern, inferGenreFromSession,
  refreshUserAnalytics, refreshRelationshipAnalytics,
  resolveRelationshipContextForSession,
  buildSessionHighlightsFromReactions,
  updateAnalyticsFromWatchSession,
  roomParticipantKey, upsertRoomMetadata,
  markRoomInactive, updateRoomContentState,
  updateRoomCreator, updateRoomPlaybackState,
  upsertRoomParticipant, markRoomParticipantLeft,
  listDistinctParticipantsForRoom,
  finalizeVideoSession,
} = require("./services/room.service.js");
// Middleware handles request auth and last-resort error serialization.
const jwt = require("jsonwebtoken");
const { requireHttpAuth } = require("./middleware/auth.js");
const { errorHandler } = require("./middleware/errorHandler.js");
// Socket imports provide shared runtime maps, utility helpers, the shared io
// getter/setter, and the extracted socket registration entrypoint.
const { setIo } = require("./sockets/socketHub.js");
const {
  rooms, pendingRoomUserDisconnects,
} = require("./sockets/roomStore.js");
const {
  roomUserDisconnectKey, clearPendingRoomUserDisconnect,
  clearPendingRoomDisconnects,
  schedulePendingRoomUserDisconnect, makeRoom,
  resolveMusicMediaType, shouldScheduleVideoPlayback,
  getScheduledVideoStartAt, buildRoomMusicStatePayload,
  resolveRoomAudioPosition, acquireAudioMutationLock,
  validateMusicControlRequest, broadcastRoomAudioSync,
  getRoomReadingStatePayload, getRoomDocumentPayload,
  buildReadingInitialStatePayload,
  pickNextRoomHostUid, ensureRoomUserSocketSet,
  getRoomUserSocketIds, upsertRoomUser,
  removeSocketFromRoomUser, emitToRoomUserSockets,
  emitToUidSocketsInRoom, scheduleExpiry, expireRoom,
  deleteIfEmpty, generateCode, getUserList,
  clearSyncWait, getActiveMemberTimes,
  isMemberLikelyBuffering, handleSyncWait,
  recordOverlapForLeavingUser,
} = require("./sockets/roomUtils.js");
const { registerSocketHandlers } = require("./sockets/index.js");
// Route imports mount the extracted HTTP surface under the shared /api prefix.
const uploadsRouter = require("./routes/uploads.routes.js");
const profileRouter = require("./routes/profile.routes.js");
const friendsRouter = require("./routes/friends.routes.js");
const watchlistRouter = require("./routes/watchlist.routes.js");
const memoriesRouter = require("./routes/memories.routes.js");
const roomsRouter = require("./routes/rooms.routes.js");
const notificationsRouter = require("./routes/notifications.routes.js");
const insightsRouter = require("./routes/insights.routes.js");
const adminRouter = require("./routes/admin.routes.js");
const authRouter = require("./routes/auth.routes.js");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const cors = require("cors");
// Express setup configures trust proxy, explicit CORS handling, JSON parsing,
// and helmet before any routes run. `trust proxy` ensures correct client IPs
// for rate limiting when the app sits behind a proxy.
const app = express();
app.set("trust proxy", 1);

const corsOptions = {
  origin: true,
  methods: ["GET", "POST", "PATCH"],
  credentials: true,
};

// Middleware registration order matters: security headers/CORS/body parsing
// run first, the shared API rate limiter wraps /api, then routes mount, and
// the global error handler stays last so it can catch downstream failures.
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use("/api", applyHttpRateLimit(HTTP_RATE_LIMIT_MAX, "http"));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    mongoConnected: getMongoConnected(),
    inMemoryFallback: !getMongoConnected(),
  });
});

// Route mounting keeps every extracted router under /api so the bootstrap file
// stays declarative and all HTTP business logic remains in route/service files.
app.use("/api", uploadsRouter);
app.use("/api", profileRouter);
app.use("/api", friendsRouter);
app.use("/api", watchlistRouter);
app.use("/api", memoriesRouter);
app.use("/api", roomsRouter);
app.use("/api", notificationsRouter);
app.use("/api", insightsRouter);
app.use("/api", adminRouter);
app.use("/api/auth", authRouter);
app.use(errorHandler);

// http.createServer wraps Express so Socket.IO can share the same HTTP server.
// Socket.IO reuses the CORS policy and heartbeat settings for the realtime layer.
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  pingTimeout: 20000,
  pingInterval: 10000,
});
// setIo publishes the live io instance immediately so routes/services can emit outside socket handlers.
setIo(io);

// Heartbeat sync_state broadcasts keep long-running non-music rooms converged
// even if a client misses an earlier play/pause/seek event.
setInterval(() => {
  // Heartbeats keep long-running sessions converged even if a client misses a
  // user-triggered play/pause/seek event.
  rooms.forEach((room, roomCode) => {
    if (!room || room.users.size === 0 || room.sessionMode === "music") return;
    room.videoState = resolveVideoState(room.videoState);
    io.to(roomCode).emit("sync_state", { videoState: room.videoState, serverTime: Date.now() / 1000 });
  });
}, SYNC_HEARTBEAT_MS);

// Document pruning enforces the in-memory upload TTL by removing expired PDFs
// on a fraction of the TTL, but never more often than once per minute.
setInterval(() => {
  pruneExpiredDocumentUploads();
}, Math.max(60000, Math.floor(DOCUMENT_UPLOAD_TTL_MS / 6))).unref?.()
// Socket auth verifies the Firebase token, rebuilds a trusted identity,
// hydrates/creates the profile, and opportunistically claims a username if the
// client asked for one and the account does not already have one.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication token missing"));

    const JWT_SECRET = process.env.JWT_SECRET || '2-gather-super-secret-key-for-dev';
    const decoded = jwt.verify(token, JWT_SECRET);
    const identity = {
      uid: decoded.uid,
      name: decoded.name || decoded.email || "Anonymous",
      email: decoded.email || "",
      phoneNumber: "",
      photoURL: "",
    };

    let profile = await ensureProfile(identity);
    const requestedUsername = normalizeUsername(socket.handshake.auth?.username || "");

    // Socket auth opportunistically fills in a missing username so a freshly
    // created account can still enter the realtime layer immediately.
    if (!profile.username && requestedUsername && USERNAME_REGEX.test(requestedUsername)) {
      try {
        profile = await claimUsername(identity.uid, requestedUsername);
      } catch {
        // ignore claim race on socket connect; frontend handles explicit username claim
      }
    }

    socket.user = {
      uid: identity.uid,
      name: profile.displayName || identity.name,
      username: profile.username || requestedUsername || normalizeUsername(identity.email.split("@")[0]) || "user",
      photoURL: sanitizePhotoURL(profile.photoURL || identity.photoURL || ""),
      email: profile.email || identity.email,
    };

    return next();
  } catch (err) {
    error("Token verification failed:", err.message);
    return next(new Error("Authentication failed"));
  }
});

// roomRuntime bundles hot realtime dependencies into one object so the socket
// layer receives explicit helpers instead of pulling them in via deep imports.
const roomRuntime = {
  rooms,
  pendingRoomUserDisconnects,
  MAX_ROOM_USERS,
  READING_PAGE_LOCK_MS,
  AUDIO_SCHEDULE_LEAD_MS,
  AUDIO_TOGGLE_DEBOUNCE_MS,
  generateCode,
  normalizeRoomType,
  normalizeSessionMode,
  normalizeMetadataForSessionEngine,
  sanitizeRoomMoodTag,
  makeRoom,
  scheduleExpiry,
  upsertRoomUser,
  addRoomHistory,
  getUserList,
  getRoomReadingStatePayload,
  getRoomDocumentPayload,
  buildReadingInitialStatePayload,
  clearPendingRoomUserDisconnect,
  resolveSessionEngine,
  normalizeRoomDocumentPayload,
  normalizeReadingTotalPages,
  clampReadingPage,
  clampTime,
  validateMusicControlRequest,
  acquireAudioMutationLock,
  resolveRoomAudioPosition,
  buildRoomMusicStatePayload,
  broadcastRoomAudioSync,
  clearSyncWait,
  getScheduledVideoStartAt,
  resolveMusicMediaType,
  deriveDocumentFileNameFromUrl,
  emitToUidSocketsInRoom,
  handleSyncWait,
  removeSocketFromRoomUser,
  getRoomUserSocketIds,
  schedulePendingRoomUserDisconnect,
  deleteIfEmpty,
  pickNextRoomHostUid,
  recordOverlapForLeavingUser,
};

// roomService bundles persistence-oriented helpers and models used by socket handlers.
const roomService = {
  log,
  error,
  archiveChatMessage,
  touchRoomActivity,
  recordSessionReaction,
  logActivity,
  getMongoConnected,
  UserProfileModel,
  memoryStore,
  upsertRoomMetadata,
  upsertRoomParticipant,
  updateRoomContentState,
  saveVideoSessionMetadata,
  updateRoomPlaybackState,
  markRoomParticipantLeft,
  updateRoomCreator,
};

// registerSocketHandlers wires the extracted auth/connection/event handler tree onto the shared io instance.
registerSocketHandlers(io, {
  roomRuntime,
  roomService,
});

// start() performs the boot sequence: connect Mongo first, then listen so the
// process only announces readiness after persistence initialization succeeds.
async function start() {
  await initMongo();

  httpServer.listen(PORT, () => {
    log(`2-GATHER server running on port ${PORT}`);
    log(`Client origin: ${CLIENT_ORIGIN}`);
    if (CLIENT_ORIGINS.length > 1) {
      log(`Allowed origins: ${CLIENT_ORIGINS.join(", ")}`);
    }
  });
}

start().catch((err) => {
  error("Server start failed:", err);
  process.exit(1);
});

// shutdown() gracefully expires live rooms, closes Mongo when present, then
// stops the shared HTTP/socket server.
async function shutdown() {
  rooms.forEach((_, code) => expireRoom(code));

  if (getMongoConnected() && UserProfileModel?.db?.close) {
    try {
      await UserProfileModel.db.close();
    } catch {
      // noop
    }
  }

  httpServer.close(() => process.exit(0));
}

// Process handlers funnel OS signals and unhandled promise failures into one
// consistent shutdown/logging path for local dev and production.
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (err) => {
  return error("Unhandled rejection:", err);
});
