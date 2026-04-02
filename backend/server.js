/**
 * Lumiere Backend Server
 * - Realtime room sync + chat + calls
 * - Profile/Friends/Invite/Memories APIs
 * - MongoDB support with in-memory fallback
 */
"use strict";

require("dotenv").config();

const {
  PORT, CLIENT_ORIGIN, CLIENT_ORIGINS, MONGODB_URI, NODE_ENV,
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

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const helmet = require("helmet");
const cors = require("cors");

let mongoose = null;
try {
  mongoose = require("mongoose");
} catch {
  warn("[db] mongoose not installed. Running with in-memory fallback.");
}

// ─── Firebase ─────────────────────────────────────────────────────────────────
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    error("Bad FIREBASE_SERVICE_ACCOUNT JSON:", err.message);
    process.exit(1);
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
}

admin.initializeApp(
  serviceAccount
    ? { credential: admin.credential.cert(serviceAccount) }
    : { credential: admin.credential.applicationDefault() }
);

// ─── DB Setup ─────────────────────────────────────────────────────────────────
let mongoConnected = false;
let UserProfileModel = null;
let MemoryEventModel = null;
let CoupleSpaceModel = null;
let RelationshipModel = null;
let RoomModel = null;
let RoomParticipantModel = null;
let InviteModel = null;
let ActivityEventModel = null;
let VideoSessionModel = null;
let ChatArchiveModel = null;
let SharedMemoryModel = null;
let NotificationModel = null;
let WatchSessionModel = null;
let SessionReactionModel = null;
let MilestoneModel = null;
let InsightModel = null;

const memoryStore = {
  // This mirrors the main Mongo-backed entities so the app can still run when
  // mongoose is unavailable during local development or transient DB outages.
  profiles: new Map(), // uid -> profile
  memoryEvents: [], // { users:[uidA,uidB], seconds, occurredAt }
  coupleSpaces: new Map(), // pairKey -> { pairKey, users:[uidA,uidB], watchlist:[] }
  relationships: new Map(), // pairKey -> relationship row
  rooms: new Map(), // roomCode -> metadata row
  roomParticipants: new Map(), // roomCode__uid -> participant row
  invites: [], // invite rows
  notifications: [], // notification rows
  activityEvents: [], // activity rows
  videoSessions: new Map(), // roomCode -> session metadata
  chatMessages: [], // optional persistent chat rows
  sharedMemories: [], // shared memory rows
  watchSessions: [], // long-term session rows
  sessionReactions: [], // reaction rows
  milestones: new Map(), // pairKey__type -> milestone row
  insights: [], // yearly relationship insights
  uploadedDocuments: new Map(), // documentId -> { id, ownerUid, fileName, mimeType, bytes, base64Data, createdAt, expiresAt }
};

if (mongoose) {
  const userProfileSchema = new mongoose.Schema(
    {
      uid: { type: String, required: true, unique: true, index: true },
      username: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
      displayName: { type: String, default: "" },
      photoURL: { type: String, default: "" },
      email: { type: String, default: "" },
      phoneNumber: { type: String, default: "" },
      bio: { type: String, default: "" },
      friends: { type: [String], default: [] },
      incomingRequests: { type: [String], default: [] },
      outgoingRequests: { type: [String], default: [] },
      settings: {
        inviteNotifications: { type: Boolean, default: true },
        memoryNudges: { type: Boolean, default: true },
        showOnlineStatus: { type: Boolean, default: true },
      },
      totalWatchTime: { type: Number, default: 0 },
      totalSessions: { type: Number, default: 0 },
      streakCount: { type: Number, default: 0 },
      lastSessionAt: { type: Date, default: null },
      preferences: {
        favoriteGenres: { type: [String], default: [] },
        activeTimeSlots: { type: [String], default: [] },
      },
      lastSeenAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
  );

  const memoryEventSchema = new mongoose.Schema(
    {
      users: { type: [String], required: true, index: true }, // exactly 2 user ids sorted
      seconds: { type: Number, required: true },
      occurredAt: { type: Date, required: true, default: Date.now, index: true },
      roomCode: { type: String, default: "" },
    },
    { timestamps: true }
  );

  const watchlistItemSchema = new mongoose.Schema(
    {
      id: { type: String, required: true },
      title: { type: String, required: true },
      url: { type: String, default: "" },
      notes: { type: String, default: "" },
      done: { type: Boolean, default: false },
      addedBy: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
    },
    { _id: false }
  );

  const coupleSpaceSchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, unique: true, index: true },
      users: { type: [String], required: true },
      watchlist: { type: [watchlistItemSchema], default: [] },
      updatedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
  );

  const relationshipSchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, unique: true, index: true },
      users: { type: [String], required: true, index: true }, // sorted 2-user pair
      requesterUid: { type: String, default: "", index: true },
      recipientUid: { type: String, default: "", index: true },
      status: { type: String, enum: ["pending", "accepted", "rejected", "blocked"], default: "pending", index: true },
      relationshipType: { type: String, enum: ["couple", "friends", "family"], default: "friends", index: true },
      totalWatchTime: { type: Number, default: 0 },
      totalSessions: { type: Number, default: 0 },
      longestSession: { type: Number, default: 0 },
      streak: { type: Number, default: 0 },
      firstWatchedAt: { type: Date, default: null },
      lastWatchedAt: { type: Date, default: null },
      topGenres: { type: [String], default: [] },
      activeTimeSlots: { type: [String], default: [] },
      lastSessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch" },
      requestedBy: { type: String, default: "", index: true },
      lastActionBy: { type: String, default: "", index: true },
      lastActionAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
  );

  const roomSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, unique: true, index: true },
      roomType: { type: String, enum: ["duo", "family", "friends"], default: "friends", index: true },
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true },
      createdBy: { type: String, required: true, index: true },
      isActive: { type: Boolean, default: true, index: true },
      roomPasswordHash: { type: String, default: "" },
      maxParticipants: { type: Number, default: MAX_ROOM_USERS },
      moodTag: { type: String, default: "", index: true },
      contentUrl: { type: String, default: "" },
      contentType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown", index: true },
      playbackStatus: { type: String, enum: ["idle", "playing", "paused"], default: "idle", index: true },
      baseTime: { type: Number, default: 0 },
      startedAt: { type: Date, default: null },
      permissions: {
        play: { type: Boolean, default: true },
        pause: { type: Boolean, default: true },
        seek: { type: Boolean, default: true },
        skip: { type: Boolean, default: true },
      },
      createdAt: { type: Date, default: Date.now, index: true },
      expiresAt: { type: Date, default: Date.now, index: true },
      closedAt: { type: Date, default: null },
      lastActivityAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  );

  const roomParticipantSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true },
      userId: { type: String, required: true, index: true },
      joinedAt: { type: Date, required: true, default: Date.now, index: true },
      leftAt: { type: Date, default: null },
      role: { type: String, default: "member" },
      isActive: { type: Boolean, default: true, index: true },
    },
    { timestamps: true }
  );

  const inviteSchema = new mongoose.Schema(
    {
      fromUid: { type: String, required: true, index: true },
      toUid: { type: String, required: true, index: true },
      roomCode: { type: String, required: true, index: true },
      status: { type: String, enum: ["sent", "seen", "accepted", "expired"], default: "sent", index: true },
      createdAt: { type: Date, default: Date.now, index: true },
      respondedAt: { type: Date, default: null },
    },
    { timestamps: true }
  );

  const activityEventSchema = new mongoose.Schema(
    {
      uid: { type: String, required: true, index: true },
      type: { type: String, required: true, index: true },
      roomCode: { type: String, default: "", index: true },
      targetUid: { type: String, default: "", index: true },
      payload: { type: mongoose.Schema.Types.Mixed, default: {} },
      occurredAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  );

  const videoSessionSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, unique: true, index: true },
      videoName: { type: String, default: "" },
      duration: { type: Number, default: 0 },
      sourceType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown" },
      fileFingerprint: { type: String, default: "" },
      contentUrl: { type: String, default: "" },
      startedAt: { type: Date, default: Date.now },
      endedAt: { type: Date, default: null },
      totalWatchTime: { type: Number, default: 0 },
      updatedBy: { type: String, default: "", index: true },
    },
    { timestamps: true }
  );

  const chatArchiveSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true },
      messageId: { type: String, required: true, unique: true },
      uid: { type: String, required: true, index: true },
      senderName: { type: String, default: "" },
      senderUsername: { type: String, default: "" },
      text: { type: String, default: "" },
      type: { type: String, default: "text" },
      timestamp: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  );

  const sharedMemorySchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, index: true },
      user1Id: { type: String, required: true, index: true },
      user2Id: { type: String, required: true, index: true },
      roomCode: { type: String, default: "", index: true },
      date: { type: Date, default: Date.now, index: true },
      memoryNote: { type: String, default: "" },
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true },
      genre: { type: String, default: "" },
      moodTag: { type: String, default: "" },
      highlightTimestamp: { type: String, default: "" },
      sessionMinutes: { type: Number, default: 0 },
      reactionCount: { type: Number, default: 0 },
      createdBy: { type: String, required: true, index: true },
    },
    { timestamps: true }
  );

  const sessionHighlightSchema = new mongoose.Schema(
    {
      timestamp: { type: Number, default: 0 },
      type: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction" },
      userUid: { type: String, default: "" },
      reactionType: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction" },
      emoji: { type: String, default: "" },
      createdAt: { type: Date, default: Date.now },
    },
    { _id: false }
  );

  const watchSessionSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true },
      roomId: { type: String, default: "", index: true },
      roomType: { type: String, enum: ["duo", "family", "friends"], default: "friends", index: true },
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true },
      participants: { type: [String], required: true, index: true },
      relationshipId: { type: String, default: "", index: true },
      relationshipType: { type: String, enum: ALLOWED_RELATIONSHIP_TYPES, default: "group", index: true },
      contentUrl: { type: String, default: "" },
      contentTitle: { type: String, default: "" },
      contentType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown", index: true },
      genre: { type: String, default: "" },
      moodTag: { type: String, default: "", index: true },
      duration: { type: Number, default: 0 },
      startedAt: { type: Date, default: Date.now, index: true },
      endedAt: { type: Date, default: Date.now, index: true },
      reactionsCount: { type: Number, default: 0 },
      highlights: { type: [sessionHighlightSchema], default: [] },
      createdBy: { type: String, default: "", index: true },
    },
    { timestamps: true }
  );

  const sessionReactionSchema = new mongoose.Schema(
    {
      sessionId: { type: String, default: "", index: true },
      roomCode: { type: String, default: "", index: true },
      userUid: { type: String, required: true, index: true },
      messageId: { type: String, default: "", index: true },
      timestamp: { type: Number, default: 0 },
      reactionType: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction", index: true },
      emoji: { type: String, default: "" },
      createdAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  );

  const milestoneSchema = new mongoose.Schema(
    {
      relationshipId: { type: String, default: "", index: true },
      pairKey: { type: String, default: "", index: true },
      users: { type: [String], default: [], index: true },
      type: { type: String, required: true, index: true },
      achievedAt: { type: Date, default: Date.now, index: true },
      payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
  );

  const insightSchema = new mongoose.Schema(
    {
      relationshipId: { type: String, default: "", index: true },
      pairKey: { type: String, default: "", index: true },
      users: { type: [String], default: [], index: true },
      year: { type: Number, required: true, index: true },
      summaryText: { type: String, default: "" },
      favoriteGenre: { type: String, default: "" },
      watchPattern: { type: String, default: "" },
      moodTrend: { type: String, default: "" },
      generatedAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  );

  const notificationSchema = new mongoose.Schema(
    {
      recipientUid: { type: String, required: true, index: true },
      senderUid: { type: String, default: "", index: true },
      type: { type: String, required: true, index: true },
      referenceId: { type: String, default: "", index: true },
      roomCode: { type: String, default: "", index: true },
      payload: { type: mongoose.Schema.Types.Mixed, default: {} },
      actionRequired: { type: Boolean, default: false, index: true },
      isRead: { type: Boolean, default: false, index: true },
      readAt: { type: Date, default: null },
      createdAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  );

  userProfileSchema.index({ username: 1 }, { unique: true, sparse: true });
  userProfileSchema.index(
    { email: 1 },
    {
      unique: true,
      partialFilterExpression: { email: { $type: "string", $ne: "" } },
    }
  );
  userProfileSchema.index(
    { phoneNumber: 1 },
    {
      unique: true,
      partialFilterExpression: { phoneNumber: { $type: "string", $ne: "" } },
    }
  );
  memoryEventSchema.index({ users: 1, occurredAt: -1 });
  coupleSpaceSchema.index({ users: 1 });
  relationshipSchema.index({ users: 1 });
  relationshipSchema.index({ requesterUid: 1, status: 1, updatedAt: -1 });
  relationshipSchema.index({ recipientUid: 1, status: 1, updatedAt: -1 });
  roomParticipantSchema.index({ roomCode: 1, userId: 1 }, { unique: true });
  inviteSchema.index({ toUid: 1, createdAt: -1 });
  activityEventSchema.index({ uid: 1, occurredAt: -1 });
  chatArchiveSchema.index({ roomCode: 1, timestamp: -1 });
  sharedMemorySchema.index({ pairKey: 1, date: -1 });
  watchSessionSchema.index({ participants: 1, endedAt: -1 });
  watchSessionSchema.index({ relationshipId: 1, endedAt: -1 });
  watchSessionSchema.index({ roomCode: 1, endedAt: -1 });
  watchSessionSchema.index(
    { roomId: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { roomId: { $type: "string", $ne: "" } },
    }
  );
  sessionReactionSchema.index({ sessionId: 1, createdAt: -1 });
  sessionReactionSchema.index({ roomCode: 1, createdAt: -1 });
  sessionReactionSchema.index({ userUid: 1, createdAt: -1 });
  milestoneSchema.index({ pairKey: 1, achievedAt: -1 });
  milestoneSchema.index(
    { pairKey: 1, type: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { pairKey: { $type: "string", $ne: "" }, type: { $type: "string", $ne: "" } },
    }
  );
  milestoneSchema.index({ users: 1, achievedAt: -1 });
  insightSchema.index({ pairKey: 1, generatedAt: -1 });
  insightSchema.index(
    { pairKey: 1, year: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { pairKey: { $type: "string", $ne: "" } },
    }
  );
  insightSchema.index({ users: 1, year: -1 });
  notificationSchema.index({ recipientUid: 1, isRead: 1, createdAt: -1 });
  notificationSchema.index({ recipientUid: 1, actionRequired: 1, createdAt: -1 });

  UserProfileModel = mongoose.models.UserProfile || mongoose.model("UserProfile", userProfileSchema);
  MemoryEventModel = mongoose.models.MemoryEvent || mongoose.model("MemoryEvent", memoryEventSchema);
  CoupleSpaceModel = mongoose.models.CoupleSpace || mongoose.model("CoupleSpace", coupleSpaceSchema);
  RelationshipModel = mongoose.models.Relationship || mongoose.model("Relationship", relationshipSchema);
  RoomModel = mongoose.models.Room || mongoose.model("Room", roomSchema);
  RoomParticipantModel = mongoose.models.RoomParticipant || mongoose.model("RoomParticipant", roomParticipantSchema);
  InviteModel = mongoose.models.Invite || mongoose.model("Invite", inviteSchema);
  ActivityEventModel = mongoose.models.ActivityEvent || mongoose.model("ActivityEvent", activityEventSchema);
  VideoSessionModel = mongoose.models.VideoSession || mongoose.model("VideoSession", videoSessionSchema);
  ChatArchiveModel = mongoose.models.ChatArchive || mongoose.model("ChatArchive", chatArchiveSchema);
  SharedMemoryModel = mongoose.models.SharedMemory || mongoose.model("SharedMemory", sharedMemorySchema);
  WatchSessionModel = mongoose.models.WatchSession || mongoose.model("WatchSession", watchSessionSchema);
  SessionReactionModel = mongoose.models.SessionReaction || mongoose.model("SessionReaction", sessionReactionSchema);
  MilestoneModel = mongoose.models.Milestone || mongoose.model("Milestone", milestoneSchema);
  InsightModel = mongoose.models.Insight || mongoose.model("Insight", insightSchema);
  NotificationModel = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
}

async function initMongo() {
  if (!mongoose) return;
  if (!MONGODB_URI) {
    warn("[db] MONGODB_URI missing. Using in-memory fallback for social features.");
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 6000,
    });
    mongoConnected = true;
    log("[db] MongoDB connected");
  } catch (err) {
    mongoConnected = false;
    error("[db] MongoDB connection failed. Using in-memory fallback:", err.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isPrivateLanHost(hostname) {
  return /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
}

function isAllowedOrigin(origin) {
  if (!origin || CLIENT_ORIGINS.includes(origin)) return true;
  if (NODE_ENV === "production") return false;

  try {
    const parsed = new URL(origin);
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || isPrivateLanHost(host);
  } catch {
    return false;
  }
}

function normalizeRoomDocumentPayload(payload = {}) {
  // Co-reading treats the shared document as room-level source of truth, so we
  // normalize and validate the full payload before mutating room state.
  const fileUrl = sanitizeContentUrl(payload.fileUrl || payload.url || "");
  if (!fileUrl) {
    const error = new Error("A shareable PDF URL is required");
    error.status = 400;
    throw error;
  }

  const fallbackName = deriveDocumentFileNameFromUrl(fileUrl) || "shared-document.pdf";
  const fileName = sanitizeUploadFileName(payload.fileName || fallbackName);
  const mimeType = normalizeDocumentMimeType(payload.mimeType || "application/pdf", fileName);
  if (mimeType !== "application/pdf") {
    const error = new Error("Only PDF files are supported in co-reading");
    error.status = 400;
    throw error;
  }

  const fileSize = Math.max(0, Math.floor(Number(payload.fileSize) || 0));
  if (fileSize > MAX_DOCUMENT_UPLOAD_BYTES) {
    const error = new Error(`Document exceeds ${Math.round(MAX_DOCUMENT_UPLOAD_BYTES / (1024 * 1024))}MB limit`);
    error.status = 400;
    throw error;
  }

  return {
    fileUrl,
    fileName,
    fileSize,
    mimeType,
    signature: buildDocumentSignature(fileName, fileSize),
    totalPages: normalizeReadingTotalPages(payload.totalPages),
  };
}

function pruneExpiredDocumentUploads() {
  const now = Date.now();
  memoryStore.uploadedDocuments.forEach((item, id) => {
    const expiresAtMs = item?.expiresAt ? new Date(item.expiresAt).getTime() : 0;
    if (!expiresAtMs || expiresAtMs <= now) {
      memoryStore.uploadedDocuments.delete(id);
    }
  });
}

function getUploadedDocumentById(documentId) {
  const id = String(documentId || "").trim();
  if (!id) return null;
  const row = memoryStore.uploadedDocuments.get(id);
  if (!row) return null;
  if (!row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) {
    memoryStore.uploadedDocuments.delete(id);
    return null;
  }
  return row;
}

function upsertDocumentUpload({ ownerUid, fileName, mimeType, base64Data }) {
  // Uploaded PDFs are short-lived and room-scoped, so we store them in memory
  // with a TTL instead of introducing a heavier object-storage dependency here.
  const normalizedOwnerUid = String(ownerUid || "").trim();
  if (!normalizedOwnerUid) throw new Error("Missing owner uid");
  const normalizedName = sanitizeUploadFileName(fileName);
  const normalizedMime = normalizeDocumentMimeType(mimeType, normalizedName);
  if (!normalizedMime) throw new Error("Unsupported document type");

  const normalizedBase64 = String(base64Data || "").trim();
  if (!normalizedBase64) throw new Error("Document payload is empty");
  if (!/^[a-zA-Z0-9+/=]+$/.test(normalizedBase64)) throw new Error("Invalid base64 payload");

  const bytes = Buffer.byteLength(normalizedBase64, "base64");
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("Invalid document payload");
  if (bytes > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new Error(`Document exceeds ${Math.round(MAX_DOCUMENT_UPLOAD_BYTES / (1024 * 1024))}MB limit`);
  }

  pruneExpiredDocumentUploads();
  const id = createDocumentUploadId();
  const createdAt = new Date();
  const expiresAt = new Date(Date.now() + DOCUMENT_UPLOAD_TTL_MS);
  const row = {
    id,
    ownerUid: normalizedOwnerUid,
    fileName: normalizedName,
    mimeType: normalizedMime,
    bytes,
    base64Data: normalizedBase64,
    createdAt,
    expiresAt,
  };
  memoryStore.uploadedDocuments.set(id, row);
  return row;
}

function buildBaseProfile(identity) {
  // First-time sign-in creates a complete profile shape so the rest of the app
  // can treat missing fields as a data issue instead of a state-shape issue.
  return {
    uid: identity.uid,
    username: "",
    displayName: identity.name || "Anonymous",
    photoURL: identity.photoURL || "",
    email: identity.email || "",
    phoneNumber: identity.phoneNumber || "",
    bio: "",
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    settings: { ...DEFAULT_SETTINGS },
    totalWatchTime: 0,
    totalSessions: 0,
    streakCount: 0,
    lastSessionAt: null,
    preferences: {
      favoriteGenres: [],
      activeTimeSlots: [],
    },
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function normalizeProfile(profile) {
  const totalWatchTime = Math.max(0, Math.floor(Number(profile.totalWatchTime) || 0));
  const totalSessions = Math.max(0, Math.floor(Number(profile.totalSessions) || 0));
  const streakCount = Math.max(0, Math.floor(Number(profile.streakCount) || 0));
  const favoriteGenres = uniqueStrings(
    (Array.isArray(profile.preferences?.favoriteGenres) ? profile.preferences.favoriteGenres : [])
      .map((item) => sanitizeSharedMemoryGenre(item))
      .filter(Boolean)
  ).slice(0, 8);
  const activeTimeSlots = uniqueStrings(
    (Array.isArray(profile.preferences?.activeTimeSlots) ? profile.preferences.activeTimeSlots : [])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
  ).slice(0, 8);
  return {
    ...profile,
    username: normalizeUsername(profile.username || ""),
    displayName: sanitize(String(profile.displayName || "")).slice(0, 60) || "Anonymous",
    photoURL: sanitizePhotoURL(profile.photoURL),
    email: String(profile.email || "").slice(0, 160),
    phoneNumber: String(profile.phoneNumber || "").slice(0, 40),
    bio: sanitizeBio(profile.bio || ""),
    friends: uniqueStrings(profile.friends),
    incomingRequests: uniqueStrings(profile.incomingRequests),
    outgoingRequests: uniqueStrings(profile.outgoingRequests),
    settings: {
      inviteNotifications: profile.settings?.inviteNotifications ?? DEFAULT_SETTINGS.inviteNotifications,
      memoryNudges: profile.settings?.memoryNudges ?? DEFAULT_SETTINGS.memoryNudges,
      showOnlineStatus: profile.settings?.showOnlineStatus ?? DEFAULT_SETTINGS.showOnlineStatus,
    },
    totalWatchTime,
    totalSessions,
    streakCount,
    lastSessionAt: profile.lastSessionAt ? new Date(profile.lastSessionAt) : null,
    preferences: {
      favoriteGenres,
      activeTimeSlots,
    },
    lastSeenAt: profile.lastSeenAt ? new Date(profile.lastSeenAt) : new Date(),
    updatedAt: new Date(),
  };
}

function publicProfile(profile) {
  return {
    uid: profile.uid,
    username: profile.username || "",
    displayName: profile.displayName || "Anonymous",
    photoURL: profile.photoURL || "",
    bio: profile.bio || "",
  };
}

function relationshipWith(profile, targetUid) {
  if (profile.friends.includes(targetUid)) return "friend";
  if (profile.outgoingRequests.includes(targetUid)) return "requested";
  if (profile.incomingRequests.includes(targetUid)) return "incoming";
  return "none";
}

function createEmptyFriendGraph() {
  return {
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    blocked: [],
  };
}

function buildFriendGraphFromRows(selfUid, rows = []) {
  const graph = createEmptyFriendGraph();
  rows.forEach((row) => {
    const users = uniqueStrings(row?.users || []);
    const partnerUid = users.find((uid) => uid !== selfUid);
    if (!partnerUid) return;

    if (row.status === "accepted") {
      graph.friends.push(partnerUid);
      return;
    }
    if (row.status === "blocked") {
      graph.blocked.push(partnerUid);
      return;
    }
    if (row.status !== "pending") return;

    const requesterUid = String(row.requesterUid || row.requestedBy || "");
    if (requesterUid === selfUid) {
      graph.outgoingRequests.push(partnerUid);
    } else {
      graph.incomingRequests.push(partnerUid);
    }
  });

  graph.friends = uniqueStrings(graph.friends);
  graph.incomingRequests = uniqueStrings(graph.incomingRequests);
  graph.outgoingRequests = uniqueStrings(graph.outgoingRequests);
  graph.blocked = uniqueStrings(graph.blocked);
  return graph;
}

async function listRelationshipRowsForUser(uid) {
  const selfUid = String(uid || "").trim();
  if (!selfUid) return [];
  if (mongoConnected) {
    return RelationshipModel.find({ users: selfUid }).sort({ updatedAt: -1 }).lean();
  }
  return [...memoryStore.relationships.values()]
    .filter((row) => Array.isArray(row.users) && row.users.includes(selfUid))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || Date.now()).getTime() - new Date(a.updatedAt || a.createdAt || Date.now()).getTime())
    .map((row) => getProfileStoreCopy(row));
}

async function listFriendGraph(uid) {
  const selfUid = String(uid || "").trim();
  if (!selfUid) return createEmptyFriendGraph();

  if (mongoConnected) {
    const rows = await listRelationshipRowsForUser(selfUid);
    const graph = buildFriendGraphFromRows(selfUid, rows);
    if (graph.friends.length || graph.incomingRequests.length || graph.outgoingRequests.length || graph.blocked.length) {
      return graph;
    }
    // Backward-compat fallback for legacy profiles while friendships are warming up.
    const profile = await getProfileByUid(selfUid);
    if (profile) {
      return {
        friends: uniqueStrings(profile.friends),
        incomingRequests: uniqueStrings(profile.incomingRequests),
        outgoingRequests: uniqueStrings(profile.outgoingRequests),
        blocked: [],
      };
    }
    return graph;
  }

  const profile = await getProfileByUid(selfUid);
  if (!profile) return createEmptyFriendGraph();
  return {
    friends: uniqueStrings(profile.friends),
    incomingRequests: uniqueStrings(profile.incomingRequests),
    outgoingRequests: uniqueStrings(profile.outgoingRequests),
    blocked: [],
  };
}

async function areUsersFriends(uidA, uidB) {
  const graph = await listFriendGraph(uidA);
  return graph.friends.includes(uidB);
}

function relationshipWithGraph(graph, targetUid) {
  if (graph.friends.includes(targetUid)) return "friend";
  if (graph.outgoingRequests.includes(targetUid)) return "requested";
  if (graph.incomingRequests.includes(targetUid)) return "incoming";
  if (graph.blocked.includes(targetUid)) return "blocked";
  return "none";
}

async function getProfileByUid(uid) {
  if (!uid) return null;
  if (mongoConnected) {
    return UserProfileModel.findOne({ uid }).lean();
  }
  const cached = memoryStore.profiles.get(uid);
  return cached ? getProfileStoreCopy(cached) : null;
}

async function saveProfile(profile) {
  const normalized = normalizeProfile(profile);

  if (mongoConnected) {
    await UserProfileModel.updateOne(
      { uid: normalized.uid },
      { $set: normalized, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    return UserProfileModel.findOne({ uid: normalized.uid }).lean();
  }

  const existing = memoryStore.profiles.get(normalized.uid);
  const next = {
    ...(existing || {}),
    ...normalized,
    createdAt: existing?.createdAt || normalized.createdAt || new Date(),
    updatedAt: new Date(),
  };
  memoryStore.profiles.set(normalized.uid, getProfileStoreCopy(next));
  return getProfileStoreCopy(next);
}

async function ensureProfile(identity) {
  let profile = await getProfileByUid(identity.uid);
  if (!profile) {
    profile = buildBaseProfile(identity);
  }

  const incomingDisplayName = sanitize(String(identity.name || "")).slice(0, 60);
  if (incomingDisplayName && profile.displayName !== incomingDisplayName) {
    profile.displayName = incomingDisplayName;
  }
  if (identity.photoURL && !profile.photoURL) {
    profile.photoURL = identity.photoURL;
  }
  if (identity.email && !profile.email) {
    profile.email = identity.email;
  }
  if (identity.phoneNumber && !profile.phoneNumber) {
    profile.phoneNumber = identity.phoneNumber;
  }

  return saveProfile(profile);
}

async function listProfilesByUids(uids) {
  const ids = uniqueStrings(uids);
  if (ids.length === 0) return [];

  if (mongoConnected) {
    return UserProfileModel.find({ uid: { $in: ids } }).lean();
  }

  return ids
    .map((uid) => memoryStore.profiles.get(uid))
    .filter(Boolean)
    .map((profile) => getProfileStoreCopy(profile));
}

async function isUsernameAvailable(username, uidToIgnore = "") {
  const normalized = normalizeUsername(username);
  if (!USERNAME_REGEX.test(normalized)) return false;

  if (mongoConnected) {
    const existing = await UserProfileModel.findOne({ username: normalized }).lean();
    return !existing || existing.uid === uidToIgnore;
  }

  const profile = [...memoryStore.profiles.values()].find((entry) => entry.username === normalized);
  return !profile || profile.uid === uidToIgnore;
}

async function claimUsername(uid, username) {
  const normalized = normalizeUsername(username);
  if (!USERNAME_REGEX.test(normalized)) {
    const error = new Error("Username must be 3-20 chars: letters, numbers, underscore");
    error.status = 400;
    throw error;
  }

  const profile = await getProfileByUid(uid);
  if (!profile) {
    const error = new Error("Profile not found");
    error.status = 404;
    throw error;
  }

  if (profile.username && profile.username !== normalized) {
    const error = new Error("Username is already set for this account");
    error.status = 409;
    throw error;
  }
  if (profile.username === normalized) {
    return profile;
  }

  const available = await isUsernameAvailable(normalized, uid);
  if (!available) {
    const error = new Error("Username already taken");
    error.status = 409;
    throw error;
  }

  profile.username = normalized;
  return saveProfile(profile);
}

async function searchProfiles(query, selfUid, limit = 12) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 12));
  const q = String(query || "").trim();
  if (q.length < 2) return [];

  if (mongoConnected) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return UserProfileModel.find(
      {
        uid: { $ne: selfUid },
        $or: [
          { username: rx },
          { displayName: rx },
          { email: rx },
        ],
      }
    )
      .sort({ updatedAt: -1 })
      .limit(safeLimit)
      .lean();
  }

  return [...memoryStore.profiles.values()]
    .filter((profile) => profile.uid !== selfUid)
    .filter((profile) => {
      const haystack = `${profile.username || ""} ${profile.displayName || ""} ${profile.email || ""}`.toLowerCase();
      return haystack.includes(q.toLowerCase());
    })
    .slice(0, safeLimit)
    .map((profile) => getProfileStoreCopy(profile));
}

async function sendFriendRequest(fromUid, toUid) {
  if (!fromUid || !toUid || fromUid === toUid) {
    const error = new Error("Invalid target user");
    error.status = 400;
    throw error;
  }

  const from = await getProfileByUid(fromUid);
  const to = await getProfileByUid(toUid);
  if (!from || !to) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }
  if (mongoConnected) {
    const existing = await getRelationshipRow(fromUid, toUid);
    if (existing?.status === "blocked") {
      const error = new Error("Friend request is blocked for this user");
      error.status = 403;
      throw error;
    }
    if (existing?.status === "accepted") {
      return { status: "already_friends", from, to };
    }
    if (existing?.status === "pending") {
      const requesterUid = String(existing.requesterUid || existing.requestedBy || "");
      if (requesterUid === fromUid) {
        return { status: "already_requested", from, to };
      }
      return { status: "needs_accept", from, to };
    }
    await setRelationshipState(fromUid, toUid, "pending", fromUid);
    return { status: "requested", from, to };
  }

  if (from.friends.includes(toUid)) {
    await setRelationshipState(fromUid, toUid, "accepted", fromUid);
    return { status: "already_friends", from, to };
  }
  if (from.outgoingRequests.includes(toUid)) {
    await setRelationshipState(fromUid, toUid, "pending", fromUid);
    return { status: "already_requested", from, to };
  }
  if (from.incomingRequests.includes(toUid)) {
    await setRelationshipState(fromUid, toUid, "pending", toUid);
    return { status: "needs_accept", from, to };
  }

  from.outgoingRequests.push(toUid);
  to.incomingRequests.push(fromUid);

  const nextFrom = await saveProfile(from);
  const nextTo = await saveProfile(to);
  await setRelationshipState(fromUid, toUid, "pending", fromUid);
  return { status: "requested", from: nextFrom, to: nextTo };
}

async function respondFriendRequest(targetUid, requesterUid, action) {
  if (!["accept", "reject"].includes(action)) {
    const error = new Error("Invalid action");
    error.status = 400;
    throw error;
  }

  const target = await getProfileByUid(targetUid);
  const requester = await getProfileByUid(requesterUid);
  if (!target || !requester) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }

  if (mongoConnected) {
    const existing = await getRelationshipRow(targetUid, requesterUid);
    const requesterId = String(existing?.requesterUid || existing?.requestedBy || "");
    if (!existing || existing.status !== "pending" || requesterId !== requesterUid) {
      const error = new Error("Friend request not found");
      error.status = 400;
      throw error;
    }
    await setRelationshipState(targetUid, requesterUid, action === "accept" ? "accepted" : "rejected", targetUid);
    return { target, requester };
  }

  if (!target.incomingRequests.includes(requesterUid)) {
    const error = new Error("Friend request not found");
    error.status = 400;
    throw error;
  }

  target.incomingRequests = target.incomingRequests.filter((uid) => uid !== requesterUid);
  requester.outgoingRequests = requester.outgoingRequests.filter((uid) => uid !== targetUid);

  if (action === "accept") {
    if (!target.friends.includes(requesterUid)) target.friends.push(requesterUid);
    if (!requester.friends.includes(targetUid)) requester.friends.push(targetUid);
  }

  const nextTarget = await saveProfile(target);
  const nextRequester = await saveProfile(requester);
  await setRelationshipState(targetUid, requesterUid, action === "accept" ? "accepted" : "rejected", targetUid);
  return { target: nextTarget, requester: nextRequester };
}

