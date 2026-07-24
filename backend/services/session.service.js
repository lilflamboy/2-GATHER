/**
 * Tracks live and completed session data for the 2-GATHER backend.
 * Live video-session metadata, completed watch sessions, activity events,
 * and archived chat are stored separately because they serve different
 * lifecycles, query patterns, and retention needs.
 */
'use strict'

const {
  ActivityEventModel, VideoSessionModel,
  WatchSessionModel, ChatArchiveModel, RoomModel,
  getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const {
  clampTime, uniqueStrings,
  getProfileStoreCopy, pushBounded,
} =
  require('../utils/helpers.js')
const {
  normalizeRoomType, normalizeSessionMode,
  normalizeContentType,
} =
  require('../utils/normalize.js')
const {
  sanitize, sanitizeContentUrl,
  sanitizeActivityPayload, sanitizeRoomMoodTag,
  sanitizeSharedMemoryGenre,
} = require('../utils/sanitize.js')
const {
  ALLOWED_REACTION_TYPES,
  MAX_SESSION_HIGHLIGHTS,
  MAX_VIDEO_NAME_LENGTH,
  MAX_VIDEO_TIME,
} = require('../config/constants.js')
const { normalizeRelationshipType } =
  require('./relationship.service.js')

/**
 * Clamps a session duration into the supported range.
 * Session durations are stored in seconds and capped so malformed clients
 * cannot create negative or absurdly long records.
 * @param {number} value - The raw duration in seconds.
 * @returns {number} The bounded duration.
 */
function clampSessionDuration(value) {
  const num = Math.floor(Number(value) || 0)
  return Math.max(0, Math.min(172800, num))
}

/**
 * Normalizes a reaction type against the allowed reaction enum.
 * @param {string} value - The raw reaction type.
 * @param {string} [fallback='reaction'] - The fallback reaction type.
 * @returns {string} The normalized reaction type.
 */
function normalizeReactionType(value, fallback = 'reaction') {
  const raw = String(value || '').trim().toLowerCase()
  if (ALLOWED_REACTION_TYPES.includes(raw)) return raw
  return ALLOWED_REACTION_TYPES.includes(fallback) ? fallback : 'reaction'
}

/**
 * Normalizes a session highlight row generated from reactions.
 * Highlights keep the reaction timestamp, type, author, emoji, and creation
 * time so they can be embedded in completed watch-session records.
 * @param {object} [row={}] - The raw highlight-like object.
 * @returns {object} The normalized highlight row.
 */
function normalizeSessionHighlightRow(row = {}) {
  return {
    timestamp: clampTime(Number(row.timestamp) || 0),
    type: normalizeReactionType(row.type || row.reactionType || 'reaction'),
    userUid: String(row.userUid || ''),
    reactionType: normalizeReactionType(row.reactionType || row.type || 'reaction'),
    emoji: String(row.emoji || '').slice(0, 24),
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  }
}

/**
 * Normalizes a completed watch-session row.
 * The normalizer aligns room/session metadata, participants, highlights,
 * durations, and content fields into the canonical stored shape.
 * @param {object} [row={}] - The raw session row.
 * @returns {object} The normalized watch-session record.
 */
function normalizeWatchSessionRow(row = {}) {
  const participants = uniqueStrings(Array.isArray(row.participants) ? row.participants : [])
  const startedAt = row.startedAt ? new Date(row.startedAt) : new Date()
  const endedAt = row.endedAt ? new Date(row.endedAt) : new Date()
  // Highlights are normalized individually and capped so sessions stay compact.
  const highlights = (Array.isArray(row.highlights) ? row.highlights : [])
    .map((entry) => normalizeSessionHighlightRow(entry))
    .slice(0, MAX_SESSION_HIGHLIGHTS)
  return {
    id: String(row._id || row.id || ''),
    roomCode: String(row.roomCode || '').trim().toUpperCase().slice(0, 32),
    roomId: String(row.roomId || ''),
    roomType: normalizeRoomType(row.roomType),
    sessionMode: normalizeSessionMode(row.sessionMode || 'watch'),
    participants,
    relationshipId: String(row.relationshipId || ''),
    relationshipType: normalizeRelationshipType(row.relationshipType || 'group', 'group'),
    contentUrl: sanitizeContentUrl(row.contentUrl || ''),
    contentTitle: sanitize(String(row.contentTitle || '')).slice(0, MAX_VIDEO_NAME_LENGTH),
    contentType: normalizeContentType(row.contentType),
    genre: sanitizeSharedMemoryGenre(row.genre || ''),
    moodTag: sanitizeRoomMoodTag(row.moodTag || ''),
    duration: clampSessionDuration(row.duration),
    startedAt,
    endedAt,
    reactionsCount: Math.max(0, Math.floor(Number(row.reactionsCount) || 0)),
    highlights,
    createdBy: String(row.createdBy || ''),
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(),
  }
}

/**
 * Lists completed watch sessions for one user, optionally narrowed to a partner and year.
 * The MongoDB path uses direct query filters, while the memory path mirrors the
 * same participant and date-window logic against the fallback array.
 * @param {string} uid - The primary participant UID.
 * @param {object} [options={}] - Optional partner, year, and limit filters.
 * @returns {Promise<object[]>} Matching normalized watch sessions.
 */
async function listWatchSessionsForUser(uid, { partnerUid = '', limit = 40, year = null } = {}) {
  const selfUid = String(uid || '').trim()
  if (!selfUid) return []
  const partner = String(partnerUid || '').trim()
  const safeLimit = Math.max(1, Math.min(400, Number(limit) || 40))
  const queryYear = Number.isFinite(Number(year)) ? Math.floor(Number(year)) : null
  let rangeStart = null
  let rangeEnd = null
  if (queryYear && queryYear >= 2000 && queryYear <= 2200) {
    rangeStart = new Date(Date.UTC(queryYear, 0, 1, 0, 0, 0))
    rangeEnd = new Date(Date.UTC(queryYear + 1, 0, 1, 0, 0, 0))
  }

  // MongoDB handles the participant and date filters directly in the query.
  if (getMongoConnected()) {
    const query = partner
      ? { participants: { $all: [selfUid, partner] } }
      : { participants: selfUid }
    if (rangeStart && rangeEnd) {
      query.endedAt = { $gte: rangeStart, $lt: rangeEnd }
    }
    const rows = await WatchSessionModel.find(query)
      .sort({ endedAt: -1 })
      .limit(safeLimit)
      .lean()
    return rows.map((row) => normalizeWatchSessionRow(row))
  }

  // Memory mode applies the same filters and newest-first ordering in process.
  return memoryStore.watchSessions
    .filter((row) => {
      const participants = Array.isArray(row.participants) ? row.participants : []
      if (!participants.includes(selfUid)) return false
      if (partner && !participants.includes(partner)) return false
      if (rangeStart && rangeEnd) {
        const endedAt = row.endedAt ? new Date(row.endedAt).getTime() : 0
        if (endedAt < rangeStart.getTime() || endedAt >= rangeEnd.getTime()) return false
      }
      return true
    })
    .sort((a, b) => new Date(b.endedAt || b.createdAt || Date.now()).getTime() - new Date(a.endedAt || a.createdAt || Date.now()).getTime())
    .slice(0, safeLimit)
    .map((row) => normalizeWatchSessionRow(row))
}

/**
 * Lists completed watch sessions for a specific relationship pair.
 * This powers higher-level analytics like yearly insights and milestone checks.
 * @param {string} pairKey - The relationship pair key.
 * @param {object} [options={}] - Optional year and limit filters.
 * @returns {Promise<object[]>} Matching normalized watch sessions.
 */
async function listWatchSessionsForRelationship(pairKey, { year = null, limit = 500 } = {}) {
  const key = String(pairKey || '').trim()
  if (!key) return []
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500))
  const queryYear = Number.isFinite(Number(year)) ? Math.floor(Number(year)) : null
  let rangeStart = null
  let rangeEnd = null
  if (queryYear && queryYear >= 2000 && queryYear <= 2200) {
    rangeStart = new Date(Date.UTC(queryYear, 0, 1, 0, 0, 0))
    rangeEnd = new Date(Date.UTC(queryYear + 1, 0, 1, 0, 0, 0))
  }

  // Relationship-level lookups are direct on the stored relationship ID.
  if (getMongoConnected()) {
    const query = { relationshipId: key }
    if (rangeStart && rangeEnd) {
      query.endedAt = { $gte: rangeStart, $lt: rangeEnd }
    }
    const rows = await WatchSessionModel.find(query).sort({ endedAt: -1 }).limit(safeLimit).lean()
    return rows.map((row) => normalizeWatchSessionRow(row))
  }

  // The fallback path filters the in-memory session list by relationship ID and year window.
  return memoryStore.watchSessions
    .filter((row) => {
      if (String(row.relationshipId || '') !== key) return false
      if (rangeStart && rangeEnd) {
        const endedAt = row.endedAt ? new Date(row.endedAt).getTime() : 0
        if (endedAt < rangeStart.getTime() || endedAt >= rangeEnd.getTime()) return false
      }
      return true
    })
    .sort((a, b) => new Date(b.endedAt || b.createdAt || Date.now()).getTime() - new Date(a.endedAt || a.createdAt || Date.now()).getTime())
    .slice(0, safeLimit)
    .map((row) => normalizeWatchSessionRow(row))
}

