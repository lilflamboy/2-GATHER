/**
 * Lumiere Backend Server
 * - Realtime room sync + chat + calls
 * - Profile/Friends/Invite/Memories APIs
 * - MongoDB support with in-memory fallback
 */
"use strict";

require("dotenv").config();

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
} = require("./services/room.service.js");
const admin = require("./config/firebase.js");
const { requireHttpAuth } = require("./middleware/auth.js");
const { errorHandler } = require("./middleware/errorHandler.js");
const { setIo } = require("./sockets/socketHub.js");
const {
  rooms, pendingRoomUserDisconnects,
} = require("./sockets/roomStore.js");
const uploadsRouter = require("./routes/uploads.routes.js");
const profileRouter = require("./routes/profile.routes.js");
const friendsRouter = require("./routes/friends.routes.js");
const watchlistRouter = require("./routes/watchlist.routes.js");
const memoriesRouter = require("./routes/memories.routes.js");
const roomsRouter = require("./routes/rooms.routes.js");
const notificationsRouter = require("./routes/notifications.routes.js");
const insightsRouter = require("./routes/insights.routes.js");
const adminRouter = require("./routes/admin.routes.js");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const cors = require("cors");

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

function normalizePlaybackStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "playing" || raw === "paused" || raw === "idle") return raw;
  return "idle";
}

function clampSessionDuration(value) {
  const num = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(172800, num));
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

async function createWatchSession(payload = {}) {
  const normalized = normalizeWatchSessionRow(payload);
  if (!normalized.roomCode || normalized.participants.length === 0) {
    return null;
  }

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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
  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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

  if (getMongoConnected()) {
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
    mongoConnected: getMongoConnected(),
    inMemoryFallback: !getMongoConnected(),
  });
});

app.use("/api", uploadsRouter);
app.use("/api", profileRouter);
app.use("/api", friendsRouter);
app.use("/api", watchlistRouter);
app.use("/api", memoriesRouter);
app.use("/api", roomsRouter);
app.use("/api", notificationsRouter);
app.use("/api", insightsRouter);
app.use("/api", adminRouter);
app.use(errorHandler);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  pingTimeout: 20000,
  pingInterval: 10000,
});
setIo(io);

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
  touchLastSeen(uid, { mongoConnected: getMongoConnected(), UserProfileModel, memoryStore });

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
      touchLastSeen(uid, { mongoConnected: getMongoConnected(), UserProfileModel, memoryStore });
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

  if (getMongoConnected() && UserProfileModel?.db?.close) {
    try {
      await UserProfileModel.db.close();
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