async function addMemoryEvent(uidA, uidB, seconds, roomCode = "") {
  if (!uidA || !uidB || uidA === uidB) return;
  const safeSeconds = Math.floor(Number(seconds) || 0);
  if (safeSeconds < WATCH_MEMORY_MIN_SECONDS) return;

  const users = [uidA, uidB].sort();
  const payload = {
    users,
    seconds: safeSeconds,
    occurredAt: new Date(),
    roomCode: String(roomCode || "").slice(0, 32),
  };

  if (mongoConnected) {
    await MemoryEventModel.create(payload);
    return;
  }

  memoryStore.memoryEvents.push(payload);
}

async function listMemoryEventsForUser(uid) {
  if (!uid) return [];

  if (mongoConnected) {
    return MemoryEventModel.find({ users: uid }).sort({ occurredAt: -1 }).limit(5000).lean();
  }

  return memoryStore.memoryEvents
    .filter((event) => event.users.includes(uid))
    .slice(-5000)
    .reverse()
    .map((event) => ({ ...event }));
}

function aggregateMemories(uid, events, friendProfiles) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const yearAgo = now - 365 * 24 * 60 * 60 * 1000;

  const profileByUid = new Map(friendProfiles.map((profile) => [profile.uid, profile]));
  const byFriend = new Map();

  const summary = {
    weekSeconds: 0,
    monthSeconds: 0,
    yearSeconds: 0,
    allSeconds: 0,
  };

  events.forEach((event) => {
    const occurredAt = new Date(event.occurredAt).getTime();
    const seconds = Math.max(0, Number(event.seconds) || 0);
    const friendUid = event.users[0] === uid ? event.users[1] : event.users[0];
    if (!friendUid) return;

    if (!byFriend.has(friendUid)) {
      const profile = profileByUid.get(friendUid);
      byFriend.set(friendUid, {
        uid: friendUid,
        username: profile?.username || "",
        displayName: profile?.displayName || "Friend",
        photoURL: profile?.photoURL || "",
        weekSeconds: 0,
        monthSeconds: 0,
        yearSeconds: 0,
        allSeconds: 0,
      });
    }

    const bucket = byFriend.get(friendUid);
    bucket.allSeconds += seconds;
    summary.allSeconds += seconds;

    if (occurredAt >= yearAgo) {
      bucket.yearSeconds += seconds;
      summary.yearSeconds += seconds;
    }
    if (occurredAt >= monthAgo) {
      bucket.monthSeconds += seconds;
      summary.monthSeconds += seconds;
    }
    if (occurredAt >= weekAgo) {
      bucket.weekSeconds += seconds;
      summary.weekSeconds += seconds;
    }
  });

  return {
    summary,
    byFriend: [...byFriend.values()].sort((a, b) => b.allSeconds - a.allSeconds),
  };
}

function sortedPairUsers(uidA, uidB) {
  if (!uidA || !uidB || uidA === uidB) return null;
  return [uidA, uidB].sort();
}

function pairKeyFromUsers(uidA, uidB) {
  const users = sortedPairUsers(uidA, uidB);
  return users ? users.join("__") : null;
}

function normalizeWatchlistItem(item = {}) {
  return {
    id: String(item.id || ""),
    title: sanitize(String(item.title || "")).slice(0, MAX_WATCHLIST_TITLE_LENGTH),
    url: String(item.url || "").trim().slice(0, MAX_WATCHLIST_URL_LENGTH),
    notes: sanitize(String(item.notes || "")).slice(0, MAX_WATCHLIST_NOTES_LENGTH),
    done: !!item.done,
    addedBy: String(item.addedBy || ""),
    createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
  };
}

function mapCoupleSpace(space, currentUid) {
  const users = Array.isArray(space?.users) ? [...space.users] : [];
  const watchlist = Array.isArray(space?.watchlist) ? space.watchlist.map(normalizeWatchlistItem) : [];
  watchlist.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return {
    pairKey: String(space?.pairKey || ""),
    users,
    partnerUid: users.find((uid) => uid !== currentUid) || "",
    watchlist,
    updatedAt: space?.updatedAt ? new Date(space.updatedAt) : new Date(),
  };
}

async function getCoupleSpaceByUsers(uidA, uidB, createIfMissing = false) {
  const users = sortedPairUsers(uidA, uidB);
  if (!users) return null;
  const pairKey = users.join("__");

  if (mongoConnected) {
    let space = await CoupleSpaceModel.findOne({ pairKey }).lean();
    if (!space && createIfMissing) {
      await CoupleSpaceModel.create({ pairKey, users, watchlist: [], updatedAt: new Date() });
      space = await CoupleSpaceModel.findOne({ pairKey }).lean();
    }
    return space;
  }

  const existing = memoryStore.coupleSpaces.get(pairKey);
  if (existing) return getProfileStoreCopy(existing);
  if (!createIfMissing) return null;

  const fresh = {
    pairKey,
    users,
    watchlist: [],
    updatedAt: new Date(),
    createdAt: new Date(),
  };
  memoryStore.coupleSpaces.set(pairKey, getProfileStoreCopy(fresh));
  return getProfileStoreCopy(fresh);
}

async function saveCoupleSpace(space) {
  const normalized = {
    pairKey: String(space.pairKey || ""),
    users: uniqueStrings(space.users).sort(),
    watchlist: (Array.isArray(space.watchlist) ? space.watchlist : [])
      .slice(0, MAX_WATCHLIST_ITEMS)
      .map((item) => normalizeWatchlistItem(item)),
    updatedAt: new Date(),
  };

  if (!normalized.pairKey) {
    normalized.pairKey = pairKeyFromUsers(normalized.users[0], normalized.users[1]) || "";
  }

  if (mongoConnected) {
    await CoupleSpaceModel.updateOne(
      { pairKey: normalized.pairKey },
      { $set: normalized, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    return CoupleSpaceModel.findOne({ pairKey: normalized.pairKey }).lean();
  }

  const existing = memoryStore.coupleSpaces.get(normalized.pairKey);
  const next = {
    ...(existing || {}),
    ...normalized,
    createdAt: existing?.createdAt || new Date(),
  };
  memoryStore.coupleSpaces.set(normalized.pairKey, getProfileStoreCopy(next));
  return getProfileStoreCopy(next);
}

async function getValidatedCoupleUsers(selfUid, partnerUid) {
  const [me, partner] = await Promise.all([
    getProfileByUid(selfUid),
    getProfileByUid(partnerUid),
  ]);

  if (!me || !partner) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }
  const isFriend = await areUsersFriends(selfUid, partnerUid);
  if (!isFriend) {
    const error = new Error("Couple space is only for friends");
    error.status = 403;
    throw error;
  }
  return { me, partner };
}

function sanitizeSharedMemoryNote(note) {
  if (typeof note !== "string") return "";
  return escapeAngleBrackets(note).trim().slice(0, MAX_SHARED_MEMORY_NOTE_LENGTH);
}


function sanitizeHighlightTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.slice(0, MAX_SHARED_MEMORY_HIGHLIGHT_LENGTH);
  }
  return "";
}

function clampSharedSessionMinutes(value) {
  const num = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(MAX_SHARED_MEMORY_SESSION_MINUTES, num));
}

function clampReactionCount(value) {
  const num = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(MAX_SHARED_MEMORY_REACTION_COUNT, num));
}

function normalizeSharedMemoryRow(row = {}) {
  const pairUsers = sortedPairUsers(row.user1Id, row.user2Id);
  const user1Id = pairUsers?.[0] || String(row.user1Id || "");
  const user2Id = pairUsers?.[1] || String(row.user2Id || "");
  return {
    id: String(row._id || row.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    pairKey: pairKeyFromUsers(user1Id, user2Id) || String(row.pairKey || ""),
    user1Id,
    user2Id,
    roomCode: String(row.roomCode || "").slice(0, 32),
    date: row.date ? new Date(row.date) : new Date(),
    memoryNote: sanitizeSharedMemoryNote(row.memoryNote || ""),
    sessionMode: normalizeSessionMode(row.sessionMode || "watch"),
    genre: sanitizeSharedMemoryGenre(row.genre || ""),
    moodTag: sanitizeSharedMemoryMoodTag(row.moodTag || ""),
    highlightTimestamp: sanitizeHighlightTimestamp(row.highlightTimestamp || ""),
    sessionMinutes: clampSharedSessionMinutes(row.sessionMinutes),
    reactionCount: clampReactionCount(row.reactionCount),
    createdBy: String(row.createdBy || user1Id),
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  };
}

function normalizePlaybackStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "playing" || raw === "paused" || raw === "idle") return raw;
  return "idle";
}

function clampSessionDuration(value) {
  const num = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(172800, num));
}

function normalizeRelationshipType(value, fallback = "friends") {
  const raw = String(value || "").trim().toLowerCase();
  if (ALLOWED_RELATIONSHIP_TYPES.includes(raw)) return raw;
  return ALLOWED_RELATIONSHIP_TYPES.includes(fallback) ? fallback : "friends";
}

function normalizeReactionType(value, fallback = "reaction") {
  const raw = String(value || "").trim().toLowerCase();
  if (ALLOWED_REACTION_TYPES.includes(raw)) return raw;
  return ALLOWED_REACTION_TYPES.includes(fallback) ? fallback : "reaction";
}

function toUtcDayTimestamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 0;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function computeRollingStreak(previousDate, nextDate, currentStreak = 0) {
  const prevDay = toUtcDayTimestamp(previousDate);
  const nextDay = toUtcDayTimestamp(nextDate);
  if (!nextDay) return Math.max(0, Math.floor(Number(currentStreak) || 0));
  if (!prevDay) return 1;
  const diffDays = Math.round((nextDay - prevDay) / 86400000);
  if (diffDays <= 0) return Math.max(1, Math.floor(Number(currentStreak) || 1));
  if (diffDays === 1) return Math.max(1, Math.floor(Number(currentStreak) || 1) + 1);
  return 1;
}

function timeSlotFromDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "unknown";
  const hour = date.getHours();
  if (hour >= 22 || hour < 5) return "late_night";
  if (hour >= 18) return "evening";
  if (hour >= 12) return "afternoon";
  return "morning";
}

function topLabelsFromCounter(counterMap, limit = 5) {
  return [...counterMap.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, Math.max(1, limit))
    .map(([label]) => label);
}

function normalizeSessionHighlightRow(row = {}) {
  return {
    timestamp: clampTime(Number(row.timestamp) || 0),
    type: normalizeReactionType(row.type || row.reactionType || "reaction"),
    userUid: String(row.userUid || ""),
    reactionType: normalizeReactionType(row.reactionType || row.type || "reaction"),
    emoji: String(row.emoji || "").slice(0, 24),
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  };
}

function normalizeWatchSessionRow(row = {}) {
  const participants = uniqueStrings(Array.isArray(row.participants) ? row.participants : []);
  const startedAt = row.startedAt ? new Date(row.startedAt) : new Date();
  const endedAt = row.endedAt ? new Date(row.endedAt) : new Date();
  const highlights = (Array.isArray(row.highlights) ? row.highlights : [])
    .map((entry) => normalizeSessionHighlightRow(entry))
    .slice(0, MAX_SESSION_HIGHLIGHTS);
  return {
    id: String(row._id || row.id || ""),
    roomCode: String(row.roomCode || "").trim().toUpperCase().slice(0, 32),
    roomId: String(row.roomId || ""),
    roomType: normalizeRoomType(row.roomType),
    sessionMode: normalizeSessionMode(row.sessionMode || "watch"),
    participants,
    relationshipId: String(row.relationshipId || ""),
    relationshipType: normalizeRelationshipType(row.relationshipType || "group", "group"),
    contentUrl: sanitizeContentUrl(row.contentUrl || ""),
    contentTitle: sanitize(String(row.contentTitle || "")).slice(0, MAX_VIDEO_NAME_LENGTH),
    contentType: normalizeContentType(row.contentType),
    genre: sanitizeSharedMemoryGenre(row.genre || ""),
    moodTag: sanitizeRoomMoodTag(row.moodTag || ""),
    duration: clampSessionDuration(row.duration),
    startedAt,
    endedAt,
    reactionsCount: Math.max(0, Math.floor(Number(row.reactionsCount) || 0)),
    highlights,
    createdBy: String(row.createdBy || ""),
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(),
  };
}

function normalizeSessionReactionRow(row = {}) {
  return {
    id: String(row._id || row.id || ""),
    sessionId: String(row.sessionId || ""),
    roomCode: String(row.roomCode || "").trim().toUpperCase().slice(0, 32),
    userUid: String(row.userUid || ""),
    messageId: String(row.messageId || "").slice(0, 120),
    timestamp: clampTime(Number(row.timestamp) || 0),
    reactionType: normalizeReactionType(row.reactionType || "reaction"),
    emoji: String(row.emoji || "").slice(0, 24),
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  };
}

function normalizeMilestoneType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.slice(0, 64);
}

function normalizeMilestoneRow(row = {}) {
  const users = uniqueStrings(Array.isArray(row.users) ? row.users : []);
  const pairKey = String(row.pairKey || "");
  const relationshipId = String(row.relationshipId || pairKey);
  return {
    id: String(row._id || row.id || ""),
    relationshipId,
    pairKey,
    users,
    type: normalizeMilestoneType(row.type),
    achievedAt: row.achievedAt ? new Date(row.achievedAt) : new Date(),
    payload: sanitizeActivityPayload(row.payload || {}),
  };
}

function normalizeInsightRow(row = {}) {
  const year = Math.max(2000, Math.min(2200, Math.floor(Number(row.year) || new Date().getFullYear())));
  return {
    id: String(row._id || row.id || ""),
    relationshipId: String(row.relationshipId || row.pairKey || ""),
    pairKey: String(row.pairKey || ""),
    users: uniqueStrings(Array.isArray(row.users) ? row.users : []),
    year,
    summaryText: sanitize(String(row.summaryText || "")).slice(0, MAX_INSIGHT_SUMMARY_LENGTH),
    favoriteGenre: sanitizeSharedMemoryGenre(row.favoriteGenre || ""),
    watchPattern: sanitize(String(row.watchPattern || "")).slice(0, 120),
    moodTrend: sanitize(String(row.moodTrend || "")).slice(0, 120),
    generatedAt: row.generatedAt ? new Date(row.generatedAt) : new Date(),
  };
}

async function getRelationshipRow(uidA, uidB) {
  const users = sortedPairUsers(uidA, uidB);
  if (!users) return null;
  const key = users.join("__");
  if (mongoConnected) {
    return RelationshipModel.findOne({ pairKey: key }).lean();
  }
  const cached = memoryStore.relationships.get(key);
  return cached ? getProfileStoreCopy(cached) : null;
}