/**
 * Appends an activity event for a user action.
 * Activity events power lightweight audit/history views and store a sanitized
 * payload object for context about the action.
 * @param {object} payload - The activity event payload.
 * @returns {Promise<void>} Nothing is returned.
 */
async function logActivity({ uid, type, roomCode = "", targetUid = "", payload = {} }) {
  if (!uid || !type) return
  const now = new Date()
  const normalized = {
    uid: String(uid),
    type: String(type).slice(0, 80),
    roomCode: String(roomCode || "").trim().toUpperCase().slice(0, 32),
    targetUid: String(targetUid || "").slice(0, 128),
    payload: sanitizeActivityPayload(payload),
    occurredAt: now,
  }

  // Activity events are best-effort writes, so failures are intentionally swallowed.
  if (getMongoConnected()) {
    await ActivityEventModel.create(normalized).catch(() => {})
    return
  }

  // Keep the fallback activity ledger bounded in memory.
  pushBounded(memoryStore.activityEvents, normalized, 4000)
}

/**
 * Updates a room's `lastActivityAt` timestamp.
 * This keeps idle-room expiry logic honest by marking rooms as active whenever
 * session or chat actions occur.
 * @param {string} roomCode - The room code to touch.
 * @returns {Promise<void>} Nothing is returned.
 */