async function setRelationshipState(uidA, uidB, status, actorUid) {
  const users = sortedPairUsers(uidA, uidB);
  if (!users) return null;
  const now = new Date();
  const existing = await getRelationshipRow(users[0], users[1]);
  const effectiveStatus = ["pending", "accepted", "rejected", "blocked"].includes(status) ? status : "pending";
  const actor = String(actorUid || "");
  const fallbackRequester = users.includes(actor) ? actor : String(existing?.requesterUid || existing?.requestedBy || "");
  const requesterUid = effectiveStatus === "pending"
    ? fallbackRequester
    : String(existing?.requesterUid || existing?.requestedBy || fallbackRequester);
  const recipientUid = requesterUid
    ? (users.find((uid) => uid !== requesterUid) || "")
    : String(existing?.recipientUid || "");
  const payload = {
    pairKey: users.join("__"),
    users,
    requesterUid,
    recipientUid,
    status: effectiveStatus,
    relationshipType: normalizeRelationshipType(existing?.relationshipType || "friends", "friends"),
    requestedBy: requesterUid,
    lastActionBy: actor,
    lastActionAt: now,
    updatedAt: now,
  };

  if (mongoConnected) {
    await RelationshipModel.updateOne(
      { pairKey: payload.pairKey },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    return RelationshipModel.findOne({ pairKey: payload.pairKey }).lean();
  }

  const cached = memoryStore.relationships.get(payload.pairKey);
  const next = {
    ...(cached || {}),
    ...payload,
    createdAt: cached?.createdAt || now,
  };
  memoryStore.relationships.set(payload.pairKey, getProfileStoreCopy(next));
  return getProfileStoreCopy(next);
}

async function setRelationshipType(uidA, uidB, relationshipType, actorUid = "") {
  const users = sortedPairUsers(uidA, uidB);
  if (!users) return null;
  const pairKey = users.join("__");
  const nextType = normalizeRelationshipType(relationshipType, "friends");
  const now = new Date();

  if (mongoConnected) {
    await RelationshipModel.updateOne(
      { pairKey },
      {
        $set: {
          relationshipType: nextType,
          lastActionBy: String(actorUid || ""),
          lastActionAt: now,
          updatedAt: now,
        },
      }
    );
    return RelationshipModel.findOne({ pairKey }).lean();
  }

  const existing = memoryStore.relationships.get(pairKey);
  if (!existing) return null;
  const next = {
    ...existing,
    relationshipType: nextType,
    lastActionBy: String(actorUid || ""),
    lastActionAt: now,
    updatedAt: now,
  };
  memoryStore.relationships.set(pairKey, getProfileStoreCopy(next));
  return getProfileStoreCopy(next);
}

async function getRelationshipByPairKey(pairKey) {
  const key = String(pairKey || "").trim();
  if (!key) return null;
  if (mongoConnected) {
    return RelationshipModel.findOne({ pairKey: key }).lean();
  }
  const cached = memoryStore.relationships.get(key);
  return cached ? getProfileStoreCopy(cached) : null;
}

function relationshipTypeFromRoomType(roomType) {
  const normalizedRoomType = normalizeRoomType(roomType);
  if (normalizedRoomType === "family") return "family";
  if (normalizedRoomType === "duo") return "couple";
  return "group";
}

function buildPreferenceSnapshotFromSessions(rows = []) {
  const genreCounter = new Map();
  const slotCounter = new Map();

  rows.forEach((row) => {
    const genre = sanitizeSharedMemoryGenre(row.genre || "");
    if (genre) {
      genreCounter.set(genre, (genreCounter.get(genre) || 0) + 1);
    }

    const slot = timeSlotFromDate(row.startedAt || row.endedAt || row.createdAt);
    if (slot && slot !== "unknown") {
      slotCounter.set(slot, (slotCounter.get(slot) || 0) + 1);
    }
  });

  return {
    favoriteGenres: topLabelsFromCounter(genreCounter, 5),
    activeTimeSlots: topLabelsFromCounter(slotCounter, 4),
  };
}

async function listWatchSessionsForUser(uid, { partnerUid = "", limit = 40, year = null } = {}) {
  const selfUid = String(uid || "").trim();
  if (!selfUid) return [];
  const partner = String(partnerUid || "").trim();
  const safeLimit = Math.max(1, Math.min(400, Number(limit) || 40));
  const queryYear = Number.isFinite(Number(year)) ? Math.floor(Number(year)) : null;
  let rangeStart = null;
  let rangeEnd = null;
  if (queryYear && queryYear >= 2000 && queryYear <= 2200) {
    rangeStart = new Date(Date.UTC(queryYear, 0, 1, 0, 0, 0));
    rangeEnd = new Date(Date.UTC(queryYear + 1, 0, 1, 0, 0, 0));
  }

  if (mongoConnected) {
    const query = partner
      ? { participants: { $all: [selfUid, partner] } }
      : { participants: selfUid };
    if (rangeStart && rangeEnd) {
      query.endedAt = { $gte: rangeStart, $lt: rangeEnd };
    }
    const rows = await WatchSessionModel.find(query)
      .sort({ endedAt: -1 })
      .limit(safeLimit)
      .lean();
    return rows.map((row) => normalizeWatchSessionRow(row));
  }

  return memoryStore.watchSessions
    .filter((row) => {
      const participants = Array.isArray(row.participants) ? row.participants : [];
      if (!participants.includes(selfUid)) return false;
      if (partner && !participants.includes(partner)) return false;
      if (rangeStart && rangeEnd) {
        const endedAt = row.endedAt ? new Date(row.endedAt).getTime() : 0;
        if (endedAt < rangeStart.getTime() || endedAt >= rangeEnd.getTime()) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.endedAt || b.createdAt || Date.now()).getTime() - new Date(a.endedAt || a.createdAt || Date.now()).getTime())
    .slice(0, safeLimit)
    .map((row) => normalizeWatchSessionRow(row));
}

async function listWatchSessionsForRelationship(pairKey, { year = null, limit = 500 } = {}) {
  const key = String(pairKey || "").trim();
  if (!key) return [];
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const queryYear = Number.isFinite(Number(year)) ? Math.floor(Number(year)) : null;
  let rangeStart = null;
  let rangeEnd = null;
  if (queryYear && queryYear >= 2000 && queryYear <= 2200) {
    rangeStart = new Date(Date.UTC(queryYear, 0, 1, 0, 0, 0));
    rangeEnd = new Date(Date.UTC(queryYear + 1, 0, 1, 0, 0, 0));
  }

  if (mongoConnected) {
    const query = { relationshipId: key };
    if (rangeStart && rangeEnd) {
      query.endedAt = { $gte: rangeStart, $lt: rangeEnd };
    }
    const rows = await WatchSessionModel.find(query).sort({ endedAt: -1 }).limit(safeLimit).lean();
    return rows.map((row) => normalizeWatchSessionRow(row));
  }

  return memoryStore.watchSessions
    .filter((row) => {
      if (String(row.relationshipId || "") !== key) return false;
      if (rangeStart && rangeEnd) {
        const endedAt = row.endedAt ? new Date(row.endedAt).getTime() : 0;
        if (endedAt < rangeStart.getTime() || endedAt >= rangeEnd.getTime()) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.endedAt || b.createdAt || Date.now()).getTime() - new Date(a.endedAt || a.createdAt || Date.now()).getTime())
    .slice(0, safeLimit)
    .map((row) => normalizeWatchSessionRow(row));
}

async function createWatchSession(payload = {}) {
  const normalized = normalizeWatchSessionRow(payload);
  if (!normalized.roomCode || normalized.participants.length === 0) {
    return null;
  }

  if (mongoConnected) {
    if (normalized.roomId) {
      const existingByRoomId = await WatchSessionModel.findOne({ roomId: normalized.roomId }).lean();
      if (existingByRoomId) return normalizeWatchSessionRow(existingByRoomId);
    }
    const doc = await WatchSessionModel.create({
      roomCode: normalized.roomCode,
      roomId: normalized.roomId,
      roomType: normalized.roomType,
      sessionMode: normalized.sessionMode,
      participants: normalized.participants,
      relationshipId: normalized.relationshipId,
      relationshipType: normalized.relationshipType,
      contentUrl: normalized.contentUrl,
      contentTitle: normalized.contentTitle,
      contentType: normalized.contentType,
      genre: normalized.genre,
      moodTag: normalized.moodTag,
      duration: normalized.duration,
      startedAt: normalized.startedAt,
      endedAt: normalized.endedAt,
      reactionsCount: normalized.reactionsCount,
      highlights: normalized.highlights,
      createdBy: normalized.createdBy,
    });
    return normalizeWatchSessionRow(doc.toObject());
  }

  if (normalized.roomId) {
    const existing = memoryStore.watchSessions.find((row) => String(row.roomId || "") === normalized.roomId);
    if (existing) return normalizeWatchSessionRow(existing);
  }

  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  pushBounded(memoryStore.watchSessions, row, 10000);
  return normalizeWatchSessionRow(row);
}

async function recordSessionReaction(payload = {}) {
  const normalized = normalizeSessionReactionRow(payload);
  if (!normalized.userUid) return null;
  if (!normalized.roomCode && !normalized.sessionId) return null;

  if (mongoConnected) {
    const doc = await SessionReactionModel.create({
      sessionId: normalized.sessionId,
      roomCode: normalized.roomCode,
      userUid: normalized.userUid,
      messageId: normalized.messageId,
      timestamp: normalized.timestamp,
      reactionType: normalized.reactionType,
      emoji: normalized.emoji,
      createdAt: normalized.createdAt,
    });
    return normalizeSessionReactionRow(doc.toObject());
  }

  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  pushBounded(memoryStore.sessionReactions, row, 16000);
  return normalizeSessionReactionRow(row);
}

async function listRoomReactions(roomCode, { startedAt = null, endedAt = null, limit = MAX_SESSION_REACTIONS } = {}) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return [];
  const safeLimit = Math.max(1, Math.min(10000, Number(limit) || MAX_SESSION_REACTIONS));
  const rangeStart = startedAt ? new Date(startedAt) : null;
  const rangeEnd = endedAt ? new Date(endedAt) : null;

  if (mongoConnected) {
    const query = { roomCode: normalizedCode };
    if (rangeStart || rangeEnd) {
      query.createdAt = {};
      if (rangeStart) query.createdAt.$gte = rangeStart;
      if (rangeEnd) query.createdAt.$lte = rangeEnd;
    }
    const rows = await SessionReactionModel.find(query)
      .sort({ createdAt: 1 })
      .limit(safeLimit)
      .lean();
    return rows.map((row) => normalizeSessionReactionRow(row));
  }

  return memoryStore.sessionReactions
    .filter((row) => String(row.roomCode || "") === normalizedCode)
    .filter((row) => {
      const at = row.createdAt ? new Date(row.createdAt).getTime() : 0;
      if (rangeStart && at < rangeStart.getTime()) return false;
      if (rangeEnd && at > rangeEnd.getTime()) return false;
      return true;
    })
    .sort((a, b) => new Date(a.createdAt || Date.now()).getTime() - new Date(b.createdAt || Date.now()).getTime())
    .slice(0, safeLimit)
    .map((row) => normalizeSessionReactionRow(row));
}

async function countRoomReactions(roomCode, { startedAt = null, endedAt = null } = {}) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return 0;
  const rangeStart = startedAt ? new Date(startedAt) : null;
  const rangeEnd = endedAt ? new Date(endedAt) : null;

  if (mongoConnected) {
    const query = { roomCode: normalizedCode };
    if (rangeStart || rangeEnd) {
      query.createdAt = {};
      if (rangeStart) query.createdAt.$gte = rangeStart;
      if (rangeEnd) query.createdAt.$lte = rangeEnd;
    }
    return SessionReactionModel.countDocuments(query);
  }

  return memoryStore.sessionReactions.filter((row) => {
    if (String(row.roomCode || "") !== normalizedCode) return false;
    const at = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    if (rangeStart && at < rangeStart.getTime()) return false;
    if (rangeEnd && at > rangeEnd.getTime()) return false;
    return true;
  }).length;
}

async function attachSessionIdToRoomReactions({ roomCode, sessionId, startedAt, endedAt }) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedCode || !normalizedSessionId) return 0;
  const rangeStart = startedAt ? new Date(startedAt) : null;
  const rangeEnd = endedAt ? new Date(endedAt) : null;

  if (mongoConnected) {
    const query = {
      roomCode: normalizedCode,
      $or: [{ sessionId: "" }, { sessionId: { $exists: false } }],
    };
    if (rangeStart || rangeEnd) {
      query.createdAt = {};
      if (rangeStart) query.createdAt.$gte = rangeStart;
      if (rangeEnd) query.createdAt.$lte = rangeEnd;
    }
    const result = await SessionReactionModel.updateMany(
      query,
      { $set: { sessionId: normalizedSessionId } }
    );
    return result.modifiedCount || 0;
  }

  let updated = 0;
  memoryStore.sessionReactions = memoryStore.sessionReactions.map((row) => {
    if (String(row.roomCode || "") !== normalizedCode) return row;
    if (row.sessionId) return row;
    const at = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    if (rangeStart && at < rangeStart.getTime()) return row;
    if (rangeEnd && at > rangeEnd.getTime()) return row;
    updated += 1;
    return { ...row, sessionId: normalizedSessionId };
  });
  return updated;
}

function milestoneStoreKey(pairKey, type) {
  return `${String(pairKey || "")}__${normalizeMilestoneType(type)}`;
}

async function upsertMilestone(payload = {}) {
  const normalized = normalizeMilestoneRow(payload);
  if (!normalized.pairKey || !normalized.type) return null;

  if (mongoConnected) {
    await MilestoneModel.updateOne(
      { pairKey: normalized.pairKey, type: normalized.type },
      {
        $set: {
          relationshipId: normalized.relationshipId,
          users: normalized.users,
          achievedAt: normalized.achievedAt,
          payload: normalized.payload,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    const row = await MilestoneModel.findOne({ pairKey: normalized.pairKey, type: normalized.type }).lean();
    return normalizeMilestoneRow(row);
  }

  const key = milestoneStoreKey(normalized.pairKey, normalized.type);
  const existing = memoryStore.milestones.get(key);
  const next = {
    ...(existing || {}),
    ...normalized,
    id: existing?.id || normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: existing?.createdAt || new Date(),
  };
  memoryStore.milestones.set(key, getProfileStoreCopy(next));
  return normalizeMilestoneRow(next);
}

async function listMilestonesForUser(uid, partnerUid = "") {
  const selfUid = String(uid || "").trim();
  const partner = String(partnerUid || "").trim();
  if (!selfUid) return [];

  if (partner) {
    const pairKey = pairKeyFromUsers(selfUid, partner);
    if (!pairKey) return [];
    if (mongoConnected) {
      const rows = await MilestoneModel.find({ pairKey }).sort({ achievedAt: -1 }).limit(120).lean();
      return rows.map((row) => normalizeMilestoneRow(row));
    }
    return [...memoryStore.milestones.values()]
      .filter((row) => String(row.pairKey || "") === pairKey)
      .sort((a, b) => new Date(b.achievedAt || b.createdAt || Date.now()).getTime() - new Date(a.achievedAt || a.createdAt || Date.now()).getTime())
      .map((row) => normalizeMilestoneRow(row));
  }

  if (mongoConnected) {
    const rows = await MilestoneModel.find({ users: selfUid }).sort({ achievedAt: -1 }).limit(200).lean();
    return rows.map((row) => normalizeMilestoneRow(row));
  }

  return [...memoryStore.milestones.values()]
    .filter((row) => Array.isArray(row.users) && row.users.includes(selfUid))
    .sort((a, b) => new Date(b.achievedAt || b.createdAt || Date.now()).getTime() - new Date(a.achievedAt || a.createdAt || Date.now()).getTime())
    .map((row) => normalizeMilestoneRow(row));
}

async function upsertInsight(payload = {}) {
  const normalized = normalizeInsightRow(payload);
  if (!normalized.pairKey || !normalized.year) return null;

  if (mongoConnected) {
    await InsightModel.updateOne(
      { pairKey: normalized.pairKey, year: normalized.year },
      {
        $set: {
          relationshipId: normalized.relationshipId,
          users: normalized.users,
          summaryText: normalized.summaryText,
          favoriteGenre: normalized.favoriteGenre,
          watchPattern: normalized.watchPattern,
          moodTrend: normalized.moodTrend,
          generatedAt: normalized.generatedAt,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    const row = await InsightModel.findOne({ pairKey: normalized.pairKey, year: normalized.year }).lean();
    return normalizeInsightRow(row);
  }

  const index = memoryStore.insights.findIndex(
    (item) => String(item.pairKey || "") === normalized.pairKey && Number(item.year) === normalized.year
  );
  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  if (index === -1) {
    pushBounded(memoryStore.insights, row, 5000);
  } else {
    memoryStore.insights[index] = { ...memoryStore.insights[index], ...row };
  }
  return normalizeInsightRow(row);
}

async function getInsightForPairYear(pairKey, year) {
  const key = String(pairKey || "").trim();
  const targetYear = Math.max(2000, Math.min(2200, Math.floor(Number(year) || new Date().getFullYear())));
  if (!key) return null;

  if (mongoConnected) {
    const row = await InsightModel.findOne({ pairKey: key, year: targetYear }).lean();
    return row ? normalizeInsightRow(row) : null;
  }

  const row = memoryStore.insights.find((item) => String(item.pairKey || "") === key && Number(item.year) === targetYear);
  return row ? normalizeInsightRow(row) : null;
}

async function listInsightsForUser(uid, { year = null, limit = 40 } = {}) {
  const selfUid = String(uid || "").trim();
  if (!selfUid) return [];
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
  const normalizedYear = Number.isFinite(Number(year)) ? Math.floor(Number(year)) : null;

  if (mongoConnected) {
    const query = { users: selfUid };
    if (normalizedYear && normalizedYear >= 2000 && normalizedYear <= 2200) {
      query.year = normalizedYear;
    }
    const rows = await InsightModel.find(query)
      .sort({ year: -1, generatedAt: -1 })
      .limit(safeLimit)
      .lean();
    return rows.map((row) => normalizeInsightRow(row));
  }

  return memoryStore.insights
    .filter((item) => Array.isArray(item.users) && item.users.includes(selfUid))
    .filter((item) => !normalizedYear || Number(item.year) === normalizedYear)
    .sort((a, b) => {
      if (Number(b.year || 0) !== Number(a.year || 0)) {
        return Number(b.year || 0) - Number(a.year || 0);
      }
      return new Date(b.generatedAt || b.createdAt || Date.now()).getTime()
        - new Date(a.generatedAt || a.createdAt || Date.now()).getTime();
    })
    .slice(0, safeLimit)
    .map((item) => normalizeInsightRow(item));
}

function summarizeMoodTrend(rows = []) {
  const counter = new Map();
  rows.forEach((session) => {
    (Array.isArray(session.highlights) ? session.highlights : []).forEach((item) => {
      const type = normalizeReactionType(item.reactionType || item.type || "reaction");
      counter.set(type, (counter.get(type) || 0) + 1);
    });
  });
  const top = topLabelsFromCounter(counter, 2);
  if (top.length === 0) return "neutral";
  return top.join(", ");
}

function summarizeWatchPattern(rows = []) {
  const slotCounter = new Map();
  const modeCounter = new Map();
  rows.forEach((session) => {
    const slot = timeSlotFromDate(session.startedAt || session.endedAt || session.createdAt);
    if (slot && slot !== "unknown") {
      slotCounter.set(slot, (slotCounter.get(slot) || 0) + 1);
    }
    const mode = normalizeSessionMode(session.sessionMode || "watch");
    modeCounter.set(mode, (modeCounter.get(mode) || 0) + 1);
  });

  const topSlot = topLabelsFromCounter(slotCounter, 1)[0] || "mixed-hours";
  const topMode = topLabelsFromCounter(modeCounter, 1)[0] || "watch";
  return `${topSlot} / ${topMode}`;
}

function inferGenreFromSession({ contentTitle = "", contentUrl = "", sessionMode = "watch" } = {}) {
  const hay = `${String(contentTitle || "")} ${String(contentUrl || "")}`.toLowerCase();
  const tests = [
    { genre: "Romance", terms: ["romance", "romantic", "love story", "date night"] },
    { genre: "Thriller", terms: ["thriller", "mystery", "crime", "suspense"] },
    { genre: "Comedy", terms: ["comedy", "funny", "standup", "sitcom"] },
    { genre: "Sci-Fi", terms: ["sci-fi", "science fiction", "space", "future"] },
    { genre: "Horror", terms: ["horror", "scary", "ghost", "haunted"] },
    { genre: "Drama", terms: ["drama", "emotional", "family drama"] },
    { genre: "Education", terms: ["lecture", "course", "tutorial", "study", "class"] },
    { genre: "Podcast", terms: ["podcast", "episode", "interview"] },
    { genre: "Reading", terms: ["chapter", ".pdf", "paper", "book"] },
  ];
  const hit = tests.find((item) => item.terms.some((term) => hay.includes(term)));
  if (hit) return hit.genre;
  const mode = normalizeSessionMode(sessionMode);
  if (mode === "podcast") return "Podcast";
  if (mode === "reading") return "Reading";
  if (mode === "study") return "Education";
  return "";
}

async function regenerateRelationshipInsight(relationshipRow, year = new Date().getFullYear()) {
  const pairKey = String(relationshipRow?.pairKey || "");
  if (!pairKey) return null;
  const users = uniqueStrings(Array.isArray(relationshipRow?.users) ? relationshipRow.users : []);
  const targetYear = Math.max(2000, Math.min(2200, Math.floor(Number(year) || new Date().getFullYear())));
  const sessions = await listWatchSessionsForRelationship(pairKey, { year: targetYear, limit: 1200 });
  if (sessions.length === 0) return null;

  const genreCounter = new Map();
  let totalDuration = 0;
  sessions.forEach((session) => {
    const genre = sanitizeSharedMemoryGenre(session.genre || "");
    if (genre) genreCounter.set(genre, (genreCounter.get(genre) || 0) + 1);
    totalDuration += Math.max(0, Number(session.duration) || 0);
  });

  const favoriteGenre = topLabelsFromCounter(genreCounter, 1)[0] || "mixed";
  const watchPattern = summarizeWatchPattern(sessions);
  const moodTrend = summarizeMoodTrend(sessions);
  const sessionHours = Math.round((totalDuration / 3600) * 10) / 10;
  const summaryText = sanitize(
    `In ${targetYear}, this relationship logged ${sessions.length} shared sessions (${sessionHours}h). `
    + `Top genre: ${favoriteGenre}. Pattern: ${watchPattern}. Mood trend: ${moodTrend}.`
  ).slice(0, MAX_INSIGHT_SUMMARY_LENGTH);

  return upsertInsight({
    relationshipId: pairKey,
    pairKey,
    users,
    year: targetYear,
    summaryText,
    favoriteGenre,
    watchPattern,
    moodTrend,
    generatedAt: new Date(),
  });
}

async function refreshUserAnalytics(uid, sessionRow) {
  const targetUid = String(uid || "").trim();
  if (!targetUid) return null;
  const profile = await getProfileByUid(targetUid);
  if (!profile) return null;

  const duration = clampSessionDuration(sessionRow?.duration);
  const endedAt = sessionRow?.endedAt ? new Date(sessionRow.endedAt) : new Date();
  const next = {
    ...profile,
    totalWatchTime: Math.max(0, Math.floor(Number(profile.totalWatchTime) || 0) + duration),
    totalSessions: Math.max(0, Math.floor(Number(profile.totalSessions) || 0) + 1),
    streakCount: computeRollingStreak(profile.lastSessionAt, endedAt, profile.streakCount),
    lastSessionAt: endedAt,
  };

  const sessions = await listWatchSessionsForUser(targetUid, { limit: 240 });
  const prefs = buildPreferenceSnapshotFromSessions(sessions);
  next.preferences = prefs;
  return saveProfile(next);
}

async function refreshRelationshipAnalytics(relationshipRow, sessionRow) {
  if (!relationshipRow || relationshipRow.status !== "accepted") return relationshipRow;
  const pairKey = String(relationshipRow.pairKey || "");
  if (!pairKey) return relationshipRow;

  const now = new Date();
  const endedAt = sessionRow?.endedAt ? new Date(sessionRow.endedAt) : now;
  const startedAt = sessionRow?.startedAt ? new Date(sessionRow.startedAt) : endedAt;
  const duration = clampSessionDuration(sessionRow?.duration);
  const sessions = await listWatchSessionsForRelationship(pairKey, { limit: 500 });
  const prefs = buildPreferenceSnapshotFromSessions(sessions);

  const payload = {
    totalWatchTime: Math.max(0, Math.floor(Number(relationshipRow.totalWatchTime) || 0) + duration),
    totalSessions: Math.max(0, Math.floor(Number(relationshipRow.totalSessions) || 0) + 1),
    longestSession: Math.max(Math.floor(Number(relationshipRow.longestSession) || 0), duration),
    streak: computeRollingStreak(relationshipRow.lastWatchedAt, endedAt, relationshipRow.streak),
    firstWatchedAt: relationshipRow.firstWatchedAt ? new Date(relationshipRow.firstWatchedAt) : startedAt,
    lastWatchedAt: endedAt,
    topGenres: prefs.favoriteGenres,
    activeTimeSlots: prefs.activeTimeSlots,
    lastSessionMode: normalizeSessionMode(sessionRow?.sessionMode || relationshipRow.lastSessionMode || "watch"),
    lastActionAt: now,
    updatedAt: now,
  };

  const next = { ...relationshipRow, ...payload };
  if (mongoConnected) {
    await RelationshipModel.updateOne(
      { pairKey },
      { $set: payload }
    );
  } else {
    memoryStore.relationships.set(pairKey, getProfileStoreCopy(next));
  }

  const milestoneCandidates = [
    {
      type: "first_movie",
      check: next.totalSessions >= 1,
      payload: {
        contentTitle: sessionRow?.contentTitle || "",
        achievedAfterSessions: next.totalSessions,
      },
    },
    {
      type: "10_sessions",
      check: next.totalSessions >= 10,
      payload: { achievedAfterSessions: next.totalSessions },
    },
    {
      type: "100_hours",
      check: next.totalWatchTime >= (100 * 3600),
      payload: { totalWatchTime: next.totalWatchTime },
    },
  ];

  const milestoneTasks = milestoneCandidates
    .filter((item) => item.check)
    .map((item) => upsertMilestone({
      relationshipId: pairKey,
      pairKey,
      users: next.users || [],
      type: item.type,
      achievedAt: endedAt,
      payload: item.payload,
    }));
  if (milestoneTasks.length > 0) {
    await Promise.allSettled(milestoneTasks);
  }

  await regenerateRelationshipInsight(next, endedAt.getUTCFullYear());
  return next;
}

async function resolveRelationshipContextForSession(participants, roomType) {
  const users = uniqueStrings(Array.isArray(participants) ? participants : []).sort();
  if (users.length !== 2) {
    return {
      relationshipRow: null,
      relationshipId: "",
      relationshipType: relationshipTypeFromRoomType(roomType),
    };
  }

  const relationshipRow = await getRelationshipRow(users[0], users[1]);
  if (relationshipRow?.status === "accepted") {
    return {
      relationshipRow,
      relationshipId: String(relationshipRow.pairKey || pairKeyFromUsers(users[0], users[1]) || ""),
      relationshipType: normalizeRelationshipType(relationshipRow.relationshipType || relationshipTypeFromRoomType(roomType)),
    };
  }

  return {
    relationshipRow,
    relationshipId: "",
    relationshipType: relationshipTypeFromRoomType(roomType),
  };
}

function buildSessionHighlightsFromReactions(reactions = []) {
  return reactions
    .slice(0, MAX_SESSION_HIGHLIGHTS)
    .map((item) => normalizeSessionHighlightRow({
      timestamp: item.timestamp,
      type: item.reactionType,
      reactionType: item.reactionType,
      userUid: item.userUid,
      emoji: item.emoji,
      createdAt: item.createdAt,
    }));
}

async function updateAnalyticsFromWatchSession(sessionRow) {
  if (!sessionRow) return;
  const participants = uniqueStrings(sessionRow.participants || []);
  if (participants.length === 0) return;

  await Promise.allSettled(participants.map((uid) => refreshUserAnalytics(uid, sessionRow)));

  if (participants.length === 2) {
    const relationship = await getRelationshipRow(participants[0], participants[1]);
    if (relationship?.status === "accepted") {
      await refreshRelationshipAnalytics(relationship, sessionRow);
    }
  }
}

async function logActivity({ uid, type, roomCode = "", targetUid = "", payload = {} }) {
  if (!uid || !type) return;
  const now = new Date();
  const normalized = {
    uid: String(uid),
    type: String(type).slice(0, 80),
    roomCode: String(roomCode || "").trim().toUpperCase().slice(0, 32),
    targetUid: String(targetUid || "").slice(0, 128),
    payload: sanitizeActivityPayload(payload),
    occurredAt: now,
  };

  if (mongoConnected) {
    await ActivityEventModel.create(normalized).catch(() => {});
    return;
  }

  pushBounded(memoryStore.activityEvents, normalized, 4000);
}

async function createInviteRecord({ fromUid, toUid, roomCode, status = "sent" }) {
  const normalized = {
    fromUid: String(fromUid || ""),
    toUid: String(toUid || ""),
    roomCode: String(roomCode || "").trim().toUpperCase().slice(0, 32),
    status: ["sent", "seen", "accepted", "expired"].includes(status) ? status : "sent",
    createdAt: new Date(),
    respondedAt: null,
  };
  if (!normalized.fromUid || !normalized.toUid || !normalized.roomCode) return null;

  if (mongoConnected) {
    return InviteModel.create(normalized);
  }

  const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...normalized };
  pushBounded(memoryStore.invites, row, 3000);
  return row;
}

function normalizeNotificationType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (!value) return "system";
  return value.slice(0, 64);
}

function normalizeNotificationRow(row = {}) {
  return {
    id: String(row._id || row.id || ""),
    recipientUid: String(row.recipientUid || ""),
    senderUid: String(row.senderUid || ""),
    type: normalizeNotificationType(row.type),
    referenceId: String(row.referenceId || ""),
    roomCode: String(row.roomCode || "").trim().toUpperCase().slice(0, 32),
    payload: sanitizeActivityPayload(row.payload || {}),
    actionRequired: !!row.actionRequired,
    isRead: !!row.isRead,
    readAt: row.readAt ? new Date(row.readAt) : null,
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  };
}

async function createNotification({
  recipientUid,
  senderUid = "",
  type,
  referenceId = "",
  roomCode = "",
  payload = {},
  actionRequired = false,
}) {
  const normalized = normalizeNotificationRow({
    recipientUid,
    senderUid,
    type,
    referenceId,
    roomCode,
    payload,
    actionRequired,
    isRead: false,
    readAt: null,
    createdAt: new Date(),
  });

  if (!normalized.recipientUid || !normalized.type) return null;

  if (mongoConnected) {
    const doc = await NotificationModel.create({
      recipientUid: normalized.recipientUid,
      senderUid: normalized.senderUid,
      type: normalized.type,
      referenceId: normalized.referenceId,
      roomCode: normalized.roomCode,
      payload: normalized.payload,
      actionRequired: normalized.actionRequired,
      isRead: false,
      readAt: null,
      createdAt: normalized.createdAt,
    });
    return normalizeNotificationRow(doc.toObject());
  }

  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  pushBounded(memoryStore.notifications, row, 5000);
  return row;
}

async function listNotificationsForUser(uid, { limit = 40, unreadOnly = false } = {}) {
  const recipientUid = String(uid || "").trim();
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 40));
  if (!recipientUid) return [];

  if (mongoConnected) {
    const query = { recipientUid };
    if (unreadOnly) query.isRead = false;
    const rows = await NotificationModel.find(query)
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean();
    return rows.map((row) => normalizeNotificationRow(row));
  }

  return memoryStore.notifications
    .filter((item) => item.recipientUid === recipientUid)
    .filter((item) => !unreadOnly || !item.isRead)
    .slice(-safeLimit)
    .reverse()
    .map((item) => normalizeNotificationRow(item));
}

async function markNotificationRead(notificationId, uid) {
  const id = String(notificationId || "").trim();
  const recipientUid = String(uid || "").trim();
  if (!id || !recipientUid) return false;
  const readAt = new Date();

  if (mongoConnected) {
    const result = await NotificationModel.updateOne(
      { _id: id, recipientUid },
      { $set: { isRead: true, readAt } }
    );
    return result.modifiedCount > 0;
  }

  const index = memoryStore.notifications.findIndex((item) => item.id === id && item.recipientUid === recipientUid);
  if (index === -1) return false;
  memoryStore.notifications[index] = {
    ...memoryStore.notifications[index],
    isRead: true,
    readAt,
  };
  return true;
}

async function markAllNotificationsRead(uid) {
  const recipientUid = String(uid || "").trim();
  if (!recipientUid) return 0;
  const readAt = new Date();

  if (mongoConnected) {
    const result = await NotificationModel.updateMany(
      { recipientUid, isRead: false },
      { $set: { isRead: true, readAt } }
    );
    return result.modifiedCount || 0;
  }

  let count = 0;
  memoryStore.notifications = memoryStore.notifications.map((item) => {
    if (item.recipientUid !== recipientUid || item.isRead) return item;
    count += 1;
    return { ...item, isRead: true, readAt };
  });
  return count;
}

async function countUnreadNotifications(uid) {
  const recipientUid = String(uid || "").trim();
  if (!recipientUid) return 0;
  if (mongoConnected) {
    return NotificationModel.countDocuments({ recipientUid, isRead: false });
  }
  return memoryStore.notifications.filter((item) => item.recipientUid === recipientUid && !item.isRead).length;
}

async function markNotificationsReadByReference({ recipientUid, type = "", referenceId = "" }) {
  const uid = String(recipientUid || "").trim();
  const ref = String(referenceId || "").trim();
  const normalizedType = String(type || "").trim().toLowerCase();
  if (!uid || !ref) return 0;
  const readAt = new Date();

  if (mongoConnected) {
    const query = {
      recipientUid: uid,
      referenceId: ref,
      isRead: false,
    };
    if (normalizedType) query.type = normalizedType;
    const result = await NotificationModel.updateMany(query, { $set: { isRead: true, readAt } });
    return result.modifiedCount || 0;
  }

  let count = 0;
  memoryStore.notifications = memoryStore.notifications.map((item) => {
    if (item.recipientUid !== uid || item.referenceId !== ref || item.isRead) return item;
    if (normalizedType && String(item.type || "").toLowerCase() !== normalizedType) return item;
    count += 1;
    return { ...item, isRead: true, readAt };
  });
  return count;
}

function roomParticipantKey(roomCode, userId) {
  return `${String(roomCode || "").toUpperCase()}__${String(userId || "")}`;
}

async function upsertRoomMetadata({
  roomCode,
  roomType,
  sessionMode,
  createdBy,
  maxParticipants = MAX_ROOM_USERS,
  isActive = true,
  expiresAt = Date.now() + ROOM_EXPIRY_MS,
  moodTag = "",
  contentUrl = "",
  contentType = "unknown",
  playbackStatus = "idle",
  baseTime = 0,
  startedAt = null,
}) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return null;
  const now = new Date();
  const payload = {
    roomCode: normalizedCode,
    roomType: normalizeRoomType(roomType),
    sessionMode: normalizeSessionMode(sessionMode),
    createdBy: String(createdBy || ""),
    isActive: !!isActive,
    maxParticipants: Math.max(2, Math.min(10, Number(maxParticipants) || MAX_ROOM_USERS)),
    moodTag: sanitizeRoomMoodTag(moodTag),
    permissions: { play: true, pause: true, seek: true, skip: true },
    contentUrl: sanitizeContentUrl(contentUrl),
    contentType: normalizeContentType(contentType),
    playbackStatus: normalizePlaybackStatus(playbackStatus),
    baseTime: clampTime(baseTime),
    startedAt: startedAt ? new Date(startedAt) : null,
    expiresAt: new Date(expiresAt || Date.now() + ROOM_EXPIRY_MS),
    lastActivityAt: now,
    closedAt: null,
  };

  if (mongoConnected) {
    await RoomModel.updateOne(
      { roomCode: payload.roomCode },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    return RoomModel.findOne({ roomCode: payload.roomCode }).lean();
  }

  const existing = memoryStore.rooms.get(payload.roomCode);
  const next = {
    ...(existing || {}),
    ...payload,
    createdAt: existing?.createdAt || now,
  };
  memoryStore.rooms.set(payload.roomCode, getProfileStoreCopy(next));
  return getProfileStoreCopy(next);
}

async function markRoomInactive(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return;
  const now = new Date();

  if (mongoConnected) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: { isActive: false, closedAt: now, lastActivityAt: now } }
    ).catch(() => {});
    return;
  }

  const room = memoryStore.rooms.get(normalizedCode);
  if (!room) return;
  room.isActive = false;
  room.closedAt = now;
  room.lastActivityAt = now;
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room));
}

async function updateRoomContentState(roomCode, { contentUrl = "", contentType = "unknown" } = {}) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return;
  const updates = {
    contentUrl: sanitizeContentUrl(contentUrl),
    contentType: normalizeContentType(contentType),
    lastActivityAt: new Date(),
  };

  if (mongoConnected) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {});
    return;
  }

  const room = memoryStore.rooms.get(normalizedCode);
  if (!room) return;
  room.contentUrl = updates.contentUrl;
  room.contentType = updates.contentType;
  room.lastActivityAt = updates.lastActivityAt;
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room));
}

async function updateRoomCreator(roomCode, createdBy) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  const normalizedUid = String(createdBy || "").trim();
  if (!normalizedCode || !normalizedUid) return;
  const updates = {
    createdBy: normalizedUid,
    lastActivityAt: new Date(),
  };

  if (mongoConnected) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {});
    return;
  }

  const room = memoryStore.rooms.get(normalizedCode);
  if (!room) return;
  room.createdBy = normalizedUid;
  room.lastActivityAt = updates.lastActivityAt;
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room));
}

async function updateRoomPlaybackState(roomCode, { playbackStatus = "idle", baseTime = 0, startedAt = null } = {}) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return;
  const updates = {
    playbackStatus: normalizePlaybackStatus(playbackStatus),
    baseTime: clampTime(baseTime),
    lastActivityAt: new Date(),
  };
  if (startedAt) {
    updates.startedAt = new Date(startedAt);
  }

  if (mongoConnected) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {});
    return;
  }

  const room = memoryStore.rooms.get(normalizedCode);
  if (!room) return;
  room.playbackStatus = updates.playbackStatus;
  room.baseTime = updates.baseTime;
  if (updates.startedAt) room.startedAt = updates.startedAt;
  room.lastActivityAt = updates.lastActivityAt;
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room));
}

async function touchRoomActivity(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return;
  const now = new Date();

  if (mongoConnected) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: { lastActivityAt: now } }
    ).catch(() => {});
    return;
  }

  const room = memoryStore.rooms.get(normalizedCode);
  if (!room) return;
  room.lastActivityAt = now;
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room));
}

async function upsertRoomParticipant(roomCode, userId, updates = {}) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  const normalizedUid = String(userId || "").trim();
  if (!normalizedCode || !normalizedUid) return null;
  const now = new Date();
  const payload = {
    roomCode: normalizedCode,
    userId: normalizedUid,
    joinedAt: updates.joinedAt ? new Date(updates.joinedAt) : now,
    leftAt: updates.leftAt ? new Date(updates.leftAt) : null,
    role: String(updates.role || "member").slice(0, 32),
    isActive: updates.isActive !== false,
  };

  if (mongoConnected) {
    await RoomParticipantModel.updateOne(
      { roomCode: normalizedCode, userId: normalizedUid },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    return RoomParticipantModel.findOne({ roomCode: normalizedCode, userId: normalizedUid }).lean();
  }

  const key = roomParticipantKey(normalizedCode, normalizedUid);
  const existing = memoryStore.roomParticipants.get(key);
  const next = {
    ...(existing || {}),
    ...payload,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  memoryStore.roomParticipants.set(key, getProfileStoreCopy(next));
  return getProfileStoreCopy(next);
}

async function markRoomParticipantLeft(roomCode, userId) {
  return upsertRoomParticipant(roomCode, userId, {
    leftAt: new Date(),
    isActive: false,
  });
}

async function saveVideoSessionMetadata({
  roomCode,
  videoName,
  duration,
  sourceType,
  fileFingerprint,
  updatedBy,
  contentUrl = "",
}) {
  const normalized = {
    roomCode: String(roomCode || "").trim().toUpperCase(),
    videoName: sanitize(String(videoName || "")).slice(0, MAX_VIDEO_NAME_LENGTH),
    duration: Math.max(0, Math.min(MAX_VIDEO_TIME, Number(duration) || 0)),
    sourceType: normalizeContentType(sourceType),
    fileFingerprint: String(fileFingerprint || "").slice(0, 220),
    contentUrl: sanitizeContentUrl(contentUrl),
    updatedBy: String(updatedBy || ""),
    startedAt: new Date(),
    endedAt: null,
    totalWatchTime: 0,
  };
  if (!normalized.roomCode) return null;

  if (mongoConnected) {
    await VideoSessionModel.updateOne(
      { roomCode: normalized.roomCode },
      {
        $set: {
          videoName: normalized.videoName,
          duration: normalized.duration,
          sourceType: normalized.sourceType,
          fileFingerprint: normalized.fileFingerprint,
          contentUrl: normalized.contentUrl,
          updatedBy: normalized.updatedBy,
          endedAt: null,
        },
        $setOnInsert: {
          startedAt: new Date(),
        },
      },
      { upsert: true }
    );
    return VideoSessionModel.findOne({ roomCode: normalized.roomCode }).lean();
  }

  const existing = memoryStore.videoSessions.get(normalized.roomCode);
  const next = {
    ...(existing || {}),
    ...normalized,
    startedAt: existing?.startedAt || new Date(),
    updatedAt: new Date(),
  };
  memoryStore.videoSessions.set(normalized.roomCode, getProfileStoreCopy(next));
  return getProfileStoreCopy(next);
}

async function listDistinctParticipantsForRoom(roomCode, roomSnapshot = null) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return [];

  const uids = new Set();
  if (roomSnapshot?.users instanceof Map) {
    roomSnapshot.users.forEach((_value, uid) => {
      if (uid) uids.add(String(uid));
    });
  }
  if (roomSnapshot?.joinedAtByUid instanceof Map) {
    roomSnapshot.joinedAtByUid.forEach((_value, uid) => {
      if (uid) uids.add(String(uid));
    });
  }

  const historicalRows = await listRoomParticipantsByCode(normalizedCode);
  historicalRows.forEach((row) => {
    if (row?.userId) uids.add(String(row.userId));
  });

  return uniqueStrings([...uids]);
}

async function finalizeVideoSession(roomCode, roomSnapshot = null) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return;
  const endedAt = new Date();
  let videoSession = null;

  if (mongoConnected) {
    const existing = await VideoSessionModel.findOne({ roomCode: normalizedCode }).lean();
    if (existing && !existing.endedAt) {
      const startedAtMs = existing.startedAt ? new Date(existing.startedAt).getTime() : Date.now();
      const totalWatchTime = Math.max(0, Math.floor((endedAt.getTime() - startedAtMs) / 1000));
      await VideoSessionModel.updateOne(
        { roomCode: normalizedCode },
        { $set: { endedAt, totalWatchTime } }
      ).catch(() => {});
      videoSession = await VideoSessionModel.findOne({ roomCode: normalizedCode }).lean();
    } else {
      videoSession = existing;
    }
  } else {
    const existing = memoryStore.videoSessions.get(normalizedCode);
    if (existing && !existing.endedAt) {
      const startedAtMs = existing.startedAt ? new Date(existing.startedAt).getTime() : Date.now();
      existing.endedAt = endedAt;
      existing.totalWatchTime = Math.max(0, Math.floor((endedAt.getTime() - startedAtMs) / 1000));
      existing.updatedAt = endedAt;
      memoryStore.videoSessions.set(normalizedCode, getProfileStoreCopy(existing));
      videoSession = getProfileStoreCopy(existing);
    } else if (existing) {
      videoSession = getProfileStoreCopy(existing);
    }
  }

  const roomMeta = await getRoomMetadataByCode(normalizedCode);
  const roomId = roomMeta?._id ? String(roomMeta._id) : "";
  const dedupeWindowStart = new Date(Date.now() - 36 * 60 * 60 * 1000);

  if (mongoConnected) {
    if (roomId) {
      const existingByRoomId = await WatchSessionModel.findOne({ roomId }).lean();
      if (existingByRoomId) return normalizeWatchSessionRow(existingByRoomId);
    } else {
      const existingByCode = await WatchSessionModel.findOne({
        roomCode: normalizedCode,
        endedAt: { $gte: dedupeWindowStart },
      }).sort({ endedAt: -1 }).lean();
      if (existingByCode) return normalizeWatchSessionRow(existingByCode);
    }
  } else if (roomId) {
    const existingByRoomId = memoryStore.watchSessions.find((row) => String(row.roomId || "") === roomId);
    if (existingByRoomId) return normalizeWatchSessionRow(existingByRoomId);
  } else {
    const existingByCode = memoryStore.watchSessions.find((row) => {
      if (String(row.roomCode || "") !== normalizedCode) return false;
      const ended = row.endedAt ? new Date(row.endedAt).getTime() : 0;
      return ended >= dedupeWindowStart.getTime();
    });
    if (existingByCode) return normalizeWatchSessionRow(existingByCode);
  }

  const participants = await listDistinctParticipantsForRoom(normalizedCode, roomSnapshot);
  if (participants.length === 0) return null;

  const roomStartedAt = Number.isFinite(Number(roomSnapshot?.createdAt))
    ? new Date(Number(roomSnapshot.createdAt))
    : (roomMeta?.startedAt || roomMeta?.createdAt ? new Date(roomMeta.startedAt || roomMeta.createdAt) : null);
  const videoStartedAt = videoSession?.startedAt ? new Date(videoSession.startedAt) : null;
  const startedAt = videoStartedAt && !Number.isNaN(videoStartedAt.getTime())
    ? videoStartedAt
    : (roomStartedAt && !Number.isNaN(roomStartedAt.getTime()) ? roomStartedAt : new Date(endedAt.getTime() - 1000));

  const measuredWatchTime = clampSessionDuration(videoSession?.totalWatchTime);
  const fallbackDuration = clampSessionDuration(Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
  const duration = measuredWatchTime > 0 ? measuredWatchTime : fallbackDuration;

  const [reactionRows, reactionsCount] = await Promise.all([
    listRoomReactions(normalizedCode, { startedAt, endedAt, limit: MAX_SESSION_HIGHLIGHTS }),
    countRoomReactions(normalizedCode, { startedAt, endedAt }),
  ]);
  if (duration < 20 && reactionsCount === 0) return null;
  const highlights = buildSessionHighlightsFromReactions(reactionRows);

  const relationshipContext = await resolveRelationshipContextForSession(participants, roomSnapshot?.roomType || roomMeta?.roomType);
  const contentType = normalizeContentType(
    roomMeta?.contentType
    || roomSnapshot?.videoMetadata?.sourceType
    || videoSession?.sourceType
    || "unknown"
  );
  const contentUrl = sanitizeContentUrl(
    roomMeta?.contentUrl
    || videoSession?.contentUrl
    || roomSnapshot?.videoMetadata?.contentUrl
    || ""
  );
  const contentTitle = sanitize(
    roomSnapshot?.videoMetadata?.videoName
    || videoSession?.videoName
    || ""
  ).slice(0, MAX_VIDEO_NAME_LENGTH);
  const moodTag = sanitizeRoomMoodTag(roomSnapshot?.moodTag || roomMeta?.moodTag || "");
  const inferredGenre = inferGenreFromSession({
    contentTitle,
    contentUrl,
    sessionMode: roomSnapshot?.sessionMode || roomMeta?.sessionMode || "watch",
  });
  const createdBy = String(roomSnapshot?.createdBy || roomMeta?.createdBy || participants[0] || "");

  const sessionRow = await createWatchSession({
    roomCode: normalizedCode,
    roomId,
    roomType: roomSnapshot?.roomType || roomMeta?.roomType || "friends",
    sessionMode: roomSnapshot?.sessionMode || roomMeta?.sessionMode || "watch",
    participants,
    relationshipId: relationshipContext.relationshipId,
    relationshipType: relationshipContext.relationshipType,
    contentUrl,
    contentTitle,
    contentType,
    genre: inferredGenre,
    moodTag,
    duration,
    startedAt,
    endedAt,
    reactionsCount: Math.max(0, reactionsCount),
    highlights,
    createdBy,
  });

  if (!sessionRow?.id) return null;

  await attachSessionIdToRoomReactions({
    roomCode: normalizedCode,
    sessionId: sessionRow.id,
    startedAt,
    endedAt,
  });
  await updateAnalyticsFromWatchSession(sessionRow);

  if (participants.length === 2 && relationshipContext.relationshipId && sessionRow.duration >= WATCH_MEMORY_MIN_SECONDS) {
    const noteParts = [];
    const sessionModeLabel = normalizeSessionMode(sessionRow.sessionMode || "watch");
    if (sessionModeLabel === "reading") noteParts.push("Auto memory: co-reading session");
    else if (sessionModeLabel === "podcast") noteParts.push("Auto memory: podcast sync session");
    else if (sessionModeLabel === "study") noteParts.push("Auto memory: study session");
    else noteParts.push("Auto memory: watch session");
    if (sessionRow.contentTitle) noteParts.push(`- ${sessionRow.contentTitle}`);
    noteParts.push(`(${Math.max(1, Math.round(sessionRow.duration / 60))}m)`);

    await createSharedMemory({
      userA: participants[0],
      userB: participants[1],
      roomCode: normalizedCode,
      memoryNote: noteParts.join(" "),
      createdBy,
      date: endedAt,
      sessionMode: sessionRow.sessionMode || "watch",
      genre: sessionRow.genre || "",
      moodTag: moodTag || "",
      highlightTimestamp: "",
      sessionMinutes: Math.round(sessionRow.duration / 60),
      reactionCount: sessionRow.reactionsCount || 0,
    }).catch(() => {});
  }

  return sessionRow;
}

async function archiveChatMessage(roomCode, msg) {
  if (!roomCode || !msg?.id || !msg?.uid) return;
  const payload = {
    roomCode: String(roomCode || "").trim().toUpperCase(),
    messageId: String(msg.id),
    uid: String(msg.uid),
    senderName: String(msg.senderName || ""),
    senderUsername: String(msg.senderUsername || ""),
    text: sanitize(String(msg.text || "")),
    type: String(msg.type || "text"),
    timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
  };

  if (mongoConnected) {
    await ChatArchiveModel.updateOne(
      { messageId: payload.messageId },
      { $set: payload },
      { upsert: true }
    ).catch(() => {});
    return;
  }

  pushBounded(memoryStore.chatMessages, { ...payload }, 5000);
}

async function createSharedMemory({
  userA,
  userB,
  roomCode,
  memoryNote,
  createdBy,
  date,
  sessionMode = "watch",
  genre = "",
  moodTag = "",
  highlightTimestamp = "",
  sessionMinutes = 0,
  reactionCount = 0,
}) {
  const users = sortedPairUsers(userA, userB);
  if (!users) {
    const error = new Error("Two valid users are required");
    error.status = 400;
    throw error;
  }

  const note = sanitizeSharedMemoryNote(memoryNote);
  if (!note) {
    const error = new Error("memoryNote is required");
    error.status = 400;
    throw error;
  }

  const payload = normalizeSharedMemoryRow({
    user1Id: users[0],
    user2Id: users[1],
    roomCode: String(roomCode || "").trim().toUpperCase().slice(0, 32),
    memoryNote: note,
    sessionMode: normalizeSessionMode(sessionMode),
    genre: sanitizeSharedMemoryGenre(genre),
    moodTag: sanitizeSharedMemoryMoodTag(moodTag),
    highlightTimestamp: sanitizeHighlightTimestamp(highlightTimestamp),
    sessionMinutes: clampSharedSessionMinutes(sessionMinutes),
    reactionCount: clampReactionCount(reactionCount),
    createdBy: String(createdBy || users[0]),
    date: date ? new Date(date) : new Date(),
  });

  if (mongoConnected) {
    const doc = await SharedMemoryModel.create({
      pairKey: payload.pairKey,
      user1Id: payload.user1Id,
      user2Id: payload.user2Id,
      roomCode: payload.roomCode,
      date: payload.date,
      memoryNote: payload.memoryNote,
      sessionMode: payload.sessionMode,
      genre: payload.genre,
      moodTag: payload.moodTag,
      highlightTimestamp: payload.highlightTimestamp,
      sessionMinutes: payload.sessionMinutes,
      reactionCount: payload.reactionCount,
      createdBy: payload.createdBy,
    });
    return normalizeSharedMemoryRow(doc.toObject());
  }

  pushBounded(memoryStore.sharedMemories, payload, 4000);
  return payload;
}

async function listSharedMemoriesForUser(uid, partnerUid = "") {
  const selfUid = String(uid || "").trim();
  if (!selfUid) return [];
  const partner = String(partnerUid || "").trim();
  const pairKey = partner ? pairKeyFromUsers(selfUid, partner) : null;

  if (mongoConnected) {
    const query = pairKey
      ? { pairKey }
      : { $or: [{ user1Id: selfUid }, { user2Id: selfUid }] };
    const rows = await SharedMemoryModel.find(query).sort({ date: -1, createdAt: -1 }).limit(200).lean();
    return rows.map((row) => normalizeSharedMemoryRow(row));
  }

  return memoryStore.sharedMemories
    .filter((row) => {
      if (pairKey) return row.pairKey === pairKey;
      return row.user1Id === selfUid || row.user2Id === selfUid;
    })
    .slice(-200)
    .reverse()
    .map((row) => normalizeSharedMemoryRow(row));
}

async function getProjectOverview(uid) {
  const selfUid = String(uid || "").trim();
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  if (mongoConnected) {
    const [
      users,
      rooms,
      activeRooms,
      relationships,
      invitesSent,
      activities,
      sharedMemories,
      notifications,
      watchSessions,
      milestones,
      insights,
      recentActivity,
      recentRooms,
    ] = await Promise.all([
      UserProfileModel.countDocuments({}),
      RoomModel.countDocuments({}),
      RoomModel.countDocuments({ isActive: true }),
      RelationshipModel.countDocuments({ status: "accepted" }),
      selfUid ? InviteModel.countDocuments({ fromUid: selfUid }) : Promise.resolve(0),
      selfUid ? ActivityEventModel.countDocuments({ uid: selfUid }) : Promise.resolve(0),
      selfUid ? SharedMemoryModel.countDocuments({ $or: [{ user1Id: selfUid }, { user2Id: selfUid }] }) : Promise.resolve(0),
      selfUid ? NotificationModel.countDocuments({ recipientUid: selfUid, isRead: false }) : Promise.resolve(0),
      selfUid ? WatchSessionModel.countDocuments({ participants: selfUid }) : WatchSessionModel.countDocuments({}),
      selfUid ? MilestoneModel.countDocuments({ users: selfUid }) : MilestoneModel.countDocuments({}),
      selfUid ? InsightModel.countDocuments({ users: selfUid }) : InsightModel.countDocuments({}),
      selfUid ? ActivityEventModel.find({ uid: selfUid }).sort({ occurredAt: -1 }).limit(12).lean() : Promise.resolve([]),
      RoomModel.find({}).sort({ createdAt: -1 }).limit(12).lean(),
    ]);

    const weekActivities = selfUid
      ? await ActivityEventModel.countDocuments({ uid: selfUid, occurredAt: { $gte: new Date(weekAgo) } })
      : 0;

    return {
      counts: {
        users,
        rooms,
        activeRooms,
        relationships,
        invitesSent,
        activities,
        activitiesThisWeek: weekActivities,
        sharedMemories,
        notifications,
        watchSessions,
        milestones,
        insights,
      },
      recentActivity: recentActivity.map((item) => ({
        type: item.type,
        occurredAt: item.occurredAt,
        roomCode: item.roomCode || "",
        targetUid: item.targetUid || "",
      })),
      recentRooms: recentRooms.map((item) => ({
        roomCode: item.roomCode,
        roomType: item.roomType,
        sessionMode: item.sessionMode || "watch",
        isActive: !!item.isActive,
        createdAt: item.createdAt,
      })),
      permissionsTemplate: { play: true, pause: true, seek: true, skip: true },
      syncStatePolicy: "ephemeral_in_memory",
    };
  }

  const recentActivity = memoryStore.activityEvents
    .filter((item) => !selfUid || item.uid === selfUid)
    .slice(-12)
    .reverse()
    .map((item) => ({
      type: item.type,
      occurredAt: item.occurredAt,
      roomCode: item.roomCode || "",
      targetUid: item.targetUid || "",
    }));

  const weekActivities = memoryStore.activityEvents.filter((item) => (!selfUid || item.uid === selfUid) && new Date(item.occurredAt).getTime() >= weekAgo).length;
  const invitesSent = memoryStore.invites.filter((item) => !selfUid || item.fromUid === selfUid).length;
  const sharedMemories = memoryStore.sharedMemories.filter((item) => !selfUid || item.user1Id === selfUid || item.user2Id === selfUid).length;
  const notifications = memoryStore.notifications.filter((item) => !selfUid || (item.recipientUid === selfUid && !item.isRead)).length;
  const watchSessions = selfUid
    ? memoryStore.watchSessions.filter((item) => Array.isArray(item.participants) && item.participants.includes(selfUid)).length
    : memoryStore.watchSessions.length;
  const milestones = selfUid
    ? [...memoryStore.milestones.values()].filter((item) => Array.isArray(item.users) && item.users.includes(selfUid)).length
    : memoryStore.milestones.size;
  const insights = selfUid
    ? memoryStore.insights.filter((item) => Array.isArray(item.users) && item.users.includes(selfUid)).length
    : memoryStore.insights.length;
  const recentRooms = [...memoryStore.rooms.values()]
    .slice(-12)
    .reverse()
    .map((item) => ({
      roomCode: item.roomCode,
      roomType: item.roomType,
      sessionMode: item.sessionMode || "watch",
      isActive: !!item.isActive,
      createdAt: item.createdAt,
    }));

  return {
    counts: {
      users: memoryStore.profiles.size,
      rooms: memoryStore.rooms.size,
      activeRooms: [...memoryStore.rooms.values()].filter((room) => room.isActive).length,
      relationships: [...memoryStore.relationships.values()].filter((row) => row.status === "accepted").length,
      invitesSent,
      activities: selfUid ? memoryStore.activityEvents.filter((item) => item.uid === selfUid).length : memoryStore.activityEvents.length,
      activitiesThisWeek: weekActivities,
      sharedMemories,
      notifications,
      watchSessions,
      milestones,
      insights,
    },
    recentActivity,
    recentRooms,
    permissionsTemplate: { play: true, pause: true, seek: true, skip: true },
    syncStatePolicy: "ephemeral_in_memory",
  };
}