async function touchRoomActivity(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase()
  if (!normalizedCode) return
  const now = new Date()

  // Persist the heartbeat in the room metadata collection when MongoDB is connected.
  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: { lastActivityAt: now } }
    ).catch(() => {})
    return
  }

  // Mirror the same activity touch in the in-memory room snapshot.
  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.lastActivityAt = now
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

/**
 * Saves live video-session metadata for the current room content.
 * The upsert tracks the current media title, duration, source type, file
 * fingerprint, updater, and content URL while keeping a stable start time.
 * @param {object} payload - The live session metadata payload.
 * @returns {Promise<object|null>} The stored live video-session row.
 */
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
  }
  if (!normalized.roomCode) return null

  // Upsert the live session row so room playback can resume from durable metadata.
  if (getMongoConnected()) {
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
    )
    return VideoSessionModel.findOne({ roomCode: normalized.roomCode }).lean()
  }

  // The fallback path keeps a single mutable live session per room in memory.
  const existing = memoryStore.videoSessions.get(normalized.roomCode)
  const next = {
    ...(existing || {}),
    ...normalized,
    startedAt: existing?.startedAt || new Date(),
    updatedAt: new Date(),
  }
  memoryStore.videoSessions.set(normalized.roomCode, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

/**
 * Archives a chat message outside the ephemeral room state.
 * Chat history is stored separately so room teardown does not erase the recent
 * message log and repeated writes dedupe on `messageId`.
 * @param {string} roomCode - The room the message belongs to.
 * @param {object} msg - The raw chat message payload.
 * @returns {Promise<void>} Nothing is returned.
 */
async function archiveChatMessage(roomCode, msg) {
  if (!roomCode || !msg?.id || !msg?.uid) return
  const payload = {
    roomCode: String(roomCode || "").trim().toUpperCase(),
    messageId: String(msg.id),
    uid: String(msg.uid),
    senderName: String(msg.senderName || ""),
    senderUsername: String(msg.senderUsername || ""),
    text: sanitize(String(msg.text || "")),
    type: String(msg.type || "text"),
    timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
  }

  // MongoDB uses messageId as the dedupe key so retries overwrite the same archived row.
  if (getMongoConnected()) {
    await ChatArchiveModel.updateOne(
      { messageId: payload.messageId },
      { $set: payload },
      { upsert: true }
    ).catch(() => {})
    return
  }

  // Memory mode keeps a bounded archive list for degraded operation.
  pushBounded(memoryStore.chatMessages, { ...payload }, 5000)
}

/**
 * Lists recent activity events for one user.
 * Results are sorted newest-first and capped to a small bounded window for UI use.
 * @param {string} uid - The user whose activity should be listed.
 * @param {number} [limit=40] - The maximum number of rows to return.
 * @returns {Promise<object[]>} Recent activity rows.
 */
async function listActivityForUser(uid, limit = 40) {
  const selfUid = String(uid || "").trim()
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 40))
  if (!selfUid) return []

  // Query the activity collection directly in MongoDB when available.
  if (getMongoConnected()) {
    return ActivityEventModel.find({ uid: selfUid }).sort({ occurredAt: -1 }).limit(safeLimit).lean()
  }

  // The memory fallback reconstructs the same newest-first slice from the ledger array.
  return memoryStore.activityEvents
    .filter((item) => item.uid === selfUid)
    .slice(-safeLimit)
    .reverse()
    .map((item) => getProfileStoreCopy(item))
}

/**
 * Loads the live video-session metadata for a room code.
 * This returns the current in-progress session row rather than a completed
 * watch-session record.
 * @param {string} roomCode - The room code to look up.
 * @returns {Promise<object|null>} The live video-session metadata or null.
 */
async function getVideoSessionByRoomCode(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase()
  if (!normalizedCode) return null

  if (getMongoConnected()) {
    return VideoSessionModel.findOne({ roomCode: normalizedCode }).lean()
  }

  const row = memoryStore.videoSessions.get(normalizedCode)
  return row ? getProfileStoreCopy(row) : null
}

module.exports = {
  normalizeReactionType,
  normalizeSessionHighlightRow,
  normalizeWatchSessionRow,
  logActivity,
  touchRoomActivity,
  saveVideoSessionMetadata,
  archiveChatMessage,
  listActivityForUser,
  listWatchSessionsForUser,
  listWatchSessionsForRelationship,
  getVideoSessionByRoomCode,
}