async function listActivityForUser(uid, limit = 40) {
  const selfUid = String(uid || "").trim();
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 40));
  if (!selfUid) return [];

  if (mongoConnected) {
    return ActivityEventModel.find({ uid: selfUid }).sort({ occurredAt: -1 }).limit(safeLimit).lean();
  }

  return memoryStore.activityEvents
    .filter((item) => item.uid === selfUid)
    .slice(-safeLimit)
    .reverse()
    .map((item) => getProfileStoreCopy(item));
}

async function getRoomMetadataByCode(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return null;

  if (mongoConnected) {
    return RoomModel.findOne({ roomCode: normalizedCode }).lean();
  }

  const room = memoryStore.rooms.get(normalizedCode);
  return room ? getProfileStoreCopy(room) : null;
}

async function listRoomParticipantsByCode(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return [];

  if (mongoConnected) {
    return RoomParticipantModel.find({ roomCode: normalizedCode }).sort({ joinedAt: 1 }).lean();
  }

  return [...memoryStore.roomParticipants.values()]
    .filter((row) => row.roomCode === normalizedCode)
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
    .map((row) => getProfileStoreCopy(row));
}

async function getVideoSessionByRoomCode(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase();
  if (!normalizedCode) return null;

  if (mongoConnected) {
    return VideoSessionModel.findOne({ roomCode: normalizedCode }).lean();
  }

  const row = memoryStore.videoSessions.get(normalizedCode);
  return row ? getProfileStoreCopy(row) : null;
}

// ─── Presence ─────────────────────────────────────────────────────────────────
// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "PATCH"],
  credentials: true,
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use("/api", applyHttpRateLimit(HTTP_RATE_LIMIT_MAX, "http"));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    mongoConnected,
    inMemoryFallback: !mongoConnected,
  });
});

async function requireHttpAuth(req, res, next) {
  try {
    const key = getRequestRateKey(req, "http-auth");
    if (isRateLimitExceeded(httpAuthRateLimitHits, key, HTTP_RATE_LIMIT_WINDOW_MS, HTTP_AUTH_RATE_LIMIT_MAX)) {
      return res.status(429).json({ error: "Too many auth requests. Please slow down." });
    }

    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = header.slice(7).trim();
    const decoded = await admin.auth().verifyIdToken(token);
    const identity = {
      uid: decoded.uid,
      name: decoded.name || decoded.email || "Anonymous",
      email: decoded.email || "",
      phoneNumber: decoded.phone_number || "",
      photoURL: decoded.picture || "",
    };

    const profile = await ensureProfile(identity);
    // Routes usually need both the verified Firebase identity and Lumiere's
    // normalized profile record, so attach both once here.
    req.authUser = identity;
    req.profile = profile;
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Authentication failed" });
  }
}

app.post("/api/uploads/document", requireHttpAuth, async (req, res) => {
  try {
    const fileName = String(req.body?.fileName || "").trim();
    const mimeType = String(req.body?.mimeType || "").trim();
    const base64Data = String(req.body?.base64Data || "").trim();
    if (!base64Data) {
      return res.status(400).json({ error: "base64Data is required" });
    }

    const uploaded = upsertDocumentUpload({
      ownerUid: req.authUser.uid,
      fileName,
      mimeType,
      base64Data,
    });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    return res.json({
      id: uploaded.id,
      url: `${baseUrl}/api/uploads/document/${uploaded.id}`,
      mimeType: uploaded.mimeType,
      fileName: uploaded.fileName,
      bytes: uploaded.bytes,
      signature: buildDocumentSignature(uploaded.fileName, uploaded.bytes),
      expiresAt: uploaded.expiresAt,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not upload document" });
  }
});

app.get("/api/uploads/document/:documentId", async (req, res) => {
  const documentId = String(req.params.documentId || "").trim();
  const row = getUploadedDocumentById(documentId);
  if (!row) return res.status(404).send("Document not found or expired");

  try {
    const buffer = Buffer.from(row.base64Data, "base64");
    // Allow embedding in the frontend iframe on a different origin (:5173 -> :5001).
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Type, Content-Length, Content-Disposition, X-Document-Signature, X-Document-Name, X-Document-Size"
    );
    res.setHeader("Content-Type", row.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `inline; filename=\"${row.fileName || "document"}\"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Document-Signature", buildDocumentSignature(row.fileName, row.bytes));
    res.setHeader("X-Document-Name", row.fileName || "document.pdf");
    res.setHeader("X-Document-Size", String(Math.max(0, Number(row.bytes) || 0)));
    return res.send(buffer);
  } catch {
    return res.status(500).send("Could not serve document");
  }
});

app.get("/api/username/check", requireHttpAuth, async (req, res) => {
  const username = normalizeUsername(req.query.username);
  if (!USERNAME_REGEX.test(username)) {
    return res.status(400).json({ available: false, error: "Username must be 3-20 chars" });
  }

  const available = await isUsernameAvailable(username, req.authUser.uid);
  return res.json({ available, username });
});

app.post("/api/username/claim", requireHttpAuth, async (req, res) => {
  try {
    const profile = await claimUsername(req.authUser.uid, req.body?.username);
    await logActivity({
      uid: req.authUser.uid,
      type: "username_claimed",
      payload: { username: profile.username || "" },
    });
    return res.json({ profile: publicProfile(profile) });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not claim username" });
  }
});

app.get("/api/me", requireHttpAuth, async (req, res) => {
  const profile = await getProfileByUid(req.authUser.uid);
  if (!profile) {
    return res.status(404).json({ error: "Profile not found" });
  }
  const friendGraph = await listFriendGraph(req.authUser.uid);

  return res.json({
    profile: {
      ...publicProfile(profile),
      email: profile.email || "",
      bio: profile.bio || "",
      isAdmin: isAdminUser(req.authUser.uid),
      settings: profile.settings || { ...DEFAULT_SETTINGS },
      friendsCount: friendGraph.friends.length,
      incomingRequestsCount: friendGraph.incomingRequests.length,
      outgoingRequestsCount: friendGraph.outgoingRequests.length,
      totalWatchTime: Math.max(0, Number(profile.totalWatchTime) || 0),
      totalSessions: Math.max(0, Number(profile.totalSessions) || 0),
      streakCount: Math.max(0, Number(profile.streakCount) || 0),
      preferences: {
        favoriteGenres: uniqueStrings(Array.isArray(profile.preferences?.favoriteGenres) ? profile.preferences.favoriteGenres : []),
        activeTimeSlots: uniqueStrings(Array.isArray(profile.preferences?.activeTimeSlots) ? profile.preferences.activeTimeSlots : []),
      },
    },
  });
});

app.patch("/api/me", requireHttpAuth, async (req, res) => {
  try {
    const profile = await getProfileByUid(req.authUser.uid);
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    const next = { ...profile };

    if (typeof req.body?.displayName === "string") {
      const displayName = sanitize(req.body.displayName).slice(0, 60);
      if (!displayName) {
        return res.status(400).json({ error: "Display name is required" });
      }
      next.displayName = displayName;
    }

    if (typeof req.body?.photoURL === "string") {
      next.photoURL = sanitizePhotoURL(req.body.photoURL);
    }

    if (typeof req.body?.bio === "string") {
      next.bio = sanitizeBio(req.body.bio);
    }

    if (req.body?.settings && typeof req.body.settings === "object") {
      next.settings = {
        inviteNotifications: req.body.settings.inviteNotifications ?? profile.settings?.inviteNotifications ?? DEFAULT_SETTINGS.inviteNotifications,
        memoryNudges: req.body.settings.memoryNudges ?? profile.settings?.memoryNudges ?? DEFAULT_SETTINGS.memoryNudges,
        showOnlineStatus: req.body.settings.showOnlineStatus ?? profile.settings?.showOnlineStatus ?? DEFAULT_SETTINGS.showOnlineStatus,
      };
    }

    const saved = await saveProfile(next);
    await logActivity({
      uid: req.authUser.uid,
      type: "profile_updated",
      payload: {
        displayName: saved.displayName || "",
        hasPhoto: !!saved.photoURL,
      },
    });
    return res.json({ profile: saved });
  } catch (error) {
    return res.status(500).json({ error: "Could not update profile" });
  }
});

app.get("/api/users/search", requireHttpAuth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    return res.json({ users: [] });
  }

  const [me, friendGraph] = await Promise.all([
    getProfileByUid(req.authUser.uid),
    listFriendGraph(req.authUser.uid),
  ]);
  const users = await searchProfiles(q, req.authUser.uid, 14);
  const result = users.map((profile) => ({
    ...publicProfile(profile),
    relationship: mongoConnected ? relationshipWithGraph(friendGraph, profile.uid) : relationshipWith(me, profile.uid),
  }));

  return res.json({ users: result });
});

app.get("/api/friends", requireHttpAuth, async (req, res) => {
  const [me, friendGraph] = await Promise.all([
    getProfileByUid(req.authUser.uid),
    listFriendGraph(req.authUser.uid),
  ]);
  if (!me) return res.status(404).json({ error: "Profile not found" });

  const [friends, incoming, outgoing] = await Promise.all([
    listProfilesByUids(friendGraph.friends),
    listProfilesByUids(friendGraph.incomingRequests),
    listProfilesByUids(friendGraph.outgoingRequests),
  ]);

  const withPresence = (profile) => ({
    ...publicProfile(profile),
    online: isOnline(profile.uid),
  });

  return res.json({
    friends: friends.map(withPresence),
    incomingRequests: incoming.map(withPresence),
    outgoingRequests: outgoing.map(withPresence),
  });
});

app.post("/api/friends/request", requireHttpAuth, async (req, res) => {
  try {
    const targetUid = String(req.body?.targetUid || "").trim();
    const result = await sendFriendRequest(req.authUser.uid, targetUid);

    if (result.status === "requested") {
      const referenceId = pairKeyFromUsers(req.authUser.uid, targetUid) || "";
      await createNotification({
        recipientUid: targetUid,
        senderUid: req.authUser.uid,
        type: "friend_request",
        referenceId,
        payload: { status: "pending" },
        actionRequired: true,
      });
      socketIdsForUser(targetUid).forEach((socketId) => {
        io.to(socketId).emit("friend_request_received", {
          from: publicProfile(result.from),
        });
      });
    }

    await logActivity({
      uid: req.authUser.uid,
      targetUid,
      type: "friend_request_sent",
      payload: { status: result.status },
    });

    return res.json({ status: result.status });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not send request" });
  }
});

app.post("/api/friends/respond", requireHttpAuth, async (req, res) => {
  try {
    const requesterUid = String(req.body?.requesterUid || "").trim();
    const action = String(req.body?.action || "").trim();
    const result = await respondFriendRequest(req.authUser.uid, requesterUid, action);
    const referenceId = pairKeyFromUsers(req.authUser.uid, requesterUid) || "";
    await markNotificationsReadByReference({
      recipientUid: req.authUser.uid,
      type: "friend_request",
      referenceId,
    });

    socketIdsForUser(requesterUid).forEach((socketId) => {
      io.to(socketId).emit("friend_request_updated", {
        fromUid: req.authUser.uid,
        action,
      });
    });

    if (action === "accept") {
      const mePublic = publicProfile(result.target);
      await createNotification({
        recipientUid: requesterUid,
        senderUid: req.authUser.uid,
        type: "friend_request_accepted",
        referenceId,
        payload: { action: "accept" },
        actionRequired: false,
      });
      socketIdsForUser(requesterUid).forEach((socketId) => {
        io.to(socketId).emit("friend_added", { friend: mePublic });
      });
    } else {
      await createNotification({
        recipientUid: requesterUid,
        senderUid: req.authUser.uid,
        type: "friend_request_rejected",
        referenceId,
        payload: { action: "reject" },
        actionRequired: false,
      });
    }

    await logActivity({
      uid: req.authUser.uid,
      targetUid: requesterUid,
      type: action === "accept" ? "friend_request_accepted" : "friend_request_rejected",
      payload: { action },
    });

    return res.json({ status: action });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not respond to request" });
  }
});

app.post("/api/friends/invite-room", requireHttpAuth, async (req, res) => {
  try {
    const friendUid = String(req.body?.friendUid || "").trim();
    const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
    if (!friendUid || !roomCode) {
      return res.status(400).json({ error: "friendUid and roomCode are required" });
    }

    const [me, friend] = await Promise.all([
      getProfileByUid(req.authUser.uid),
      getProfileByUid(friendUid),
    ]);
    const friendGraph = await listFriendGraph(req.authUser.uid);
    if (!me || !friendGraph.friends.includes(friendUid)) {
      return res.status(403).json({ error: "You can invite only friends" });
    }
    if (!friend) {
      return res.status(404).json({ error: "Friend not found" });
    }
    if (friend.settings?.inviteNotifications === false) {
      return res.json({ delivered: false, deliveries: 0, mutedByFriend: true });
    }

    const sockets = socketIdsForUser(friendUid);
    await createInviteRecord({
      fromUid: req.authUser.uid,
      toUid: friendUid,
      roomCode,
      status: "sent",
    });
    await createNotification({
      recipientUid: friendUid,
      senderUid: req.authUser.uid,
      type: "room_invite",
      referenceId: roomCode,
      roomCode,
      payload: {
        fromUsername: me.username || "",
        fromName: me.displayName || "",
      },
      actionRequired: true,
    });
    sockets.forEach((socketId) => {
      io.to(socketId).emit("friend_invite", {
        fromUid: req.authUser.uid,
        fromUsername: me.username || "",
        fromName: me.displayName,
        fromPhotoURL: me.photoURL || "",
        roomCode,
        timestamp: Date.now(),
      });
    });

    await logActivity({
      uid: req.authUser.uid,
      targetUid: friendUid,
      roomCode,
      type: "room_invite_sent",
      payload: { deliveries: sockets.length },
    });

    return res.json({ delivered: sockets.length > 0, deliveries: sockets.length });
  } catch (error) {
    return res.status(500).json({ error: "Could not send invite" });
  }
});

app.get("/api/activity", requireHttpAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 40));
    const rows = await listActivityForUser(req.authUser.uid, limit);
    const targetUids = uniqueStrings(rows.map((row) => row.targetUid).filter(Boolean));
    const profiles = await listProfilesByUids(targetUids);
    const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]));

    return res.json({
      items: rows.map((row) => {
        const target = profileByUid.get(row.targetUid || "");
        return {
          type: row.type,
          roomCode: row.roomCode || "",
          targetUid: row.targetUid || "",
          target: target
            ? {
              uid: target.uid,
              username: target.username || "",
              displayName: target.displayName || "Friend",
              photoURL: target.photoURL || "",
            }
            : null,
          payload: row.payload || {},
          occurredAt: row.occurredAt,
        };
      }),
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not load activity" });
  }
});

app.get("/api/notifications", requireHttpAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 40));
    const unreadOnly = ["1", "true", "yes"].includes(String(req.query.unreadOnly || "").toLowerCase());
    const [items, unreadCount] = await Promise.all([
      listNotificationsForUser(req.authUser.uid, { limit, unreadOnly }),
      countUnreadNotifications(req.authUser.uid),
    ]);

    const senderUids = uniqueStrings(items.map((item) => item.senderUid).filter(Boolean));
    const senderProfiles = await listProfilesByUids(senderUids);
    const senderByUid = new Map(senderProfiles.map((profile) => [profile.uid, profile]));

    return res.json({
      unreadCount,
      items: items.map((item) => {
        const sender = senderByUid.get(item.senderUid);
        return {
          id: item.id,
          type: item.type,
          referenceId: item.referenceId,
          roomCode: item.roomCode || "",
          payload: item.payload || {},
          actionRequired: !!item.actionRequired,
          isRead: !!item.isRead,
          readAt: item.readAt,
          createdAt: item.createdAt,
          sender: sender
            ? {
              ...publicProfile(sender),
              online: isOnline(sender.uid),
            }
            : item.senderUid
              ? {
                uid: item.senderUid,
                username: "",
                displayName: "Friend",
                photoURL: "",
                bio: "",
                online: false,
              }
              : null,
        };
      }),
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not load notifications" });
  }
});

app.post("/api/notifications/read", requireHttpAuth, async (req, res) => {
  try {
    const notificationId = String(req.body?.notificationId || "").trim();
    if (!notificationId) {
      return res.status(400).json({ error: "notificationId is required" });
    }
    const ok = await markNotificationRead(notificationId, req.authUser.uid);
    if (!ok) {
      return res.status(404).json({ error: "Notification not found" });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "Could not mark notification read" });
  }
});

app.post("/api/notifications/read-all", requireHttpAuth, async (req, res) => {
  try {
    const updated = await markAllNotificationsRead(req.authUser.uid);
    return res.json({ ok: true, updated });
  } catch (error) {
    return res.status(500).json({ error: "Could not mark notifications read" });
  }
});

app.get("/api/memories", requireHttpAuth, async (req, res) => {
  try {
    const events = await listMemoryEventsForUser(req.authUser.uid);
    const friendUids = uniqueStrings(events.flatMap((event) => event.users.filter((uid) => uid !== req.authUser.uid)));
    const friendProfiles = await listProfilesByUids(friendUids);
    const memories = aggregateMemories(req.authUser.uid, events, friendProfiles);
    return res.json(memories);
  } catch (error) {
    return res.status(500).json({ error: "Could not load memories" });
  }
});

app.get("/api/shared-memories", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || "").trim();
    const rows = await listSharedMemoriesForUser(req.authUser.uid, partnerUid);
    const otherUids = uniqueStrings(rows.flatMap((row) => [row.user1Id, row.user2Id]).filter((uid) => uid !== req.authUser.uid));
    const profiles = await listProfilesByUids(otherUids);
    const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]));

    const items = rows.map((row) => {
      const partnerId = row.user1Id === req.authUser.uid ? row.user2Id : row.user1Id;
      const partner = profileByUid.get(partnerId);
      return {
        id: row.id,
        roomCode: row.roomCode || "",
        date: row.date,
        memoryNote: row.memoryNote,
        sessionMode: row.sessionMode || "watch",
        genre: row.genre || "",
        moodTag: row.moodTag || "",
        highlightTimestamp: row.highlightTimestamp || "",
        sessionMinutes: clampSharedSessionMinutes(row.sessionMinutes),
        reactionCount: clampReactionCount(row.reactionCount),
        createdBy: row.createdBy || "",
        partner: partner
          ? {
            ...publicProfile(partner),
            online: isOnline(partner.uid),
          }
          : {
            uid: partnerId,
            username: "",
            displayName: "Friend",
            photoURL: "",
            bio: "",
            online: false,
          },
      };
    });

    return res.json({ items });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not load shared memories" });
  }
});

app.post("/api/shared-memories", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || "").trim();
    const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
    const memoryNote = sanitizeSharedMemoryNote(req.body?.memoryNote || "");
    const date = req.body?.date ? new Date(req.body.date) : new Date();
    const sessionMode = normalizeSessionMode(req.body?.sessionMode || "watch");
    const genre = sanitizeSharedMemoryGenre(req.body?.genre || "");
    const moodTag = sanitizeSharedMemoryMoodTag(req.body?.moodTag || "");
    const highlightTimestamp = sanitizeHighlightTimestamp(req.body?.highlightTimestamp || "");
    const sessionMinutes = clampSharedSessionMinutes(req.body?.sessionMinutes);
    const reactionCount = clampReactionCount(req.body?.reactionCount);

    if (!partnerUid) return res.status(400).json({ error: "partnerUid is required" });
    if (!memoryNote) return res.status(400).json({ error: "memoryNote is required" });

    const { me, partner } = await getValidatedCoupleUsers(req.authUser.uid, partnerUid);
    const row = await createSharedMemory({
      userA: req.authUser.uid,
      userB: partnerUid,
      roomCode,
      memoryNote,
      createdBy: req.authUser.uid,
      date,
      sessionMode,
      genre,
      moodTag,
      highlightTimestamp,
      sessionMinutes,
      reactionCount,
    });

    await logActivity({
      uid: req.authUser.uid,
      targetUid: partnerUid,
      roomCode,
      type: "shared_memory_created",
      payload: {
        noteLength: memoryNote.length,
        sessionMode,
        genre,
        moodTag,
        hasHighlightTimestamp: !!highlightTimestamp,
        sessionMinutes,
        reactionCount,
      },
    });
    await createNotification({
      recipientUid: partnerUid,
      senderUid: req.authUser.uid,
      type: "shared_memory_added",
      referenceId: row.id,
      roomCode,
      payload: { noteLength: memoryNote.length },
      actionRequired: false,
    });

    socketIdsForUser(partnerUid).forEach((socketId) => {
      io.to(socketId).emit("shared_memory_added", {
        fromUid: req.authUser.uid,
        fromUsername: me.username || "",
        fromName: me.displayName || "",
        roomCode,
      });
    });

    return res.status(201).json({
      item: {
        id: row.id,
        roomCode: row.roomCode,
        date: row.date,
        memoryNote: row.memoryNote,
        sessionMode: row.sessionMode || "watch",
        genre: row.genre || "",
        moodTag: row.moodTag || "",
        highlightTimestamp: row.highlightTimestamp || "",
        sessionMinutes: clampSharedSessionMinutes(row.sessionMinutes),
        reactionCount: clampReactionCount(row.reactionCount),
        createdBy: row.createdBy,
        partner: {
          ...publicProfile(partner),
          online: isOnline(partner.uid),
        },
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not create shared memory" });
  }
});

app.get("/api/watch-sessions", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || "").trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    if (partnerUid) {
      await getValidatedCoupleUsers(req.authUser.uid, partnerUid);
    }

    const rows = await listWatchSessionsForUser(req.authUser.uid, {
      partnerUid,
      limit,
      year: req.query.year || null,
    });
    const otherUids = uniqueStrings(
      rows.flatMap((row) => (Array.isArray(row.participants) ? row.participants : []))
        .filter((uid) => uid !== req.authUser.uid)
    );
    const profiles = await listProfilesByUids(otherUids);
    const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]));

    return res.json({
      items: rows.map((row) => ({
        id: row.id,
        roomCode: row.roomCode,
        roomType: row.roomType,
        sessionMode: row.sessionMode,
        relationshipId: row.relationshipId || "",
        relationshipType: row.relationshipType || "group",
        contentUrl: row.contentUrl || "",
        contentTitle: row.contentTitle || "",
        contentType: row.contentType || "unknown",
        genre: row.genre || "",
        moodTag: row.moodTag || "",
        duration: row.duration || 0,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        reactionsCount: row.reactionsCount || 0,
        highlights: row.highlights || [],
        participants: row.participants.map((participantUid) => {
          const profile = profileByUid.get(participantUid);
          if (!profile) {
            return {
              uid: participantUid,
              username: "",
              displayName: participantUid === req.authUser.uid ? "You" : "Friend",
              photoURL: "",
              bio: "",
              online: isOnline(participantUid),
            };
          }
          return {
            ...publicProfile(profile),
            online: isOnline(profile.uid),
          };
        }),
      })),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not load watch sessions" });
  }
});

app.get("/api/milestones", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || "").trim();
    if (partnerUid) {
      await getValidatedCoupleUsers(req.authUser.uid, partnerUid);
    }
    const items = await listMilestonesForUser(req.authUser.uid, partnerUid);
    return res.json({
      items: items.map((row) => ({
        id: row.id,
        relationshipId: row.relationshipId,
        pairKey: row.pairKey,
        users: row.users,
        type: row.type,
        achievedAt: row.achievedAt,
        payload: row.payload || {},
      })),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not load milestones" });
  }
});

app.get("/api/insights", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || "").trim();
    const rawYear = Number(req.query.year);
    const hasYear = Number.isFinite(rawYear);
    const year = hasYear
      ? Math.max(2000, Math.min(2200, Math.floor(rawYear)))
      : new Date().getFullYear();

    if (partnerUid) {
      await getValidatedCoupleUsers(req.authUser.uid, partnerUid);
      const pairKey = pairKeyFromUsers(req.authUser.uid, partnerUid);
      if (!pairKey) {
        return res.status(400).json({ error: "Invalid partner relationship" });
      }

      let insight = await getInsightForPairYear(pairKey, year);
      if (!insight) {
        const relationshipRow = await getRelationshipByPairKey(pairKey);
        if (relationshipRow?.status === "accepted") {
          insight = await regenerateRelationshipInsight(relationshipRow, year);
        }
      }

      if (!insight) {
        return res.json({ item: null });
      }

      return res.json({ item: insight });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const rows = await listInsightsForUser(req.authUser.uid, { year: hasYear ? year : null, limit });
    return res.json({ items: rows });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not load insights" });
  }
});

app.get("/api/project-overview", requireHttpAuth, async (req, res) => {
  try {
    if (!isAdminUser(req.authUser.uid)) {
      return res.status(403).json({ error: "Metadata is available only for admins" });
    }
    const overview = await getProjectOverview(req.authUser.uid);
    return res.json(overview);
  } catch (error) {
    return res.status(500).json({ error: "Could not load project overview" });
  }
});

app.get("/api/relationships", requireHttpAuth, async (req, res) => {
  try {
    const uid = req.authUser.uid;
    const rows = await listRelationshipRowsForUser(uid);

    const partnerUids = uniqueStrings(rows.map((row) => row.users.find((item) => item !== uid)).filter(Boolean));
    const partnerProfiles = await listProfilesByUids(partnerUids);
    const profileByUid = new Map(partnerProfiles.map((profile) => [profile.uid, profile]));

    const relationships = rows.map((row) => {
      const partnerUid = row.users.find((item) => item !== uid) || "";
      const partner = profileByUid.get(partnerUid);
      return {
        pairKey: row.pairKey,
        status: row.status,
        relationshipType: normalizeRelationshipType(row.relationshipType || "friends"),
        requestedBy: row.requestedBy || "",
        lastActionBy: row.lastActionBy || "",
        lastActionAt: row.lastActionAt || row.updatedAt || row.createdAt || new Date(),
        totalWatchTime: Math.max(0, Number(row.totalWatchTime) || 0),
        totalSessions: Math.max(0, Number(row.totalSessions) || 0),
        longestSession: Math.max(0, Number(row.longestSession) || 0),
        streak: Math.max(0, Number(row.streak) || 0),
        firstWatchedAt: row.firstWatchedAt || null,
        lastWatchedAt: row.lastWatchedAt || null,
        lastSessionMode: normalizeSessionMode(row.lastSessionMode || "watch"),
        topGenres: uniqueStrings(Array.isArray(row.topGenres) ? row.topGenres : []),
        activeTimeSlots: uniqueStrings(Array.isArray(row.activeTimeSlots) ? row.activeTimeSlots : []),
        partner: partner
          ? {
            ...publicProfile(partner),
            online: isOnline(partner.uid),
          }
          : {
            uid: partnerUid,
            username: "",
            displayName: "Friend",
            photoURL: "",
            bio: "",
            online: false,
          },
      };
    });

    return res.json({ relationships });
  } catch (error) {
    return res.status(500).json({ error: "Could not load relationships" });
  }
});

app.patch("/api/relationships/tag", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || "").trim();
    const relationshipType = normalizeRelationshipType(req.body?.relationshipType || "friends", "friends");
    if (!partnerUid) {
      return res.status(400).json({ error: "partnerUid is required" });
    }
    if (partnerUid === req.authUser.uid) {
      return res.status(400).json({ error: "Cannot tag relationship with self" });
    }

    const row = await getRelationshipRow(req.authUser.uid, partnerUid);
    if (!row || row.status !== "accepted") {
      return res.status(403).json({ error: "Only accepted relationships can be tagged" });
    }

    const updated = await setRelationshipType(req.authUser.uid, partnerUid, relationshipType, req.authUser.uid);
    if (!updated) {
      return res.status(500).json({ error: "Could not update relationship tag" });
    }

    await logActivity({
      uid: req.authUser.uid,
      targetUid: partnerUid,
      type: "relationship_tag_updated",
      payload: { relationshipType },
    });

    socketIdsForUser(partnerUid).forEach((socketId) => {
      io.to(socketId).emit("relationship_tag_updated", {
        uid: req.authUser.uid,
        partnerUid,
        relationshipType,
      });
    });

    return res.json({
      relationship: {
        pairKey: updated.pairKey,
        relationshipType: normalizeRelationshipType(updated.relationshipType || relationshipType, "friends"),
        status: updated.status || "accepted",
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not update relationship tag" });
  }
});

app.get("/api/room-history/:roomCode", requireHttpAuth, async (req, res) => {
  try {
    const roomCode = String(req.params.roomCode || "").trim().toUpperCase();
    if (!roomCode) return res.status(400).json({ error: "roomCode is required" });

    const liveRoom = rooms.get(roomCode);
    const participants = await listRoomParticipantsByCode(roomCode);
    const isLiveMember = !!(liveRoom && liveRoom.users.has(req.authUser.uid));
    const wasParticipant = participants.some((row) => row.userId === req.authUser.uid);
    if (!isLiveMember && !wasParticipant) {
      return res.status(403).json({ error: "You do not have access to this room history" });
    }

    const roomMeta = await getRoomMetadataByCode(roomCode);
    const videoSession = await getVideoSessionByRoomCode(roomCode);

    let activities = [];
    let chat = [];
    if (mongoConnected) {
      [activities, chat] = await Promise.all([
        ActivityEventModel.find({ roomCode }).sort({ occurredAt: -1 }).limit(120).lean(),
        ChatArchiveModel.find({ roomCode }).sort({ timestamp: -1 }).limit(120).lean(),
      ]);
    } else {
      activities = memoryStore.activityEvents
        .filter((row) => row.roomCode === roomCode)
        .slice(-120)
        .reverse()
        .map((row) => ({ ...row }));
      chat = memoryStore.chatMessages
        .filter((row) => row.roomCode === roomCode)
        .slice(-120)
        .reverse()
        .map((row) => ({ ...row }));
    }

    const liveHistory = liveRoom?.history
      ? [...liveRoom.history].slice(-120).reverse()
      : [];

    return res.json({
      room: roomMeta
        ? {
          roomCode: roomMeta.roomCode,
          roomType: roomMeta.roomType || "friends",
          sessionMode: roomMeta.sessionMode || "watch",
          moodTag: roomMeta.moodTag || "",
          isActive: !!roomMeta.isActive,
          createdBy: roomMeta.createdBy || "",
          createdAt: roomMeta.createdAt || null,
          expiresAt: roomMeta.expiresAt || null,
          closedAt: roomMeta.closedAt || null,
          contentUrl: roomMeta.contentUrl || "",
          contentType: roomMeta.contentType || "unknown",
          permissions: roomMeta.permissions || { play: true, pause: true, seek: true, skip: true },
        }
        : {
          roomCode,
          roomType: liveRoom?.roomType || "friends",
          sessionMode: liveRoom?.sessionMode || "watch",
          moodTag: liveRoom?.moodTag || "",
          isActive: !!liveRoom,
          contentUrl: liveRoom?.contentUrl || "",
          contentType: liveRoom?.contentType || "unknown",
          permissions: { play: true, pause: true, seek: true, skip: true },
        },
      participants: participants.map((row) => ({
        userId: row.userId,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt || null,
        isActive: !!row.isActive,
      })),
      videoSession: videoSession
        ? {
          videoName: videoSession.videoName || "",
          duration: videoSession.duration || 0,
          sourceType: videoSession.sourceType || "unknown",
          totalWatchTime: videoSession.totalWatchTime || 0,
          startedAt: videoSession.startedAt || null,
          endedAt: videoSession.endedAt || null,
        }
        : null,
      activity: activities.map((item) => ({
        type: item.type,
        uid: item.uid || "",
        targetUid: item.targetUid || "",
        occurredAt: item.occurredAt || item.createdAt || new Date(),
      })),
      chat: chat.map((item) => ({
        messageId: item.messageId,
        uid: item.uid,
        senderUsername: item.senderUsername || "",
        text: item.text || "",
        type: item.type || "text",
        timestamp: item.timestamp || item.createdAt || new Date(),
      })),
      liveHistory,
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not load room history" });
  }
});

app.get("/api/couple-space", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || "").trim();
    if (!partnerUid) {
      return res.status(400).json({ error: "partnerUid is required" });
    }

    const { partner } = await getValidatedCoupleUsers(req.authUser.uid, partnerUid);
    const space = await getCoupleSpaceByUsers(req.authUser.uid, partnerUid, true);
    const mapped = mapCoupleSpace(space, req.authUser.uid);

    return res.json({
      partner: {
        ...publicProfile(partner),
        online: isOnline(partner.uid),
      },
      space: mapped,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not load couple space" });
  }
});

app.post("/api/couple-space/item", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || "").trim();
    const title = sanitize(String(req.body?.title || "")).slice(0, MAX_WATCHLIST_TITLE_LENGTH);
    const url = String(req.body?.url || "").trim().slice(0, MAX_WATCHLIST_URL_LENGTH);
    const notes = sanitize(String(req.body?.notes || "")).slice(0, MAX_WATCHLIST_NOTES_LENGTH);
    if (!partnerUid) return res.status(400).json({ error: "partnerUid is required" });
    if (!title) return res.status(400).json({ error: "title is required" });

    const { me, partner } = await getValidatedCoupleUsers(req.authUser.uid, partnerUid);
    const space = await getCoupleSpaceByUsers(req.authUser.uid, partnerUid, true);
    const watchlist = Array.isArray(space.watchlist) ? [...space.watchlist] : [];
    if (watchlist.length >= MAX_WATCHLIST_ITEMS) {
      return res.status(400).json({ error: `Watchlist limit reached (${MAX_WATCHLIST_ITEMS})` });
    }

    const now = new Date();
    watchlist.unshift({
      id: `${req.authUser.uid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      url,
      notes,
      done: false,
      addedBy: req.authUser.uid,
      createdAt: now,
      updatedAt: now,
    });

    const saved = await saveCoupleSpace({
      ...space,
      pairKey: pairKeyFromUsers(req.authUser.uid, partnerUid),
      users: sortedPairUsers(req.authUser.uid, partnerUid),
      watchlist,
    });
    const mapped = mapCoupleSpace(saved, req.authUser.uid);

    socketIdsForUser(partnerUid).forEach((socketId) => {
      io.to(socketId).emit("couple_space_updated", {
        partnerUid: req.authUser.uid,
        partnerName: me.displayName,
        partnerUsername: me.username,
        itemTitle: title,
      });
    });

    await logActivity({
      uid: req.authUser.uid,
      targetUid: partnerUid,
      type: "couple_watchlist_item_added",
      payload: { title, hasLink: !!url },
    });

    return res.json({
      partner: { ...publicProfile(partner), online: isOnline(partner.uid) },
      space: mapped,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not add watchlist item" });
  }
});

app.patch("/api/couple-space/item", requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || "").trim();
    const itemId = String(req.body?.itemId || "").trim();
    const action = String(req.body?.action || "").trim();
    if (!partnerUid || !itemId || !action) {
      return res.status(400).json({ error: "partnerUid, itemId and action are required" });
    }
    if (!["toggle_done", "remove", "edit"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const { me, partner } = await getValidatedCoupleUsers(req.authUser.uid, partnerUid);
    const space = await getCoupleSpaceByUsers(req.authUser.uid, partnerUid, true);
    let watchlist = Array.isArray(space.watchlist) ? [...space.watchlist] : [];
    const itemIndex = watchlist.findIndex((item) => String(item.id) === itemId);
    if (itemIndex === -1) {
      return res.status(404).json({ error: "Watchlist item not found" });
    }

    const currentItem = normalizeWatchlistItem(watchlist[itemIndex]);
    if (action === "remove") {
      watchlist = watchlist.filter((item) => String(item.id) !== itemId);
    } else if (action === "toggle_done") {
      watchlist[itemIndex] = {
        ...currentItem,
        done: typeof req.body?.done === "boolean" ? req.body.done : !currentItem.done,
        updatedAt: new Date(),
      };
    } else if (action === "edit") {
      const nextTitle = sanitize(String(req.body?.title || currentItem.title)).slice(0, MAX_WATCHLIST_TITLE_LENGTH);
      if (!nextTitle) {
        return res.status(400).json({ error: "title is required" });
      }
      watchlist[itemIndex] = {
        ...currentItem,
        title: nextTitle,
        url: String(req.body?.url ?? currentItem.url).trim().slice(0, MAX_WATCHLIST_URL_LENGTH),
        notes: sanitize(String(req.body?.notes ?? currentItem.notes)).slice(0, MAX_WATCHLIST_NOTES_LENGTH),
        updatedAt: new Date(),
      };
    }

    const saved = await saveCoupleSpace({
      ...space,
      pairKey: pairKeyFromUsers(req.authUser.uid, partnerUid),
      users: sortedPairUsers(req.authUser.uid, partnerUid),
      watchlist,
    });
    const mapped = mapCoupleSpace(saved, req.authUser.uid);

    socketIdsForUser(partnerUid).forEach((socketId) => {
      io.to(socketId).emit("couple_space_updated", {
        partnerUid: req.authUser.uid,
        partnerName: me.displayName,
        partnerUsername: me.username,
        itemTitle: currentItem.title,
        action,
      });
    });

    await logActivity({
      uid: req.authUser.uid,
      targetUid: partnerUid,
      type: "couple_watchlist_item_updated",
      payload: { action, itemId },
    });

    return res.json({
      partner: { ...publicProfile(partner), online: isOnline(partner.uid) },
      space: mapped,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not update watchlist item" });
  }
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  pingTimeout: 20000,
  pingInterval: 10000,
});

// ─── Room Store ───────────────────────────────────────────────────────────────
// Realtime room state is intentionally process-local: Socket.IO needs very
// fast mutation here, while long-term analytics/history are persisted separately.
const rooms = new Map();
const pendingRoomUserDisconnects = new Map();

function roomUserDisconnectKey(roomCode, uid) {
  return `${String(roomCode || "")}::${String(uid || "")}`;
}

function clearPendingRoomUserDisconnect(roomCode, uid) {
  const key = roomUserDisconnectKey(roomCode, uid);
  const pending = pendingRoomUserDisconnects.get(key);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRoomUserDisconnects.delete(key);
  return true;
}

function clearPendingRoomDisconnects(roomCode) {
  const prefix = `${String(roomCode || "")}::`;
  pendingRoomUserDisconnects.forEach((pending, key) => {
    if (!key.startsWith(prefix)) return;
    clearTimeout(pending.timer);
    pendingRoomUserDisconnects.delete(key);
  });
}

function schedulePendingRoomUserDisconnect(roomCode, uid, graceMs, callback) {
  // Users often refresh, switch tabs, or briefly drop network. This grace timer
  // avoids treating that as a hard leave until no socket reconnects in time.
  const key = roomUserDisconnectKey(roomCode, uid);
  clearPendingRoomUserDisconnect(roomCode, uid);

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timer = setTimeout(async () => {
    const latest = pendingRoomUserDisconnects.get(key);
    if (!latest || latest.token !== token) return;
    pendingRoomUserDisconnects.delete(key);
    await callback();
  }, graceMs);
  timer.unref?.();

  pendingRoomUserDisconnects.set(key, { token, timer });
}

function makeRoom(roomCode, options = {}) {
  // Every session mode shares one canonical room shape so the socket handlers
  // can branch on mode without dealing with partially initialized state.
  const normalizedType = normalizeRoomType(options.roomType);
  const normalizedSessionMode = normalizeSessionMode(options.sessionMode);
  const sessionEngine = resolveSessionEngine(normalizedSessionMode);
  const normalizedMoodTag = sanitizeRoomMoodTag(options.moodTag || "");
  const normalizedMaxParticipants = Math.max(
    2,
    Math.min(10, Number(options.maxParticipants) || (normalizedType === "duo" ? 2 : MAX_ROOM_USERS))
  );
  const initialDocument = normalizedSessionMode === "reading" && options.contentUrl
    ? serializeRoomDocument(normalizeRoomDocumentPayload({
      fileUrl: options.contentUrl,
      fileName: options.fileName || deriveDocumentFileNameFromUrl(options.contentUrl) || "shared-document.pdf",
      fileSize: options.fileSize || 0,
      mimeType: options.mimeType || (String(options.contentType || "").toLowerCase() === "pdf" ? "application/pdf" : ""),
      totalPages: options.totalPages || 0,
    }))
    : null;
  const nowMs = Date.now();
  const initialContentUrl = sanitizeContentUrl(options.contentUrl || "");
  const initialContentType = normalizeContentType(options.contentType || "unknown");
  return {
    roomCode,
    roomType: normalizedType,
    sessionMode: normalizedSessionMode,
    sessionEngineId: sessionEngine.id,
    moodTag: normalizedMoodTag,
    createdBy: String(options.createdBy || ""),
    maxParticipants: normalizedMaxParticipants,
    createdAt: Date.now(),
    users: new Map(),
    joinedAtByUid: new Map(),
    memberTimes: new Map(),
    syncWait: {
      active: false,
      waitingForUid: null,
      waitingForUsername: null,
      pausedUids: new Set(),
      candidateUid: null,
      candidateSince: 0,
      resumeSince: 0,
      lastClearedAt: 0,
    },
    videoState: {
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1,
      lastUpdate: nowMs / 1000,
      scheduledStartAt: 0,
    },
    audioState: {
      status: "paused",
      startTime: 0,
      serverTime: nowMs,
      updatedAt: nowMs,
      playbackRate: 1,
      updatedBy: String(options.createdBy || ""),
    },
    mediaType: initialContentType === "youtube" ? "youtube" : "local",
    mediaMeta: {
      fileSignature: String(options.fileFingerprint || ""),
      url: initialContentUrl,
    },
    mutationLock: 0,
    lastAudioActionAt: 0,
    readingState: {
      page: 1,
      totalPages: initialDocument?.totalPages || 0,
      updatedAt: nowMs,
      updatedBy: String(options.createdBy || ""),
    },
    document: initialDocument,
    readingMutationLockUntil: 0,
    messages: [],
    videoMetadata: null,
    contentUrl: initialContentUrl,
    contentType: initialContentType,
    playbackStatus: "idle",
    baseTime: 0,
    startedAt: null,
    history: [],
    expiresAt: Date.now() + ROOM_EXPIRY_MS,
    expiryTimer: null,
  };
}

function resolveMusicMediaType(sourceType, contentUrl = "") {
  if (normalizeContentType(sourceType) === "youtube") return "youtube";
  return String(contentUrl || "").trim() ? "local" : "local";
}

function shouldScheduleVideoPlayback(room, isPlaying = false) {
  if (!room || !isPlaying) return false;
  const sourceType = normalizeContentType(room?.videoMetadata?.sourceType || room?.contentType || "");
  return sourceType === "youtube";
}

function getScheduledVideoStartAt(room, isPlaying = false, nowSec = Date.now() / 1000) {
  if (!shouldScheduleVideoPlayback(room, isPlaying)) return 0;
  return nowSec + (VIDEO_SCHEDULE_LEAD_MS / 1000);
}

function buildRoomMusicStatePayload(room) {
  return {
    mediaType: String(room?.mediaType || "local"),
    mediaMeta: {
      fileSignature: String(room?.mediaMeta?.fileSignature || ""),
      url: String(room?.mediaMeta?.url || ""),
    },
    audioState: {
      status: String(room?.audioState?.status || "paused"),
      startTime: clampTime(Number(room?.audioState?.startTime) || 0),
      serverTime: Math.max(0, Number(room?.audioState?.serverTime) || Date.now()),
      updatedAt: Math.max(0, Number(room?.audioState?.updatedAt) || Date.now()),
      playbackRate: (typeof room?.audioState?.playbackRate === "number" && room.audioState.playbackRate > 0)
        ? room.audioState.playbackRate
        : 1,
      updatedBy: String(room?.audioState?.updatedBy || ""),
    },
  };
}

function resolveRoomAudioPosition(room, nowMs = Date.now()) {
  const state = room?.audioState || {};
  const baseTime = clampTime(Number(state.startTime) || 0);
  if (String(state.status || "paused") !== "playing") return baseTime;
  const serverTimeMs = Math.max(0, Number(state.serverTime) || nowMs);
  const elapsedSeconds = Math.max(0, (nowMs - serverTimeMs) / 1000);
  return clampTime(baseTime + elapsedSeconds);
}

function acquireAudioMutationLock(room) {
  // Music controls can arrive in bursts from multiple clients; this tiny lock
  // serializes mutations so shared audio state does not flap mid-update.
  if (!room) return false;
  const nowMs = Date.now();
  if (Number(room.mutationLock) > nowMs) return false;
  room.mutationLock = nowMs + AUDIO_MUTATION_LOCK_MS;
  return true;
}

function validateMusicControlRequest(room, requesterFileSignature = "") {
  if (!room) return { ok: false, error: "Room not found" };
  if (room.sessionMode !== "music") return { ok: false, error: "Room is not in music mode" };
  const expectedSignature = String(room.mediaMeta?.fileSignature || "");
  if (room.mediaType === "local" && expectedSignature) {
    const normalizedSignature = String(requesterFileSignature || "").trim();
    if (!normalizedSignature || normalizedSignature !== expectedSignature) {
      return { ok: false, error: "Load the matching local audio file before controlling playback" };
    }
  }
  return { ok: true };
}

function broadcastRoomAudioSync(room, options = {}) {
  if (!room?.roomCode) return;
  const payload = {
    ...buildRoomMusicStatePayload(room),
    action: String(options.action || ""),
    triggeredBy: String(options.triggeredBy || ""),
    serverNow: Date.now(),
    hardSync: options.hardSync === true,
  };
  io.to(room.roomCode).emit("audio_sync", payload);
}

function getRoomReadingStatePayload(room) {
  return serializeReadingState(room?.readingState || {}, room?.document || null);
}

function getRoomDocumentPayload(room) {
  return serializeRoomDocument(room?.document || null);
}

function buildReadingInitialStatePayload(room) {
  const readingState = getRoomReadingStatePayload(room);
  return {
    document: getRoomDocumentPayload(room),
    page: readingState.page,
    totalPages: readingState.totalPages,
    readingState,
    hostId: String(room?.createdBy || ""),
  };
}

function pickNextRoomHostUid(room) {
  if (!room?.users || room.users.size === 0) return "";
  return [...room.users.keys()]
    .sort((uidA, uidB) => {
      const joinedAtA = Number(room.joinedAtByUid?.get(uidA) || 0);
      const joinedAtB = Number(room.joinedAtByUid?.get(uidB) || 0);
      return joinedAtA - joinedAtB;
    })[0] || "";
}

function ensureRoomUserSocketSet(roomUser) {
  if (!roomUser) return new Set();
  if (roomUser.socketIds instanceof Set) return roomUser.socketIds;

  const set = new Set();
  if (Array.isArray(roomUser.socketIds)) {
    roomUser.socketIds.forEach((socketId) => {
      if (typeof socketId === "string" && socketId) set.add(socketId);
    });
  } else if (typeof roomUser.socketId === "string" && roomUser.socketId) {
    set.add(roomUser.socketId);
  }

  roomUser.socketIds = set;
  return set;
}

function getRoomUserSocketIds(roomUser) {
  if (!roomUser) return [];
  return [...ensureRoomUserSocketSet(roomUser)];
}

function upsertRoomUser(room, userIdentity, socketId) {
  const existing = room.users.get(userIdentity.uid);
  if (existing) {
    const hadActiveSocketsBefore = getRoomUserSocketIds(existing).length > 0;
    existing.name = userIdentity.name;
    existing.username = userIdentity.username;
    existing.photoURL = userIdentity.photoURL;
    const sockets = ensureRoomUserSocketSet(existing);
    sockets.add(socketId);
    existing.socketId = socketId;
    return {
      user: existing,
      isRejoin: true,
      hadActiveSocketsBefore,
    };
  }

  const roomUser = {
    uid: userIdentity.uid,
    name: userIdentity.name,
    username: userIdentity.username,
    photoURL: userIdentity.photoURL,
    socketIds: new Set([socketId]),
    socketId,
  };
  room.users.set(userIdentity.uid, roomUser);
  return {
    user: roomUser,
    isRejoin: false,
    hadActiveSocketsBefore: false,
  };
}

function removeSocketFromRoomUser(room, uid, socketId) {
  const roomUser = room.users.get(uid);
  if (!roomUser) return { roomUser: null, activeSocketCount: 0 };

  const sockets = ensureRoomUserSocketSet(roomUser);
  sockets.delete(socketId);
  roomUser.socketId = sockets.size > 0 ? [...sockets][0] : null;

  return {
    roomUser,
    activeSocketCount: sockets.size,
  };
}

function emitToRoomUserSockets(roomUser, eventName, payload) {
  getRoomUserSocketIds(roomUser).forEach((socketId) => {
    io.to(socketId).emit(eventName, payload);
  });
}

function emitToUidSocketsInRoom(room, targetUid, eventName, payload) {
  const target = room.users.get(targetUid);
  if (!target) return 0;

  const socketIds = getRoomUserSocketIds(target);
  socketIds.forEach((socketId) => {
    io.to(socketId).emit(eventName, payload);
  });
  return socketIds.length;
}

function scheduleExpiry(room) {
  if (!room) return;
  clearTimeout(room.expiryTimer);
  room.expiryTimer = setTimeout(() => expireRoom(room.roomCode), ROOM_EXPIRY_MS);
}

function expireRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  clearTimeout(room.expiryTimer);
  clearPendingRoomDisconnects(roomCode);
  io.to(roomCode).emit("room_expired");
  io.in(roomCode).socketsLeave(roomCode);
  rooms.delete(roomCode);
  markRoomInactive(roomCode).catch(() => {});
  finalizeVideoSession(roomCode, room).catch(() => {});
  log(`[expired] ${roomCode}`);
}

function deleteIfEmpty(roomCode) {
  const room = rooms.get(roomCode);
  if (room && room.users.size === 0) {
    clearTimeout(room.expiryTimer);
    clearPendingRoomDisconnects(roomCode);
    rooms.delete(roomCode);
    markRoomInactive(roomCode).catch(() => {});
    finalizeVideoSession(roomCode, room).catch(() => {});
  }
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function getUserList(room) {
  return [...room.users.values()].map(({ uid, name, username, photoURL }) => ({ uid, name, username, photoURL }));
}

function clearSyncWait(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (!room.syncWait.active) {
    room.syncWait.candidateUid = null;
    room.syncWait.candidateSince = 0;
    room.syncWait.resumeSince = 0;
    return;
  }

  const { waitingForUid, waitingForUsername } = room.syncWait;
  room.syncWait.pausedUids.forEach((pausedUid) => {
    const pausedUser = room.users.get(pausedUid);
    if (pausedUser) {
      emitToRoomUserSockets(pausedUser, "resume_sync_wait", {
        waitForUid: waitingForUid,
        waitForUsername: waitingForUsername,
      });
    }
  });

  // Once the room is back within tolerance, clear all bookkeeping so the next
  // drift incident starts from a fresh baseline.
  room.syncWait.active = false;
  room.syncWait.waitingForUid = null;
  room.syncWait.waitingForUsername = null;
  room.syncWait.pausedUids.clear();
  room.syncWait.candidateUid = null;
  room.syncWait.candidateSince = 0;
  room.syncWait.resumeSince = 0;
  room.syncWait.lastClearedAt = Date.now();
  io.to(roomCode).emit("sync_waiting_resolved", {
    waitForUid: waitingForUid,
    waitForUsername: waitingForUsername,
  });
}

function getActiveMemberTimes(room) {
  const now = Date.now();
  const members = [];

  room.memberTimes.forEach((value, uid) => {
    const user = room.users.get(uid);
    const hasSockets = user && getRoomUserSocketIds(user).length > 0;
    if (!hasSockets || (now - value.updatedAt) > MEMBER_TIME_TTL_MS || !Number.isFinite(value.time)) {
      room.memberTimes.delete(uid);
      return;
    }

    const rawBufferAhead = Number(value.bufferAhead);
    const rawReadyState = Number(value.readyState);
    members.push({
      uid,
      time: clampTime(value.time),
      username: value.username || user.username || user.name || "friend",
      bufferAhead: Number.isFinite(rawBufferAhead)
        ? Math.max(0, Math.min(120, rawBufferAhead))
        : null,
      readyState: Number.isFinite(rawReadyState)
        ? Math.max(0, Math.min(4, Math.floor(rawReadyState)))
        : null,
      isBuffering: value.isBuffering === true,
    });
  });

  return members;
}

function isMemberLikelyBuffering(member) {
  if (!member) return false;
  if (member.isBuffering) return true;

  const hasBufferAhead = Number.isFinite(member.bufferAhead);
  const hasReadyState = Number.isFinite(member.readyState);
  if (!hasBufferAhead && !hasReadyState) return false;

  const lowBufferAhead = hasBufferAhead ? member.bufferAhead < SYNC_BUFFER_LOW_SECONDS : false;
  const lowReadyState = hasReadyState ? member.readyState > 0 && member.readyState < 3 : false;
  if (lowBufferAhead) return true;
  return lowReadyState && !hasBufferAhead;
}

function handleSyncWait(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const now = Date.now();
  if (!(room.syncWait.pausedUids instanceof Set)) {
    room.syncWait.pausedUids = new Set(room.syncWait.pausedUids || []);
  }
  if (!Number.isFinite(Number(room.syncWait.candidateSince))) room.syncWait.candidateSince = 0;
  if (!Number.isFinite(Number(room.syncWait.resumeSince))) room.syncWait.resumeSince = 0;
  if (!Number.isFinite(Number(room.syncWait.lastClearedAt))) room.syncWait.lastClearedAt = 0;
  if (typeof room.syncWait.candidateUid !== "string") room.syncWait.candidateUid = null;

  const members = getActiveMemberTimes(room);
  if (members.length < 2) {
    room.syncWait.candidateUid = null;
    room.syncWait.candidateSince = 0;
    room.syncWait.resumeSince = 0;
    clearSyncWait(roomCode);
    return;
  }

  let slowest = members[0];
  let fastest = members[0];
  members.forEach((member) => {
    if (member.time < slowest.time) slowest = member;
    if (member.time > fastest.time) fastest = member;
  });

  const gap = Math.max(0, fastest.time - slowest.time);
  if (!room.syncWait.active) {
    // Wait mode only activates after the same slow member stays behind for a
    // grace period; that prevents one noisy sample from pausing everyone else.
    if (gap < SYNC_WAIT_THRESHOLD) {
      room.syncWait.candidateUid = null;
      room.syncWait.candidateSince = 0;
      return;
    }
    if ((now - room.syncWait.lastClearedAt) < SYNC_WAIT_COOLDOWN_MS) {
      room.syncWait.candidateUid = null;
      room.syncWait.candidateSince = 0;
      return;
    }

    const slowestLikelyBuffering = isMemberLikelyBuffering(slowest);
    const activationThreshold = slowestLikelyBuffering
      ? SYNC_WAIT_THRESHOLD
      : (SYNC_WAIT_THRESHOLD + SYNC_NON_BUFFERING_EXTRA_GAP);
    if (gap < activationThreshold) {
      room.syncWait.candidateUid = null;
      room.syncWait.candidateSince = 0;
      return;
    }

    if (room.syncWait.candidateUid !== slowest.uid) {
      room.syncWait.candidateUid = slowest.uid;
      room.syncWait.candidateSince = now;
      return;
    }
    if ((now - room.syncWait.candidateSince) < SYNC_WAIT_GRACE_MS) return;

    room.syncWait.active = true;
    room.syncWait.waitingForUid = slowest.uid;
    room.syncWait.waitingForUsername = slowest.username || "friend";
    room.syncWait.pausedUids.clear();
    room.syncWait.resumeSince = 0;
  }

  const waitingUid = room.syncWait.waitingForUid;
  const waitingMember = members.find((member) => member.uid === waitingUid);
  if (!waitingMember) {
    clearSyncWait(roomCode);
    return;
  }

  const waitingForUsername = waitingMember.username || room.syncWait.waitingForUsername || "friend";
  room.syncWait.waitingForUsername = waitingForUsername;

  // The slowest member becomes the pacing anchor; everyone sufficiently ahead
  // gets a force-pause until the gap closes again.
  let maxGapFromWaiting = 0;
  const shouldBePaused = new Set();
  const pauseThreshold = room.syncWait.active ? SYNC_RESUME_THRESHOLD : SYNC_WAIT_THRESHOLD;
  members.forEach((member) => {
    if (member.uid === waitingUid) return;
    const memberGap = Math.max(0, member.time - waitingMember.time);
    maxGapFromWaiting = Math.max(maxGapFromWaiting, memberGap);
    if (memberGap >= pauseThreshold) {
      shouldBePaused.add(member.uid);
    }
  });

  [...room.syncWait.pausedUids].forEach((pausedUid) => {
    if (shouldBePaused.has(pausedUid)) return;
    const pausedUser = room.users.get(pausedUid);
    if (pausedUser) {
      emitToRoomUserSockets(pausedUser, "resume_sync_wait", {
        waitForUid: waitingUid,
        waitForUsername: waitingForUsername,
      });
    }
    room.syncWait.pausedUids.delete(pausedUid);
  });

  shouldBePaused.forEach((pausedUid) => {
    if (room.syncWait.pausedUids.has(pausedUid)) return;
    const pausedUser = room.users.get(pausedUid);
    if (pausedUser) {
      emitToRoomUserSockets(pausedUser, "force_sync_wait", {
        waitForUid: waitingUid,
        waitForUsername: waitingForUsername,
      });
      room.syncWait.pausedUids.add(pausedUid);
    }
  });

  io.to(roomCode).emit("sync_waiting", {
    waitForUid: waitingUid,
    waitForUsername: waitingForUsername,
    gap: Number(maxGapFromWaiting.toFixed(2)),
  });

  if (maxGapFromWaiting <= SYNC_RESUME_THRESHOLD) {
    if (!room.syncWait.resumeSince) room.syncWait.resumeSince = now;
    if ((now - room.syncWait.resumeSince) >= SYNC_RESUME_GRACE_MS) {
      clearSyncWait(roomCode);
    }
    return;
  }
  room.syncWait.resumeSince = 0;
}

async function recordOverlapForLeavingUser(room, leavingUid, roomCode) {
  if (typeof addMemoryEvent !== "function") return;
  const leftAt = Date.now();
  const leavingJoinedAt = room.joinedAtByUid.get(leavingUid);
  if (!leavingJoinedAt) return;

  const tasks = [];
  room.joinedAtByUid.forEach((otherJoinedAt, otherUid) => {
    if (otherUid === leavingUid) return;
    if (!room.users.has(otherUid)) return;

    const overlapMs = leftAt - Math.max(leavingJoinedAt, otherJoinedAt);
    const overlapSeconds = Math.floor(overlapMs / 1000);
    if (overlapSeconds >= WATCH_MEMORY_MIN_SECONDS) {
      tasks.push(addMemoryEvent(leavingUid, otherUid, overlapSeconds, roomCode));
    }
  });

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

setInterval(() => {
  // Heartbeats keep long-running sessions converged even if a client misses a
  // user-triggered play/pause/seek event.
  rooms.forEach((room, roomCode) => {
    if (!room || room.users.size === 0 || room.sessionMode === "music") return;
    room.videoState = resolveVideoState(room.videoState);
    io.to(roomCode).emit("sync_state", { videoState: room.videoState, serverTime: Date.now() / 1000 });
  });
}, SYNC_HEARTBEAT_MS);

setInterval(() => {
  pruneExpiredDocumentUploads();
}, Math.max(60000, Math.floor(DOCUMENT_UPLOAD_TTL_MS / 6))).unref?.();

// ─── Socket Auth ──────────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication token missing"));

    const decoded = await admin.auth().verifyIdToken(token);
    const identity = {
      uid: decoded.uid,
      name: decoded.name || decoded.email || "Anonymous",
      email: decoded.email || "",
      phoneNumber: decoded.phone_number || "",
      photoURL: decoded.picture || "",
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
      photoURL: profile.photoURL || identity.photoURL || "",
      email: profile.email || identity.email,
    };

    return next();
  } catch (err) {
    error("Token verification failed:", err.message);
    return next(new Error("Authentication failed"));
  }
});

// ─── Socket Handlers ──────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  const { uid, name, username, photoURL } = socket.user;
  markOnline(uid, socket.id);
  touchLastSeen(uid, { mongoConnected, UserProfileModel, memoryStore });

  log(`[connect] uid=${uid} socket=${socket.id}`);

  function shouldDropSocketEvent(eventType) {
    // Socket rate limiting is per-socket and per-event so rapid chat spam does
    // not block unrelated events like reconnect or playback sync.
    return isSocketEventRateLimited(socket.id, eventType);
  }

  socket.on("create_room", async ({ roomType, sessionMode, maxParticipants, moodTag, contentUrl, contentType } = {}, ack) => {
    if (shouldDropSocketEvent("create_room")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    try {
      const roomCode = generateCode();
      const normalizedRoomType = normalizeRoomType(roomType);
      const normalizedSessionMode = normalizeSessionMode(sessionMode);
      // Normalize source metadata once up front so room creation and later sync
      // logic agree on the exact media/session mode values.
      const normalizedInitialMetadata = normalizeMetadataForSessionEngine(normalizedSessionMode, {
        sourceType: contentType || "unknown",
        contentUrl: contentUrl || "",
      });
      const normalizedMaxParticipants = Math.max(
        2,
        Math.min(10, Number(maxParticipants) || (normalizedRoomType === "duo" ? 2 : MAX_ROOM_USERS))
      );
      const room = makeRoom(roomCode, {
        roomType: normalizedRoomType,
        sessionMode: normalizedSessionMode,
        moodTag: sanitizeRoomMoodTag(moodTag || ""),
        createdBy: uid,
        maxParticipants: normalizedMaxParticipants,
        contentUrl: normalizedInitialMetadata.contentUrl,
        contentType: normalizedInitialMetadata.sourceType,
      });
      if (room.contentUrl) {
        room.videoMetadata = {
          videoName: "",
          duration: 0,
          sourceType: room.contentType,
          fileFingerprint: "",
          contentUrl: room.contentUrl,
          updatedBy: uid,
          updatedAt: Date.now(),
        };
      }
      scheduleExpiry(room);

      upsertRoomUser(room, { uid, name, username, photoURL }, socket.id);
      room.joinedAtByUid.set(uid, Date.now());
      rooms.set(roomCode, room);
      addRoomHistory(room, {
        type: "room_created",
        uid,
        payload: {
          roomType: room.roomType,
          sessionMode: room.sessionMode,
          sessionEngineId: room.sessionEngineId,
          moodTag: room.moodTag || "",
          hasContentUrl: !!room.contentUrl,
          contentType: room.contentType,
        },
      });

      socket.join(roomCode);
      socket.currentRoom = roomCode;

      // Persistence is best-effort here: the live room should still exist even
      // if one analytics/history write fails.
      await Promise.allSettled([
        upsertRoomMetadata({
          roomCode,
          roomType: room.roomType,
          sessionMode: room.sessionMode,
          moodTag: room.moodTag || "",
          createdBy: uid,
          maxParticipants: room.maxParticipants,
          isActive: true,
          expiresAt: room.expiresAt,
          contentUrl: room.contentUrl,
          contentType: room.contentType,
          playbackStatus: room.playbackStatus,
          baseTime: room.baseTime,
          startedAt: room.startedAt,
        }),
        upsertRoomParticipant(roomCode, uid, {
          joinedAt: new Date(),
          isActive: true,
          role: "member",
        }),
        logActivity({
          uid,
          roomCode,
          type: "room_created",
          payload: {
            roomType: room.roomType,
            sessionMode: room.sessionMode,
            sessionEngineId: room.sessionEngineId,
            moodTag: room.moodTag || "",
            maxParticipants: room.maxParticipants,
            hasContentUrl: !!room.contentUrl,
            contentType: room.contentType,
          },
        }),
      ]);

      const musicState = buildRoomMusicStatePayload(room);
      socket.emit("room_joined", {
        roomCode,
        userCount: 1,
        users: getUserList(room),
        videoState: room.videoState,
        audioState: musicState.audioState,
        mediaType: musicState.mediaType,
        mediaMeta: musicState.mediaMeta,
        readingPage: room.readingState?.page || 1,
        readingState: getRoomReadingStatePayload(room),
        document: getRoomDocumentPayload(room),
        roomType: room.roomType,
        sessionMode: room.sessionMode,
        sessionEngineId: room.sessionEngineId,
        moodTag: room.moodTag || "",
        maxParticipants: room.maxParticipants,
        videoMetadata: room.videoMetadata,
        contentUrl: room.contentUrl || "",
        contentType: room.contentType || "unknown",
        createdBy: room.createdBy || "",
        messages: [],
      });
      socket.emit("initial_state", buildReadingInitialStatePayload(room));
      if (typeof ack === "function") ack({ ok: true, roomCode });

      io.to(roomCode).emit("user_count_update", { count: 1, users: getUserList(room) });
      log(`[create_room] ${roomCode} uid=${uid}`);
    } catch (err) {
      error("[create_room]", err);
      socket.emit("error", { message: "Failed to create room" });
      if (typeof ack === "function") ack({ ok: false, error: "Failed to create room" });
    }
  });

  socket.on("join_room", ({ roomCode } = {}, ack) => {
    if (shouldDropSocketEvent("join_room")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    try {
      if (typeof roomCode !== "string") {
        socket.emit("error", { message: "Invalid room code" });
        if (typeof ack === "function") ack({ ok: false, error: "Invalid room code" });
        return;
      }

      const code = roomCode.trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        socket.emit("error", { message: "Room not found or expired" });
        if (typeof ack === "function") ack({ ok: false, error: "Room not found or expired" });
        return;
      }
      if (room.users.size >= room.maxParticipants && !room.users.has(uid)) {
        socket.emit("error", { message: `Room is full (max ${room.maxParticipants})` });
        if (typeof ack === "function") ack({ ok: false, error: `Room is full (max ${room.maxParticipants})` });
        return;
      }

      clearPendingRoomUserDisconnect(code, uid);
      const joinState = upsertRoomUser(room, { uid, name, username, photoURL }, socket.id);
      const { isRejoin, hadActiveSocketsBefore } = joinState;
      if (!room.joinedAtByUid.has(uid)) {
        room.joinedAtByUid.set(uid, Date.now());
      }

      socket.join(code);
      socket.currentRoom = code;

      const musicState = buildRoomMusicStatePayload(room);
      socket.emit("room_joined", {
        roomCode: code,
        userCount: room.users.size,
        users: getUserList(room),
        videoState: { ...room.videoState },
        audioState: musicState.audioState,
        mediaType: musicState.mediaType,
        mediaMeta: musicState.mediaMeta,
        readingPage: room.readingState?.page || 1,
        readingState: getRoomReadingStatePayload(room),
        document: getRoomDocumentPayload(room),
        messages: room.messages.slice(-100),
        roomType: room.roomType,
        sessionMode: room.sessionMode || "watch",
        sessionEngineId: room.sessionEngineId || resolveSessionEngine(room.sessionMode).id,
        moodTag: room.moodTag || "",
        maxParticipants: room.maxParticipants,
        videoMetadata: room.videoMetadata || null,
        contentUrl: room.contentUrl || "",
        contentType: room.contentType || "unknown",
        createdBy: room.createdBy || "",
        isRejoin,
      });
      socket.emit("initial_state", buildReadingInitialStatePayload(room));
      if (typeof ack === "function") ack({ ok: true, roomCode: code });

      if (!isRejoin) {
        socket.to(code).emit("user_joined", { uid, name, username, photoURL });
        addRoomHistory(room, { type: "user_joined", uid, payload: { username } });
      } else if (!hadActiveSocketsBefore) {
        socket.to(code).emit("user_joined", { uid, name, username, photoURL });
        addRoomHistory(room, { type: "user_rejoined", uid, payload: { username } });
      } else {
        addRoomHistory(room, { type: "user_rejoined", uid, payload: { username } });
      }

      // Rejoins update presence immediately and backfill persistence in the
      // background so reconnects feel instant to the user.
      Promise.allSettled([
        upsertRoomParticipant(code, uid, {
          joinedAt: new Date(),
          isActive: true,
          role: "member",
          leftAt: null,
        }),
        touchRoomActivity(code),
        logActivity({
          uid,
          roomCode: code,
          type: isRejoin ? "room_rejoined" : "room_joined",
          payload: {
            roomType: room.roomType,
            sessionMode: room.sessionMode || "watch",
            sessionEngineId: room.sessionEngineId || resolveSessionEngine(room.sessionMode).id,
            moodTag: room.moodTag || "",
            hasContentUrl: !!room.contentUrl,
            contentType: room.contentType || "unknown",
          },
        }),
      ]).catch(() => {});

      io.to(code).emit("user_count_update", {
        count: room.users.size,
        users: getUserList(room),
      });

      log(`[join_room] ${code} uid=${uid} rejoin=${isRejoin}`);
    } catch (err) {
      error("[join_room]", err);
      socket.emit("error", { message: "Failed to join room" });
      if (typeof ack === "function") ack({ ok: false, error: "Failed to join room" });
    }
  });

  socket.on("upload_document", ({ roomCode, fileUrl, fileName, fileSize, mimeType, totalPages } = {}, ack) => {
    if (shouldDropSocketEvent("upload_document")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }

    try {
      const room = rooms.get(String(roomCode || "").trim().toUpperCase());
      if (!room || !room.users.has(uid)) {
        if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
        return;
      }
      if (room.sessionMode !== "reading") {
        if (typeof ack === "function") ack({ ok: false, error: "Document sync is only available in co-reading rooms" });
        return;
      }
      if (room.createdBy && room.createdBy !== uid) {
        if (typeof ack === "function") ack({ ok: false, error: "Only the host can upload a PDF" });
        return;
      }

      const document = normalizeRoomDocumentPayload({
        fileUrl,
        fileName,
        fileSize,
        mimeType,
        totalPages,
      });

      // In reading rooms the host's uploaded document becomes the canonical
      // room source, so page state and metadata are reset together here.
      room.document = {
        ...document,
        uploadedBy: uid,
        updatedAt: Date.now(),
      };
      room.readingState = {
        page: 1,
        totalPages: document.totalPages,
        updatedAt: Date.now(),
        updatedBy: uid,
      };
      room.readingMutationLockUntil = 0;
      room.contentUrl = document.fileUrl;
      room.contentType = "pdf";
      room.videoMetadata = {
        videoName: document.fileName,
        duration: 0,
        sourceType: "pdf",
        fileFingerprint: document.signature,
        contentUrl: document.fileUrl,
        updatedBy: uid,
        updatedAt: Date.now(),
      };

      addRoomHistory(room, {
        type: "document_uploaded",
        uid,
        payload: {
          fileName: document.fileName,
          fileSize: document.fileSize,
          signature: document.signature,
          totalPages: document.totalPages,
        },
      });

      touchRoomActivity(room.roomCode).catch(() => {});
      updateRoomContentState(room.roomCode, {
        contentUrl: document.fileUrl,
        contentType: "pdf",
      }).catch(() => {});
      saveVideoSessionMetadata({
        roomCode: room.roomCode,
        videoName: document.fileName,
        duration: 0,
        sourceType: "pdf",
        fileFingerprint: document.signature,
        contentUrl: document.fileUrl,
        updatedBy: uid,
      }).catch(() => {});
      logActivity({
        uid,
        roomCode: room.roomCode,
        type: "document_uploaded",
        payload: {
          fileName: document.fileName,
          fileSize: document.fileSize,
          signature: document.signature,
          totalPages: document.totalPages,
        },
      }).catch(() => {});

      const readingState = getRoomReadingStatePayload(room);
      const documentPayload = getRoomDocumentPayload(room);
      io.to(room.roomCode).emit("document_ready", {
        document: documentPayload,
        fileUrl: documentPayload?.fileUrl || "",
        signature: documentPayload?.signature || "",
        page: readingState.page,
        totalPages: readingState.totalPages,
        updatedBy: uid,
        username,
      });
      io.to(room.roomCode).emit("sync_page", {
        page: readingState.page,
        totalPages: readingState.totalPages,
        updatedBy: uid,
        username,
        serverTime: Date.now(),
      });
      io.to(room.roomCode).emit("initial_state", buildReadingInitialStatePayload(room));

      if (typeof ack === "function") {
        ack({
          ok: true,
          document: documentPayload,
          readingState,
        });
      }
    } catch (error) {
      if (typeof ack === "function") ack({ ok: false, error: error.message || "Could not share the PDF" });
    }
  });

  socket.on("sync_state", ({ roomCode, readingState, document } = {}, ack) => {
    if (shouldDropSocketEvent("sync_state_write")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }

    const room = rooms.get(String(roomCode || "").trim().toUpperCase());
    if (!room || !room.users.has(uid) || room.sessionMode !== "reading" || !room.document?.fileUrl) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not ready for co-reading sync" });
      return;
    }
    if (room.createdBy && room.createdBy !== uid) {
      if (typeof ack === "function") ack({ ok: false, error: "Only the host can sync PDF state" });
      return;
    }

    const incomingSignature = String(document?.signature || readingState?.signature || "").trim();
    if (incomingSignature && incomingSignature !== room.document.signature) {
      if (typeof ack === "function") ack({ ok: false, error: "Document mismatch" });
      return;
    }

    let changed = false;
    const nextTotalPages = normalizeReadingTotalPages(readingState?.totalPages || document?.totalPages || 0);
    if (nextTotalPages > 0 && nextTotalPages !== normalizeReadingTotalPages(room.readingState?.totalPages || 0)) {
      room.readingState.totalPages = nextTotalPages;
      room.document.totalPages = nextTotalPages;
      changed = true;
    }

    if (readingState?.page != null) {
      const nextPage = clampReadingPage(readingState.page, room.readingState.totalPages || room.document.totalPages || 0);
      if (nextPage !== clampReadingPage(room.readingState.page, room.readingState.totalPages || room.document.totalPages || 0)) {
        room.readingState.page = nextPage;
        room.readingState.updatedAt = Date.now();
        room.readingState.updatedBy = uid;
        changed = true;
      }
    }

    if (changed) {
      const payload = buildReadingInitialStatePayload(room);
      io.to(room.roomCode).emit("initial_state", payload);
    }

    if (typeof ack === "function") {
      ack({
        ok: true,
        changed,
        readingState: getRoomReadingStatePayload(room),
        document: getRoomDocumentPayload(room),
      });
    }
  });

  socket.on("request_page_change", ({ roomCode, page } = {}, ack) => {
    if (shouldDropSocketEvent("request_page_change")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }

    const room = rooms.get(String(roomCode || "").trim().toUpperCase());
    if (!room || !room.users.has(uid)) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
      return;
    }
    if (room.sessionMode !== "reading") {
      if (typeof ack === "function") ack({ ok: false, error: "Page sync is only available in co-reading rooms" });
      return;
    }
    if (room.createdBy && room.createdBy !== uid) {
      if (typeof ack === "function") ack({ ok: false, error: "Only the host can change pages" });
      return;
    }
    if (!room.document?.fileUrl) {
      if (typeof ack === "function") ack({ ok: false, error: "Upload a PDF before changing pages" });
      return;
    }

    const now = Date.now();
    // Rapid repeated page flips are collapsed by a tiny mutation window so all
    // clients observe one coherent page change at a time.
    if (room.readingMutationLockUntil && now < room.readingMutationLockUntil) {
      if (typeof ack === "function") ack({ ok: false, error: "Page changes are happening too quickly" });
      return;
    }

    const nextPage = clampReadingPage(page, room.readingState.totalPages || room.document.totalPages || 0);
    const currentPage = clampReadingPage(room.readingState.page, room.readingState.totalPages || room.document.totalPages || 0);
    room.readingMutationLockUntil = now + READING_PAGE_LOCK_MS;

    if (nextPage !== currentPage) {
      room.readingState = {
        page: nextPage,
        totalPages: normalizeReadingTotalPages(room.readingState.totalPages || room.document.totalPages || 0),
        updatedAt: now,
        updatedBy: uid,
      };

      addRoomHistory(room, {
        type: "reading_page",
        uid,
        payload: { page: nextPage, totalPages: room.readingState.totalPages || 0 },
      });
      touchRoomActivity(room.roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode: room.roomCode,
        type: "reading_page_changed",
        payload: { page: nextPage, totalPages: room.readingState.totalPages || 0 },
      }).catch(() => {});

      io.to(room.roomCode).emit("sync_page", {
        page: nextPage,
        totalPages: room.readingState.totalPages || 0,
        updatedBy: uid,
        username,
        serverTime: now,
      });
      io.to(room.roomCode).emit("reading_page_update", {
        page: nextPage,
        totalPages: room.readingState.totalPages || 0,
        updatedBy: uid,
        username,
      });
    }

    if (typeof ack === "function") {
      ack({
        ok: true,
        page: nextPage,
        totalPages: room.readingState.totalPages || 0,
      });
    }
  });

  socket.on("request_play", ({ roomCode, currentTime, fileSignature } = {}, ack) => {
    if (shouldDropSocketEvent("request_play")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
      return;
    }
    if (room.sessionMode === "music") {
      // Local audio cannot be synchronized safely unless everyone loaded the
      // same file, so music control checks the shared file signature first.
      const validation = validateMusicControlRequest(room, fileSignature);
      if (!validation.ok) {
        socket.emit("error", { message: validation.error });
        if (typeof ack === "function") ack({ ok: false, error: validation.error });
        return;
      }
      if (!acquireAudioMutationLock(room)) {
        if (typeof ack === "function") ack({ ok: false, error: "Another playback change is already in progress" });
        return;
      }
      const nowMs = Date.now();
      if (room.audioState.status === "playing" && (nowMs - Number(room.lastAudioActionAt || 0)) < AUDIO_TOGGLE_DEBOUNCE_MS) {
        if (typeof ack === "function") ack({ ok: true, ignored: true });
        return;
      }

      // Music playback is scheduled slightly in the future so every client can
      // line up their local clock before the shared "play" moment arrives.
      const time = clampTime(currentTime ?? resolveRoomAudioPosition(room, nowMs));
      room.audioState = {
        status: "playing",
        startTime: time,
        serverTime: nowMs + AUDIO_SCHEDULE_LEAD_MS,
        updatedAt: nowMs,
        playbackRate: 1,
        updatedBy: uid,
      };
      room.lastAudioActionAt = nowMs;
      room.playbackStatus = "playing";
      room.baseTime = time;
      room.startedAt = room.startedAt || new Date();
      addRoomHistory(room, {
        type: "music_play",
        uid,
        payload: {
          currentTime: time,
          mediaType: room.mediaType,
          hasUrl: !!room.mediaMeta?.url,
          hasSignature: !!room.mediaMeta?.fileSignature,
        },
      });
      touchRoomActivity(roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "room_music_play",
        payload: { currentTime: Number(time.toFixed(3)), sessionEngineId: "MusicEngine" },
      }).catch(() => {});
      broadcastRoomAudioSync(room, { action: "play", triggeredBy: name });
      if (typeof ack === "function") ack({ ok: true, audioState: buildRoomMusicStatePayload(room).audioState });
      return;
    }
    const engine = resolveSessionEngine(room.sessionMode);
    if (!engine.allowPlayback) return;

    clearSyncWait(roomCode);
    // Non-music modes share one authoritative video state; a new play request
    // resets any temporary wait-mode and broadcasts a fresh playback baseline.
    const time = clampTime(currentTime ?? room.videoState.currentTime);
    const nowSec = Date.now() / 1000;
    const scheduledStartAt = getScheduledVideoStartAt(room, true, nowSec);
    room.videoState = {
      currentTime: time,
      isPlaying: true,
      playbackRate: room.videoState.playbackRate,
      lastUpdate: nowSec,
      scheduledStartAt,
    };
    room.playbackStatus = "playing";
    room.baseTime = time;
    room.startedAt = room.startedAt || new Date();
    addRoomHistory(room, { type: "play", uid, payload: { currentTime: time } });
    touchRoomActivity(roomCode).catch(() => {});
    logActivity({
      uid,
      roomCode,
      type: "room_play",
      payload: { currentTime: Number(time.toFixed(2)), sessionEngineId: engine.id },
    }).catch(() => {});
    updateRoomPlaybackState(roomCode, {
      playbackStatus: "playing",
      baseTime: time,
      startedAt: room.startedAt,
    }).catch(() => {});

    io.to(roomCode).emit("sync_state", { videoState: room.videoState, triggeredBy: name, serverTime: Date.now() / 1000 });
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("request_pause", ({ roomCode, currentTime, fileSignature } = {}, ack) => {
    if (shouldDropSocketEvent("request_pause")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
      return;
    }
    if (room.sessionMode === "music") {
      const validation = validateMusicControlRequest(room, fileSignature);
      if (!validation.ok) {
        socket.emit("error", { message: validation.error });
        if (typeof ack === "function") ack({ ok: false, error: validation.error });
        return;
      }
      if (!acquireAudioMutationLock(room)) {
        if (typeof ack === "function") ack({ ok: false, error: "Another playback change is already in progress" });
        return;
      }
      const nowMs = Date.now();
      if ((nowMs - Number(room.lastAudioActionAt || 0)) < AUDIO_TOGGLE_DEBOUNCE_MS && room.audioState.status === "paused") {
        if (typeof ack === "function") ack({ ok: true, ignored: true });
        return;
      }

      // Pause snapshots the exact resolved server-side position so later resume
      // starts from the same timeline point on every participant's device.
      const pausedTime = clampTime(
        currentTime ?? (room.audioState.status === "playing" ? resolveRoomAudioPosition(room, nowMs) : room.audioState.startTime)
      );
      room.audioState = {
        status: "paused",
        startTime: pausedTime,
        serverTime: nowMs,
        updatedAt: nowMs,
        playbackRate: 1,
        updatedBy: uid,
      };
      room.lastAudioActionAt = nowMs;
      room.playbackStatus = "paused";
      room.baseTime = pausedTime;
      addRoomHistory(room, { type: "music_pause", uid, payload: { currentTime: pausedTime } });
      touchRoomActivity(roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "room_music_pause",
        payload: { currentTime: Number(pausedTime.toFixed(3)), sessionEngineId: "MusicEngine" },
      }).catch(() => {});
      broadcastRoomAudioSync(room, { action: "pause", triggeredBy: name });
      if (typeof ack === "function") ack({ ok: true, audioState: buildRoomMusicStatePayload(room).audioState });
      return;
    }
    const engine = resolveSessionEngine(room.sessionMode);
    if (!engine.allowPlayback) return;

    clearSyncWait(roomCode);
    // For video modes, pause simply turns the current resolved time into the
    // new baseTime so future heartbeats/seeks start from a stable point.
    const time = clampTime(currentTime ?? room.videoState.currentTime);
    const nowSec = Date.now() / 1000;
    room.videoState = {
      currentTime: time,
      isPlaying: false,
      playbackRate: room.videoState.playbackRate,
      lastUpdate: nowSec,
      scheduledStartAt: 0,
    };
    room.playbackStatus = "paused";
    room.baseTime = time;
    addRoomHistory(room, { type: "pause", uid, payload: { currentTime: time } });
    touchRoomActivity(roomCode).catch(() => {});
    logActivity({
      uid,
      roomCode,
      type: "room_pause",
      payload: { currentTime: Number(time.toFixed(2)), sessionEngineId: engine.id },
    }).catch(() => {});
    updateRoomPlaybackState(roomCode, {
      playbackStatus: "paused",
      baseTime: time,
    }).catch(() => {});

    io.to(roomCode).emit("sync_state", { videoState: room.videoState, triggeredBy: name, serverTime: Date.now() / 1000 });
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("request_seek", ({ roomCode, currentTime, isPlaying, playbackRate, fileSignature } = {}, ack) => {
    if (shouldDropSocketEvent("request_seek")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
      return;
    }
    if (room.sessionMode === "music") {
      const validation = validateMusicControlRequest(room, fileSignature);
      if (!validation.ok) {
        socket.emit("error", { message: validation.error });
        if (typeof ack === "function") ack({ ok: false, error: validation.error });
        return;
      }
      if (!acquireAudioMutationLock(room)) {
        if (typeof ack === "function") ack({ ok: false, error: "Another playback change is already in progress" });
        return;
      }
      const nowMs = Date.now();
      // Music seek can also carry the desired playing/paused state so the host
      // can hard-sync everyone to one exact timestamp and status in one event.
      const time = clampTime(currentTime ?? resolveRoomAudioPosition(room, nowMs));
      const nextStatus = typeof isPlaying === "boolean" ? (isPlaying ? "playing" : "paused") : room.audioState.status;
      room.audioState = {
        status: nextStatus,
        startTime: time,
        serverTime: nextStatus === "playing" ? nowMs : nowMs,
        updatedAt: nowMs,
        playbackRate: (typeof playbackRate === "number" && playbackRate > 0 && playbackRate <= 4) ? playbackRate : 1,
        updatedBy: uid,
      };
      room.lastAudioActionAt = nowMs;
      room.playbackStatus = nextStatus;
      room.baseTime = time;
      room.startedAt = room.startedAt || new Date();
      addRoomHistory(room, {
        type: "music_seek",
        uid,
        payload: { currentTime: time, status: nextStatus },
      });
      touchRoomActivity(roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "room_music_seek",
        payload: { currentTime: Number(time.toFixed(3)), status: nextStatus, sessionEngineId: "MusicEngine" },
      }).catch(() => {});
      broadcastRoomAudioSync(room, {
        action: "seek",
        triggeredBy: name,
        hardSync: true,
      });
      if (typeof ack === "function") ack({ ok: true, audioState: buildRoomMusicStatePayload(room).audioState });
      return;
    }
    const engine = resolveSessionEngine(room.sessionMode);
    if (!engine.allowPlayback) return;

    clearSyncWait(roomCode);
    const time = clampTime(currentTime ?? room.videoState.currentTime);
    const rate = (typeof playbackRate === "number" && playbackRate > 0 && playbackRate <= 4)
      ? playbackRate
      : room.videoState.playbackRate;
    const nextIsPlaying = typeof isPlaying === "boolean" ? isPlaying : room.videoState.isPlaying;
    const nowSec = Date.now() / 1000;
    // YouTube-style sources may need a scheduled future start even after a seek,
    // so the recomputed state carries both the target time and a start marker.
    const scheduledStartAt = getScheduledVideoStartAt(room, nextIsPlaying, nowSec);

    room.videoState = {
      currentTime: time,
      isPlaying: nextIsPlaying,
      playbackRate: rate,
      lastUpdate: nowSec,
      scheduledStartAt,
    };
    room.playbackStatus = room.videoState.isPlaying ? "playing" : "paused";
    room.baseTime = time;
    room.startedAt = room.startedAt || new Date();
    addRoomHistory(room, {
      type: "seek",
      uid,
      payload: {
        currentTime: time,
        isPlaying: !!room.videoState.isPlaying,
        playbackRate: room.videoState.playbackRate,
        sessionEngineId: engine.id,
      },
    });
    touchRoomActivity(roomCode).catch(() => {});
    updateRoomPlaybackState(roomCode, {
      playbackStatus: room.videoState.isPlaying ? "playing" : "paused",
      baseTime: time,
      startedAt: room.startedAt,
    }).catch(() => {});

    io.to(roomCode).emit("sync_state", { videoState: room.videoState, triggeredBy: name, serverTime: Date.now() / 1000 });
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("reading_page_update", ({ roomCode, page } = {}) => {
    if (shouldDropSocketEvent("reading_page_update")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    if (room.sessionMode !== "reading") return;
    if (room.createdBy && room.createdBy !== uid) {
      socket.emit("error", { message: "Only the host can change pages in co-reading" });
      return;
    }
    if (!room.document?.fileUrl) {
      socket.emit("error", { message: "Upload a PDF before changing pages" });
      return;
    }

    const now = Date.now();
    if (room.readingMutationLockUntil && now < room.readingMutationLockUntil) return;

    const nextPage = clampReadingPage(page, room.readingState.totalPages || room.document.totalPages || 0);
    const currentPage = clampReadingPage(room.readingState.page, room.readingState.totalPages || room.document.totalPages || 0);
    if (nextPage === currentPage) return;

    // This fire-and-forget event mirrors the ack-based page-change endpoint so
    // viewers still converge even if the host updates page state from the UI directly.
    room.readingMutationLockUntil = now + READING_PAGE_LOCK_MS;
    room.readingState = {
      page: nextPage,
      totalPages: normalizeReadingTotalPages(room.readingState.totalPages || room.document.totalPages || 0),
      updatedAt: now,
      updatedBy: uid,
    };
    addRoomHistory(room, {
      type: "reading_page",
      uid,
      payload: { page: nextPage, totalPages: room.readingState.totalPages || 0 },
    });
    touchRoomActivity(roomCode).catch(() => {});

    io.to(roomCode).emit("sync_page", {
      page: nextPage,
      totalPages: room.readingState.totalPages || 0,
      updatedBy: uid,
      username,
      serverTime: now,
    });
    io.to(roomCode).emit("reading_page_update", {
      page: nextPage,
      totalPages: room.readingState.totalPages || 0,
      updatedBy: uid,
      username,
    });
  });

  socket.on("send_message", ({ roomCode, text, type, meta } = {}) => {
    if (shouldDropSocketEvent("send_message")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    const sanitized = sanitize(text);
    if (!sanitized) return;

    const senderUsername = room.users.get(uid)?.username || name;
    // Chat messages are normalized into one room-local shape that supports both
    // plain text and structured system/bookmark payloads.
    const msg = {
      id: `${uid}-${Date.now()}`,
      uid,
      senderName: name,
      senderUsername,
      photoURL,
      text: sanitized,
      type: type || "text",
      meta: meta == null ? null : sanitizeActivityPayload(meta),
      timestamp: Date.now(),
      reactions: {},
    };

    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    addRoomHistory(room, {
      type: "chat_message",
      uid,
      payload: {
        messageId: msg.id,
        kind: msg.type,
      },
    });
    archiveChatMessage(roomCode, msg).catch(() => {});
    touchRoomActivity(roomCode).catch(() => {});

    io.to(roomCode).emit("new_message", msg);
  });

  socket.on("react_message", ({ roomCode, messageId, emoji } = {}) => {
    if (shouldDropSocketEvent("react_message")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    if (!emoji || typeof emoji !== "string") return;

    const msg = room.messages.find((entry) => entry.id === messageId);
    if (!msg) return;

    const reactions = msg.reactions || {};
    let hadSame = false;
    // Reactions are stored as emoji -> [uids], but each user can only have one
    // active reaction per message, so toggling one removes any previous choice.
    Object.keys(reactions).forEach((key) => {
      const list = Array.isArray(reactions[key]) ? reactions[key] : [];
      const idx = list.indexOf(uid);
      if (idx !== -1) {
        if (key === emoji) hadSame = true;
        list.splice(idx, 1);
      }
      if (list.length === 0) {
        delete reactions[key];
      } else {
        reactions[key] = list;
      }
    });

    if (!hadSame) {
      if (!reactions[emoji]) reactions[emoji] = [];
      reactions[emoji].push(uid);
      const resolvedState = resolveVideoState(room.videoState);
      addRoomHistory(room, {
        type: "reaction",
        uid,
        payload: {
          messageId,
          emoji,
          currentTime: resolvedState.currentTime,
        },
      });
      touchRoomActivity(roomCode).catch(() => {});
      recordSessionReaction({
        roomCode,
        userUid: uid,
        messageId,
        timestamp: resolvedState.currentTime,
        reactionType: "reaction",
        emoji,
      }).catch(() => {});
    }

    msg.reactions = reactions;

    io.to(roomCode).emit("message_reaction_update", {
      messageId,
      reactions,
    });
  });

  socket.on("bookmark_seek", ({ roomCode, seekTime } = {}) => {
    if (shouldDropSocketEvent("bookmark_seek")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    const time = clampTime(seekTime);
    // Bookmark seek is a user-friendly wrapper around hard sync: it records the
    // moment as a reaction and immediately moves the room timeline there.
    if (room.sessionMode === "music") {
      room.audioState = {
        status: room.audioState?.status === "playing" ? "playing" : "paused",
        startTime: time,
        serverTime: Date.now(),
        updatedAt: Date.now(),
        playbackRate: 1,
        updatedBy: uid,
      };
      room.lastAudioActionAt = Date.now();
      room.baseTime = time;
      addRoomHistory(room, { type: "bookmark_seek", uid, payload: { currentTime: time, mode: "music" } });
      touchRoomActivity(roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "bookmark_seek",
        payload: { currentTime: Number(time.toFixed(2)), mode: "music" },
      }).catch(() => {});
      recordSessionReaction({
        roomCode,
        userUid: uid,
        timestamp: time,
        reactionType: "bookmark",
        emoji: "bookmark",
      }).catch(() => {});

      broadcastRoomAudioSync(room, {
        action: "seek",
        triggeredBy: `${name}'s bookmark`,
        hardSync: true,
      });
      return;
    }

    room.videoState = {
      ...room.videoState,
      currentTime: time,
      lastUpdate: Date.now() / 1000,
      scheduledStartAt: getScheduledVideoStartAt(room, room.videoState.isPlaying, Date.now() / 1000),
    };
    room.baseTime = time;
    addRoomHistory(room, { type: "bookmark_seek", uid, payload: { currentTime: time } });
    touchRoomActivity(roomCode).catch(() => {});
    logActivity({
      uid,
      roomCode,
      type: "bookmark_seek",
      payload: { currentTime: Number(time.toFixed(2)) },
    }).catch(() => {});
    updateRoomPlaybackState(roomCode, {
      playbackStatus: room.videoState.isPlaying ? "playing" : "paused",
      baseTime: time,
    }).catch(() => {});
    recordSessionReaction({
      roomCode,
      userUid: uid,
      timestamp: time,
      reactionType: "bookmark",
      emoji: "bookmark",
    }).catch(() => {});

    io.to(roomCode).emit("sync_state", {
      videoState: room.videoState,
      triggeredBy: `${name}'s bookmark`,
      serverTime: Date.now() / 1000,
    });
  });

  socket.on("video_metadata", ({ roomCode, videoName, duration, sourceType, fileFingerprint, contentUrl } = {}) => {
    if (shouldDropSocketEvent("video_metadata")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    if (room.sessionMode === "reading" && room.createdBy && room.createdBy !== uid) {
      socket.emit("error", { message: "Only the host can change the document in co-reading" });
      return;
    }

    const normalized = normalizeMetadataForSessionEngine(room.sessionMode, {
      videoName,
      duration,
      sourceType,
      fileFingerprint,
      contentUrl,
    });
    const metadata = {
      ...normalized,
      updatedBy: uid,
      updatedAt: Date.now(),
    };

    // Metadata changes update the room's current source-of-truth media identity;
    // later play/pause/seek events assume this source has already been agreed on.
    room.videoMetadata = metadata;
    room.contentType = metadata.sourceType;
    room.contentUrl = metadata.contentUrl;
    if (room.sessionMode === "music") {
      room.mediaType = resolveMusicMediaType(metadata.sourceType, metadata.contentUrl);
      room.mediaMeta = {
        fileSignature: String(metadata.fileFingerprint || ""),
        url: String(metadata.contentUrl || ""),
      };
      room.audioState = {
        status: "paused",
        startTime: 0,
        serverTime: Date.now(),
        updatedAt: Date.now(),
        playbackRate: 1,
        updatedBy: uid,
      };
    }
    if (room.sessionMode === "reading" && metadata.sourceType === "pdf" && metadata.contentUrl) {
      // In reading mode, selecting a PDF source also resets the room document
      // payload so page sync and source sync stay tightly coupled.
      room.document = {
        ...normalizeRoomDocumentPayload({
          fileUrl: metadata.contentUrl,
          fileName: metadata.videoName || deriveDocumentFileNameFromUrl(metadata.contentUrl) || "shared-document.pdf",
          fileSize: 0,
          mimeType: "application/pdf",
          totalPages: room.readingState?.totalPages || 0,
        }),
        uploadedBy: uid,
        updatedAt: Date.now(),
      };
      room.readingState = {
        page: 1,
        totalPages: room.readingState?.totalPages || 0,
        updatedAt: Date.now(),
        updatedBy: uid,
      };
    }
    addRoomHistory(room, {
      type: "video_metadata",
      uid,
      payload: {
        sessionEngineId: resolveSessionEngine(room.sessionMode).id,
        sourceType: metadata.sourceType,
        duration: metadata.duration,
        hasContentUrl: !!metadata.contentUrl,
      },
    });

    saveVideoSessionMetadata({
      roomCode,
      videoName: metadata.videoName,
      duration: metadata.duration,
      sourceType: metadata.sourceType,
      fileFingerprint: metadata.fileFingerprint,
      contentUrl: metadata.contentUrl,
      updatedBy: uid,
    }).catch(() => {});
    updateRoomContentState(roomCode, {
      contentUrl: metadata.contentUrl,
      contentType: metadata.sourceType,
    }).catch(() => {});

    touchRoomActivity(roomCode).catch(() => {});
    logActivity({
      uid,
      roomCode,
      type: "video_metadata_updated",
      payload: {
        sessionEngineId: resolveSessionEngine(room.sessionMode).id,
        sourceType: metadata.sourceType,
        duration: metadata.duration,
        hasContentUrl: !!metadata.contentUrl,
      },
    }).catch(() => {});

    socket.to(roomCode).emit("video_metadata_updated", {
      roomCode,
      metadata: {
        videoName: metadata.videoName,
        duration: metadata.duration,
        sourceType: metadata.sourceType,
        contentUrl: metadata.contentUrl,
        fileFingerprint: metadata.fileFingerprint,
      },
      updatedBy: uid,
    });
    if (room.sessionMode === "music") {
      broadcastRoomAudioSync(room, {
        action: "source_changed",
        triggeredBy: `${name} changed the track`,
        hardSync: true,
      });
    }
    if (room.sessionMode === "reading" && room.document?.fileUrl) {
      io.to(room.roomCode).emit("document_ready", {
        document: getRoomDocumentPayload(room),
        fileUrl: room.document.fileUrl,
        signature: room.document.signature,
        page: room.readingState?.page || 1,
        totalPages: room.readingState?.totalPages || 0,
        updatedBy: uid,
        username,
      });
      io.to(room.roomCode).emit("initial_state", buildReadingInitialStatePayload(room));
    }
  });

  socket.on("webrtc_offer", ({ roomCode, offer, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_offer")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_offer", { offer, fromUid: uid, fromName: name });
  });

  socket.on("webrtc_answer", ({ roomCode, answer, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_answer")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_answer", { answer, fromUid: uid });
  });

  socket.on("webrtc_ice_candidate", ({ roomCode, candidate, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_ice_candidate")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_ice_candidate", { candidate, fromUid: uid });
  });

  socket.on("call_joined", ({ roomCode } = {}) => {
    if (shouldDropSocketEvent("call_joined")) return;
    socket.to(roomCode).emit("peer_joined_call", { uid, name });
  });

  socket.on("call_left", ({ roomCode } = {}) => {
    if (shouldDropSocketEvent("call_left")) return;
    socket.to(roomCode).emit("peer_left_call", { uid });
  });

  socket.on("time_update", ({ roomCode, username: uname, time, bufferAhead, readyState, isBuffering } = {}) => {
    if (shouldDropSocketEvent("time_update")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    const rawBufferAhead = Number(bufferAhead);
    const rawReadyState = Number(readyState);
    // These per-user samples drive the server-side wait-mode heuristic that
    // pauses faster members when someone is buffering too far behind.
    room.memberTimes.set(uid, {
      username: uname,
      time: clampTime(time),
      updatedAt: Date.now(),
      bufferAhead: Number.isFinite(rawBufferAhead) ? Math.max(0, Math.min(120, rawBufferAhead)) : null,
      readyState: Number.isFinite(rawReadyState) ? Math.max(0, Math.min(4, Math.floor(rawReadyState))) : null,
      isBuffering: isBuffering === true,
    });

    socket.to(roomCode).emit("member_time_update", {
      uid,
      username: uname,
      time: clampTime(time),
    });

    handleSyncWait(roomCode);
  });

  socket.on("disconnect", (reason) => {
    log(`[disconnect] uid=${uid} reason=${reason}`);
    clearSocketEventRateLimits(socket.id);

    const stillOnline = markOffline(uid, socket.id);
    if (!stillOnline) {
      touchLastSeen(uid, { mongoConnected, UserProfileModel, memoryStore });
    }

    const roomCode = socket.currentRoom;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const { roomUser, activeSocketCount } = removeSocketFromRoomUser(room, uid, socket.id);
    if (!roomUser) return;
    if (activeSocketCount > 0) return;

    room.memberTimes.delete(uid);
    if (room.syncWait.pausedUids.has(uid) || room.syncWait.waitingForUid === uid) {
      handleSyncWait(roomCode);
    }

    addRoomHistory(room, { type: "user_offline", uid, payload: { reason } });
    logActivity({
      uid,
      roomCode,
      type: "room_user_offline",
      payload: { reason: String(reason || "") },
    }).catch(() => {});

    io.to(roomCode).emit("user_offline", { uid, name, username });

    const graceMs = 15000;
    schedulePendingRoomUserDisconnect(roomCode, uid, graceMs, async () => {
      const liveRoom = rooms.get(roomCode);
      if (!liveRoom) return;

      const liveUser = liveRoom.users.get(uid);
      if (!liveUser) return;
      if (getRoomUserSocketIds(liveUser).length > 0) return;

      try {
        await recordOverlapForLeavingUser(liveRoom, uid, roomCode);
      } catch (err) {
        error("[memory] overlap save failed:", err.message);
      }

      if (liveRoom.createdBy === uid && liveRoom.sessionMode !== "music") {
        liveRoom.videoState = {
          ...liveRoom.videoState,
          isPlaying: false,
          lastUpdate: Date.now() / 1000,
          scheduledStartAt: 0,
        };
        liveRoom.playbackStatus = "paused";
        liveRoom.baseTime = clampTime(liveRoom.videoState.currentTime);
        updateRoomPlaybackState(roomCode, {
          playbackStatus: "paused",
          baseTime: liveRoom.baseTime,
        }).catch(() => {});
        io.to(roomCode).emit("sync_state", {
          videoState: liveRoom.videoState,
          triggeredBy: "Host went offline",
          serverTime: Date.now() / 1000,
        });
      }

      liveRoom.users.delete(uid);
      liveRoom.memberTimes.delete(uid);
      liveRoom.joinedAtByUid.delete(uid);
      addRoomHistory(liveRoom, { type: "user_left", uid, payload: { reason } });
      markRoomParticipantLeft(roomCode, uid).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "room_user_left",
        payload: { graceMs },
      }).catch(() => {});

      io.to(roomCode).emit("peer_left_call", { uid });

      if (liveRoom.users.size === 0) {
        deleteIfEmpty(roomCode);
        return;
      }

      if (liveRoom.createdBy === uid) {
        const nextHostUid = pickNextRoomHostUid(liveRoom);
        if (nextHostUid) {
          liveRoom.createdBy = nextHostUid;
          updateRoomCreator(roomCode, nextHostUid).catch(() => {});
          const nextHostUser = liveRoom.users.get(nextHostUid);
          io.to(roomCode).emit("host_transferred", {
            roomCode,
            previousHostId: uid,
            hostId: nextHostUid,
            hostUser: nextHostUser
              ? {
                uid: nextHostUser.uid,
                name: nextHostUser.name,
                username: nextHostUser.username,
                photoURL: nextHostUser.photoURL,
              }
              : null,
          });
          if (liveRoom.sessionMode === "reading") {
            io.to(roomCode).emit("initial_state", buildReadingInitialStatePayload(liveRoom));
          }
        }
      }

      io.to(roomCode).emit("user_count_update", {
        count: liveRoom.users.size,
        users: getUserList(liveRoom),
      });
      io.to(roomCode).emit("user_left", { uid, name });
    });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initMongo();

  httpServer.listen(PORT, () => {
    log(`Lumiere server running on port ${PORT}`);
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

const shutdown = async () => {
  rooms.forEach((_, code) => expireRoom(code));

  if (mongoose && mongoConnected) {
    try {
      await mongoose.connection.close();
    } catch {
      // noop
    }
  }

  httpServer.close(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (err) => {
  return error("Unhandled rejection:", err);
});
