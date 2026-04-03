/**
 * Manages persisted room metadata, room participation history, room analytics,
 * and completed session recording. This service complements the in-memory
 * realtime room state in `roomStore.js` by handling the durable data that must
 * survive beyond a live socket session.
 */
'use strict'

const {
  RoomModel, RoomParticipantModel, ActivityEventModel,
  ChatArchiveModel, WatchSessionModel, SessionReactionModel,
  VideoSessionModel, RelationshipModel, getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const {
  clampTime, uniqueStrings, getProfileStoreCopy, pushBounded,
} = require('../utils/helpers.js')
const {
  normalizeRoomType, normalizeSessionMode, normalizeContentType,
} = require('../utils/normalize.js')
const {
  sanitize, sanitizeContentUrl, sanitizeRoomMoodTag,
  sanitizeSharedMemoryGenre,
} = require('../utils/sanitize.js')
const {
  MAX_SESSION_REACTIONS, MAX_SESSION_HIGHLIGHTS,
  MAX_VIDEO_NAME_LENGTH, MAX_ROOM_USERS,
  ROOM_EXPIRY_MS, WATCH_MEMORY_MIN_SECONDS,
} = require('../config/constants.js')
const {
  getProfileByUid, saveProfile,
} = require('./profile.service.js')
const {
  normalizeRelationshipType, pairKeyFromUsers,
  getRelationshipRow,
} = require('./relationship.service.js')
const {
  normalizeReactionType, normalizeSessionHighlightRow,
  normalizeWatchSessionRow, listWatchSessionsForUser,
  listWatchSessionsForRelationship, getVideoSessionByRoomCode,
} = require('./session.service.js')
const {
  createSharedMemory,
} = require('./memory.service.js')
const {
  upsertMilestone, regenerateRelationshipInsight,
} = require('./insight.service.js')
const { rooms } =
  require('../sockets/roomStore.js')

/**
 * Loads persisted room metadata by room code.
 * @param {string} roomCode - The room code to look up.
 * @returns {Promise<object|null>} The stored room metadata or null when missing.
 */
async function getRoomMetadataByCode(roomCode) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return null

  // Prefer the durable room record when MongoDB is available.
  if (getMongoConnected()) {
    return RoomModel.findOne({ roomCode: normalizedCode }).lean()
  }

  // Otherwise return a defensive copy from the in-memory fallback store.
  const room = memoryStore.rooms.get(normalizedCode)
  return room ? getProfileStoreCopy(room) : null
}

/**
 * Lists historical participant rows for a room.
 * @param {string} roomCode - The room code to inspect.
 * @returns {Promise<object[]>} Participant rows ordered by join time.
 */
async function listRoomParticipantsByCode(roomCode) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return []

  // Persisted participant rows are queried oldest-first by join time.
  if (getMongoConnected()) {
    return RoomParticipantModel.find({ roomCode: normalizedCode }).sort({ joinedAt: 1 }).lean()
  }

  // Memory mode mirrors the same ordering over the fallback participant map.
  return [...memoryStore.roomParticipants.values()]
    .filter((row) => row.roomCode === normalizedCode)
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
    .map((row) => getProfileStoreCopy(row))
}

/**
 * Builds a room-history snapshot for an authorized viewer.
 * The snapshot combines room metadata, participant history, live video-session
 * metadata, recent activities, archived chat, and in-memory live history.
 * @param {string} roomCode - The room whose history is being requested.
 * @param {string} viewerUid - The authenticated viewer UID.
 * @returns {Promise<object>} The assembled room-history snapshot.
 */
async function getRoomHistorySnapshot(roomCode, viewerUid) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  const authUid = String(viewerUid || '').trim()
  if (!normalizedCode) {
    const error = new Error('roomCode is required')
    error.status = 400
    throw error
  }

  const liveRoom = rooms.get(normalizedCode)
  const participants = await listRoomParticipantsByCode(normalizedCode)
  const isLiveMember = !!(liveRoom && liveRoom.users.has(authUid))
  const wasParticipant = participants.some((row) => row.userId === authUid)
  // Access is limited to active members or users who have historical participation rows.
  if (!isLiveMember && !wasParticipant) {
    const error = new Error('You do not have access to this room history')
    error.status = 403
    throw error
  }

  const roomMeta = await getRoomMetadataByCode(normalizedCode)
  const videoSession = await getVideoSessionByRoomCode(normalizedCode)

  let activities = []
  let chat = []
  // Pull recent activity and chat from the primary datastore when available.
  if (getMongoConnected()) {
    ;[activities, chat] = await Promise.all([
      ActivityEventModel.find({ roomCode: normalizedCode }).sort({ occurredAt: -1 }).limit(120).lean(),
      ChatArchiveModel.find({ roomCode: normalizedCode }).sort({ timestamp: -1 }).limit(120).lean(),
    ])
  } else {
    activities = memoryStore.activityEvents
      .filter((row) => row.roomCode === normalizedCode)
      .slice(-120)
      .reverse()
      .map((row) => ({ ...row }))
    chat = memoryStore.chatMessages
      .filter((row) => row.roomCode === normalizedCode)
      .slice(-120)
      .reverse()
      .map((row) => ({ ...row }))
  }

  // Live history is sourced directly from the in-memory room runtime.
  const liveHistory = liveRoom?.history
    ? [...liveRoom.history].slice(-120).reverse()
    : []

  return {
    room: roomMeta
      ? {
        roomCode: roomMeta.roomCode,
        roomType: roomMeta.roomType || 'friends',
        sessionMode: roomMeta.sessionMode || 'watch',
        moodTag: roomMeta.moodTag || '',
        isActive: !!roomMeta.isActive,
        createdBy: roomMeta.createdBy || '',
        createdAt: roomMeta.createdAt || null,
        expiresAt: roomMeta.expiresAt || null,
        closedAt: roomMeta.closedAt || null,
        contentUrl: roomMeta.contentUrl || '',
        contentType: roomMeta.contentType || 'unknown',
        permissions: roomMeta.permissions || { play: true, pause: true, seek: true, skip: true },
      }
      : {
        roomCode: normalizedCode,
        roomType: liveRoom?.roomType || 'friends',
        sessionMode: liveRoom?.sessionMode || 'watch',
        moodTag: liveRoom?.moodTag || '',
        isActive: !!liveRoom,
        contentUrl: liveRoom?.contentUrl || '',
        contentType: liveRoom?.contentType || 'unknown',
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
        videoName: videoSession.videoName || '',
        duration: videoSession.duration || 0,
        sourceType: videoSession.sourceType || 'unknown',
        totalWatchTime: videoSession.totalWatchTime || 0,
        startedAt: videoSession.startedAt || null,
        endedAt: videoSession.endedAt || null,
      }
      : null,
    activity: activities.map((item) => ({
      type: item.type,
      uid: item.uid || '',
      targetUid: item.targetUid || '',
      occurredAt: item.occurredAt || item.createdAt || new Date(),
    })),
    chat: chat.map((item) => ({
      messageId: item.messageId,
      uid: item.uid,
      senderUsername: item.senderUsername || '',
      text: item.text || '',
      type: item.type || 'text',
      timestamp: item.timestamp || item.createdAt || new Date(),
    })),
    liveHistory,
  }
}

/**
 * Normalizes playback status into the supported room-state enum.
 * @param {string} value - The raw playback status.
 * @returns {string} The normalized playback status.
 */
function normalizePlaybackStatus(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'playing' || raw === 'paused' || raw === 'idle') return raw
  return 'idle'
}

/**
 * Clamps a session duration into the supported storage range.
 * @param {number} value - The raw duration in seconds.
 * @returns {number} The bounded duration.
 */
function clampSessionDuration(value) {
  const num = Math.floor(Number(value) || 0)
  return Math.max(0, Math.min(172800, num))
}

/**
 * Converts a date-like value into a UTC day timestamp.
 * This lets streak comparisons ignore local time offsets and compare by whole day.
 * @param {Date|string|number} value - The date-like value to normalize.
 * @returns {number} The UTC midnight timestamp for that day, or 0 when invalid.
 */
function toUtcDayTimestamp(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 0
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/**
 * Computes the next rolling streak value from two session dates.
 * A same-day repeat keeps the current streak, a next-day session increments it,
 * and any larger gap resets the streak back to one.
 * @param {Date|string|number} previousDate - The earlier session date.
 * @param {Date|string|number} nextDate - The new session date being applied.
 * @param {number} [currentStreak=0] - The current stored streak count.
 * @returns {number} The updated streak count.
 */
function computeRollingStreak(previousDate, nextDate, currentStreak = 0) {
  const prevDay = toUtcDayTimestamp(previousDate)
  const nextDay = toUtcDayTimestamp(nextDate)
  if (!nextDay) return Math.max(0, Math.floor(Number(currentStreak) || 0))
  if (!prevDay) return 1
  const diffDays = Math.round((nextDay - prevDay) / 86400000)
  if (diffDays <= 0) return Math.max(1, Math.floor(Number(currentStreak) || 1))
  if (diffDays === 1) return Math.max(1, Math.floor(Number(currentStreak) || 1) + 1)
  return 1
}

/**
 * Buckets a date into a friendly time-of-day slot.
 * @param {Date|string|number} value - The date-like value to inspect.
 * @returns {string} The derived time-slot label.
 */
function timeSlotFromDate(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 'unknown'
  const hour = date.getHours()
  if (hour >= 22 || hour < 5) return 'late_night'
  if (hour >= 18) return 'evening'
  if (hour >= 12) return 'afternoon'
  return 'morning'
}

/**
 * Returns the most common labels from a counter map.
 * @param {Map<string, number>} counterMap - The label frequency map.
 * @param {number} [limit=5] - The number of labels to return.
 * @returns {string[]} The top labels ordered by count then alphabetically.
 */
function topLabelsFromCounter(counterMap, limit = 5) {
  return [...counterMap.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0]) // Stable tie-breaks keep analytics deterministic.
    })
    .slice(0, Math.max(1, limit))
    .map(([label]) => label)
}

/**
 * Normalizes a session-reaction row into the canonical analytics shape.
 * @param {object} [row={}] - The raw session reaction row.
 * @returns {object} The normalized reaction record.
 */
function normalizeSessionReactionRow(row = {}) {
  return {
    id: String(row._id || row.id || ''),
    sessionId: String(row.sessionId || ''),
    roomCode: String(row.roomCode || '').trim().toUpperCase().slice(0, 32),
    userUid: String(row.userUid || ''),
    messageId: String(row.messageId || '').slice(0, 120),
    timestamp: clampTime(Number(row.timestamp) || 0),
    reactionType: normalizeReactionType(row.reactionType || 'reaction'),
    emoji: String(row.emoji || '').slice(0, 24),
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  }
}

/**
 * Maps a room type to the higher-level relationship type used in analytics.
 * @param {string} roomType - The room type.
 * @returns {string} The derived relationship type.
 */
function relationshipTypeFromRoomType(roomType) {
  const normalizedRoomType = normalizeRoomType(roomType)
  if (normalizedRoomType === 'family') return 'family'
  if (normalizedRoomType === 'duo') return 'couple'
  return 'group'
}

/**
 * Builds a preference snapshot from historical sessions.
 * Favorite genres and active time slots are derived from the session history
 * and later stored back onto user and relationship analytics records.
 * @param {object[]} [rows=[]] - Historical watch-session rows.
 * @returns {object} Derived genre and time-slot preferences.
 */
function buildPreferenceSnapshotFromSessions(rows = []) {
  const genreCounter = new Map()
  const slotCounter = new Map()

  // Count genres and session times from the historical rows.
  rows.forEach((row) => {
    const genre = sanitizeSharedMemoryGenre(row.genre || '')
    if (genre) {
      genreCounter.set(genre, (genreCounter.get(genre) || 0) + 1)
    }

    const slot = timeSlotFromDate(row.startedAt || row.endedAt || row.createdAt)
    if (slot && slot !== 'unknown') {
      slotCounter.set(slot, (slotCounter.get(slot) || 0) + 1)
    }
  })

  return {
    favoriteGenres: topLabelsFromCounter(genreCounter, 5),
    activeTimeSlots: topLabelsFromCounter(slotCounter, 4),
  }
}

/**
 * Creates a completed watch-session record.
 * The function dedupes by room ID when available, writes the normalized row,
 * and returns the canonical stored session shape.
 * @param {object} [payload={}] - The watch-session payload.
 * @returns {Promise<object|null>} The stored watch-session row.
 */
async function createWatchSession(payload = {}) {
  const normalized = normalizeWatchSessionRow(payload)
  if (!normalized.roomCode || normalized.participants.length === 0) {
    return null
  }

  // Use roomId deduplication so the same room does not create duplicate completed sessions.
  if (getMongoConnected()) {
    if (normalized.roomId) {
      const existingByRoomId = await WatchSessionModel.findOne({ roomId: normalized.roomId }).lean()
      if (existingByRoomId) return normalizeWatchSessionRow(existingByRoomId)
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
    })
    return normalizeWatchSessionRow(doc.toObject())
  }

  // The fallback path mirrors the same roomId dedupe before appending to memory.
  if (normalized.roomId) {
    const existing = memoryStore.watchSessions.find((row) => String(row.roomId || '') === normalized.roomId)
    if (existing) return normalizeWatchSessionRow(existing)
  }

  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
  pushBounded(memoryStore.watchSessions, row, 10000)
  return normalizeWatchSessionRow(row)
}

/**
 * Records a single session reaction event.
 * Reactions are stored independently so they can later be counted, attached to
 * a finalized watch session, and transformed into highlights.
 * @param {object} [payload={}] - The raw reaction payload.
 * @returns {Promise<object|null>} The stored normalized reaction row.
 */
async function recordSessionReaction(payload = {}) {
  const normalized = normalizeSessionReactionRow(payload)
  if (!normalized.userUid) return null
  if (!normalized.roomCode && !normalized.sessionId) return null

  // Persist each reaction event when the reaction collection is available.
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
    })
    return normalizeSessionReactionRow(doc.toObject())
  }

  // Memory mode appends the reaction to a bounded room-reaction ledger.
  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
  pushBounded(memoryStore.sessionReactions, row, 16000)
  return normalizeSessionReactionRow(row)
}

/**
 * Lists reaction rows for a room, optionally within a session time window.
 * @param {string} roomCode - The room whose reactions should be listed.
 * @param {object} [options={}] - Optional time window and limit.
 * @returns {Promise<object[]>} Matching reaction rows in chronological order.
 */
async function listRoomReactions(roomCode, { startedAt = null, endedAt = null, limit = MAX_SESSION_REACTIONS } = {}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return []
  const safeLimit = Math.max(1, Math.min(10000, Number(limit) || MAX_SESSION_REACTIONS))
  const rangeStart = startedAt ? new Date(startedAt) : null
  const rangeEnd = endedAt ? new Date(endedAt) : null

  // Query MongoDB directly with the same room and date-range constraints.
  if (getMongoConnected()) {
    const query = { roomCode: normalizedCode }
    if (rangeStart || rangeEnd) {
      query.createdAt = {}
      if (rangeStart) query.createdAt.$gte = rangeStart
      if (rangeEnd) query.createdAt.$lte = rangeEnd
    }
    const rows = await SessionReactionModel.find(query)
      .sort({ createdAt: 1 })
      .limit(safeLimit)
      .lean()
    return rows.map((row) => normalizeSessionReactionRow(row))
  }

  // The fallback path applies identical range filtering and chronological ordering.
  return memoryStore.sessionReactions
    .filter((row) => String(row.roomCode || '') === normalizedCode)
    .filter((row) => {
      const at = row.createdAt ? new Date(row.createdAt).getTime() : 0
      if (rangeStart && at < rangeStart.getTime()) return false
      if (rangeEnd && at > rangeEnd.getTime()) return false
      return true
    })
    .sort((a, b) => new Date(a.createdAt || Date.now()).getTime() - new Date(b.createdAt || Date.now()).getTime())
    .slice(0, safeLimit)
    .map((row) => normalizeSessionReactionRow(row))
}

/**
 * Counts reaction rows for a room, optionally within a session time window.
 * @param {string} roomCode - The room whose reactions should be counted.
 * @param {object} [options={}] - Optional time window bounds.
 * @returns {Promise<number>} The reaction count.
 */
async function countRoomReactions(roomCode, { startedAt = null, endedAt = null } = {}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return 0
  const rangeStart = startedAt ? new Date(startedAt) : null
  const rangeEnd = endedAt ? new Date(endedAt) : null

  // MongoDB can count directly with the same date-range filter used by list queries.
  if (getMongoConnected()) {
    const query = { roomCode: normalizedCode }
    if (rangeStart || rangeEnd) {
      query.createdAt = {}
      if (rangeStart) query.createdAt.$gte = rangeStart
      if (rangeEnd) query.createdAt.$lte = rangeEnd
    }
    return SessionReactionModel.countDocuments(query)
  }

  // Memory mode uses the same filter predicate against the fallback array.
  return memoryStore.sessionReactions.filter((row) => {
    if (String(row.roomCode || '') !== normalizedCode) return false
    const at = row.createdAt ? new Date(row.createdAt).getTime() : 0
    if (rangeStart && at < rangeStart.getTime()) return false
    if (rangeEnd && at > rangeEnd.getTime()) return false
    return true
  }).length
}

/**
 * Backfills a finalized session ID onto reactions that were captured live by room.
 * @param {object} payload - The room/session window used for the backfill.
 * @returns {Promise<number>} The number of reactions updated.
 */
async function attachSessionIdToRoomReactions({ roomCode, sessionId, startedAt, endedAt }) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedCode || !normalizedSessionId) return 0
  const rangeStart = startedAt ? new Date(startedAt) : null
  const rangeEnd = endedAt ? new Date(endedAt) : null

  // Backfill only reactions that do not already have a session ID.
  if (getMongoConnected()) {
    const query = {
      roomCode: normalizedCode,
      $or: [{ sessionId: '' }, { sessionId: { $exists: false } }],
    }
    if (rangeStart || rangeEnd) {
      query.createdAt = {}
      if (rangeStart) query.createdAt.$gte = rangeStart
      if (rangeEnd) query.createdAt.$lte = rangeEnd
    }
    const result = await SessionReactionModel.updateMany(
      query,
      { $set: { sessionId: normalizedSessionId } }
    )
    return result.modifiedCount || 0
  }

  // Memory mode rewrites only the matching session-less reactions in the fallback array.
  let updated = 0
  memoryStore.sessionReactions = memoryStore.sessionReactions.map((row) => {
    if (String(row.roomCode || '') !== normalizedCode) return row
    if (row.sessionId) return row
    const at = row.createdAt ? new Date(row.createdAt).getTime() : 0
    if (rangeStart && at < rangeStart.getTime()) return row
    if (rangeEnd && at > rangeEnd.getTime()) return row
    updated += 1
    return { ...row, sessionId: normalizedSessionId }
  })
  return updated
}

/**
 * Summarizes the dominant mood trend from session highlights.
 * @param {object[]} [rows=[]] - Session rows containing highlights.
 * @returns {string} The summarized mood-trend label.
 */
function summarizeMoodTrend(rows = []) {
  const counter = new Map()
  // Mood trend is inferred from the distribution of highlight reaction types.
  rows.forEach((session) => {
    ;(Array.isArray(session.highlights) ? session.highlights : []).forEach((item) => {
      const type = normalizeReactionType(item.reactionType || item.type || 'reaction')
      counter.set(type, (counter.get(type) || 0) + 1)
    })
  })
  const top = topLabelsFromCounter(counter, 2)
  if (top.length === 0) return 'neutral'
  return top.join(', ')
}

/**
 * Summarizes when and how sessions tend to happen.
 * @param {object[]} [rows=[]] - Session rows used to derive the summary.
 * @returns {string} A combined time-slot and mode summary.
 */
function summarizeWatchPattern(rows = []) {
  const slotCounter = new Map()
  const modeCounter = new Map()
  // Count both the time-of-day slot and session mode so analytics can report both.
  rows.forEach((session) => {
    const slot = timeSlotFromDate(session.startedAt || session.endedAt || session.createdAt)
    if (slot && slot !== 'unknown') {
      slotCounter.set(slot, (slotCounter.get(slot) || 0) + 1)
    }
    const mode = normalizeSessionMode(session.sessionMode || 'watch')
    modeCounter.set(mode, (modeCounter.get(mode) || 0) + 1)
  })

  const topSlot = topLabelsFromCounter(slotCounter, 1)[0] || 'mixed-hours'
  const topMode = topLabelsFromCounter(modeCounter, 1)[0] || 'watch'
  return `${topSlot} / ${topMode}`
}

/**
 * Infers a genre label from session metadata.
 * Content title, content URL, and session mode are inspected to produce a
 * lightweight genre hint for analytics and auto-memory generation.
 * @param {object} [payload={}] - Session metadata used for inference.
 * @returns {string} The inferred genre label or an empty string.
 */
function inferGenreFromSession({ contentTitle = '', contentUrl = '', sessionMode = 'watch' } = {}) {
  const hay = `${String(contentTitle || '')} ${String(contentUrl || '')}`.toLowerCase()
  // Simple keyword buckets provide lightweight genre inference without an external classifier.
  const tests = [
    { genre: 'Romance', terms: ['romance', 'romantic', 'love story', 'date night'] },
    { genre: 'Thriller', terms: ['thriller', 'mystery', 'crime', 'suspense'] },
    { genre: 'Comedy', terms: ['comedy', 'funny', 'standup', 'sitcom'] },
    { genre: 'Sci-Fi', terms: ['sci-fi', 'science fiction', 'space', 'future'] },
    { genre: 'Horror', terms: ['horror', 'scary', 'ghost', 'haunted'] },
    { genre: 'Drama', terms: ['drama', 'emotional', 'family drama'] },
    { genre: 'Education', terms: ['lecture', 'course', 'tutorial', 'study', 'class'] },
    { genre: 'Podcast', terms: ['podcast', 'episode', 'interview'] },
    { genre: 'Reading', terms: ['chapter', '.pdf', 'paper', 'book'] },
  ]
  const hit = tests.find((item) => item.terms.some((term) => hay.includes(term)))
  if (hit) return hit.genre
  const mode = normalizeSessionMode(sessionMode)
  if (mode === 'podcast') return 'Podcast'
  if (mode === 'reading') return 'Reading'
  if (mode === 'study') return 'Education'
  return ''
}

/**
 * Refreshes per-user analytics from one completed session.
 * The function increments watch totals, session totals, streaks, and then
 * recomputes derived genre and time-slot preferences from session history.
 * @param {string} uid - The user whose analytics should be refreshed.
 * @param {object} sessionRow - The completed watch-session row.
 * @returns {Promise<object|null>} The updated profile or null when unavailable.
 */
async function refreshUserAnalytics(uid, sessionRow) {
  const targetUid = String(uid || '').trim()
  if (!targetUid) return null
  const profile = await getProfileByUid(targetUid)
  if (!profile) return null

  // Apply the immediate counters before rebuilding derived preference snapshots.
  const duration = clampSessionDuration(sessionRow?.duration)
  const endedAt = sessionRow?.endedAt ? new Date(sessionRow.endedAt) : new Date()
  const next = {
    ...profile,
    totalWatchTime: Math.max(0, Math.floor(Number(profile.totalWatchTime) || 0) + duration),
    totalSessions: Math.max(0, Math.floor(Number(profile.totalSessions) || 0) + 1),
    streakCount: computeRollingStreak(profile.lastSessionAt, endedAt, profile.streakCount),
    lastSessionAt: endedAt,
  }

  // Recompute preferences from historical sessions so they reflect long-term behavior.
  const sessions = await listWatchSessionsForUser(targetUid, { limit: 240 })
  const prefs = buildPreferenceSnapshotFromSessions(sessions)
  next.preferences = prefs
  return saveProfile(next)
}

/**
 * Refreshes pair-level analytics for an accepted relationship.
 * This updates cumulative watch totals, streaks, top genres, active time slots,
 * milestones, and the yearly insight derived from the latest session.
 * @param {object} relationshipRow - The existing relationship row.
 * @param {object} sessionRow - The completed watch-session row.
 * @returns {Promise<object>} The updated relationship row.
 */
async function refreshRelationshipAnalytics(relationshipRow, sessionRow) {
  if (!relationshipRow || relationshipRow.status !== 'accepted') return relationshipRow
  const pairKey = String(relationshipRow.pairKey || '')
  if (!pairKey) return relationshipRow

  const now = new Date()
  const endedAt = sessionRow?.endedAt ? new Date(sessionRow.endedAt) : now
  const startedAt = sessionRow?.startedAt ? new Date(sessionRow.startedAt) : endedAt
  const duration = clampSessionDuration(sessionRow?.duration)
  const sessions = await listWatchSessionsForRelationship(pairKey, { limit: 500 })
  const prefs = buildPreferenceSnapshotFromSessions(sessions)

  // Merge the latest session into the durable relationship analytics payload.
  const payload = {
    totalWatchTime: Math.max(0, Math.floor(Number(relationshipRow.totalWatchTime) || 0) + duration),
    totalSessions: Math.max(0, Math.floor(Number(relationshipRow.totalSessions) || 0) + 1),
    longestSession: Math.max(Math.floor(Number(relationshipRow.longestSession) || 0), duration),
    streak: computeRollingStreak(relationshipRow.lastWatchedAt, endedAt, relationshipRow.streak),
    firstWatchedAt: relationshipRow.firstWatchedAt ? new Date(relationshipRow.firstWatchedAt) : startedAt,
    lastWatchedAt: endedAt,
    topGenres: prefs.favoriteGenres,
    activeTimeSlots: prefs.activeTimeSlots,
    lastSessionMode: normalizeSessionMode(sessionRow?.sessionMode || relationshipRow.lastSessionMode || 'watch'),
    lastActionAt: now,
    updatedAt: now,
  }

  const next = { ...relationshipRow, ...payload }
  // Persist the updated relationship analytics in the active storage backend.
  if (getMongoConnected()) {
    await RelationshipModel.updateOne(
      { pairKey },
      { $set: payload }
    )
  } else {
    memoryStore.relationships.set(pairKey, getProfileStoreCopy(next))
  }

  // Check milestone thresholds after the relationship totals have been refreshed.
  const milestoneCandidates = [
    {
      type: 'first_movie',
      check: next.totalSessions >= 1,
      payload: {
        contentTitle: sessionRow?.contentTitle || '',
        achievedAfterSessions: next.totalSessions,
      },
    },
    {
      type: '10_sessions',
      check: next.totalSessions >= 10,
      payload: { achievedAfterSessions: next.totalSessions },
    },
    {
      type: '100_hours',
      check: next.totalWatchTime >= (100 * 3600),
      payload: { totalWatchTime: next.totalWatchTime },
    },
  ]

  const milestoneTasks = milestoneCandidates
    .filter((item) => item.check)
    .map((item) => upsertMilestone({
      relationshipId: pairKey,
      pairKey,
      users: next.users || [],
      type: item.type,
      achievedAt: endedAt,
      payload: item.payload,
    }))
  if (milestoneTasks.length > 0) {
    await Promise.allSettled(milestoneTasks)
  }

  // Regenerate the yearly summary for the year that the session ended in.
  await regenerateRelationshipInsight(next, endedAt.getUTCFullYear())
  return next
}

/**
 * Resolves relationship context for a completed session.
 * Two-user sessions may map to an accepted relationship row and pair key,
 * while larger rooms fall back to a group-style relationship type.
 * @param {string[]} participants - The session participants.
 * @param {string} roomType - The room type used for fallback typing.
 * @returns {Promise<object>} Relationship context for the session.
 */
async function resolveRelationshipContextForSession(participants, roomType) {
  const users = uniqueStrings(Array.isArray(participants) ? participants : []).sort()
  if (users.length !== 2) {
    return {
      relationshipRow: null,
      relationshipId: '',
      relationshipType: relationshipTypeFromRoomType(roomType),
    }
  }

  // Accepted relationships supply the durable pair key used for analytics and insights.
  const relationshipRow = await getRelationshipRow(users[0], users[1])
  if (relationshipRow?.status === 'accepted') {
    return {
      relationshipRow,
      relationshipId: String(relationshipRow.pairKey || pairKeyFromUsers(users[0], users[1]) || ''),
      relationshipType: normalizeRelationshipType(relationshipRow.relationshipType || relationshipTypeFromRoomType(roomType)),
    }
  }

  return {
    relationshipRow,
    relationshipId: '',
    relationshipType: relationshipTypeFromRoomType(roomType),
  }
}

/**
 * Converts reaction rows into watch-session highlights.
 * Only the configured maximum number of reactions are converted so the
 * completed session payload stays compact.
 * @param {object[]} [reactions=[]] - Reaction rows captured during the session.
 * @returns {object[]} The derived highlight rows.
 */
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
    }))
}

/**
 * Orchestrates analytics updates for a completed watch session.
 * User analytics are always refreshed, and relationship analytics are refreshed
 * only when the session involves exactly two participants with an accepted link.
 * @param {object} sessionRow - The completed watch-session row.
 * @returns {Promise<void>} Nothing is returned.
 */
async function updateAnalyticsFromWatchSession(sessionRow) {
  if (!sessionRow) return
  const participants = uniqueStrings(sessionRow.participants || [])
  if (participants.length === 0) return

  // Update every participant profile concurrently because the work is independent.
  await Promise.allSettled(participants.map((uid) => refreshUserAnalytics(uid, sessionRow)))

  // Two-person accepted relationships also receive pair-level analytics updates.
  if (participants.length === 2) {
    const relationship = await getRelationshipRow(participants[0], participants[1])
    if (relationship?.status === 'accepted') {
      await refreshRelationshipAnalytics(relationship, sessionRow)
    }
  }
}

/**
 * Builds the composite key for an in-memory room-participant row.
 * @param {string} roomCode - The room code.
 * @param {string} userId - The participant UID.
 * @returns {string} The composite room-participant key.
 */
function roomParticipantKey(roomCode, userId) {
  return `${String(roomCode || '').toUpperCase()}__${String(userId || '')}`
}

/**
 * Upserts persisted room metadata for a live or newly created room.
 * The stored payload includes room identity, creator, mode, participant cap,
 * content state, playback state, permissions, mood tag, and an expiry timestamp.
 * @param {object} payload - The room metadata payload.
 * @returns {Promise<object|null>} The stored room metadata row.
 */
async function upsertRoomMetadata({
  roomCode,
  roomType,
  sessionMode,
  createdBy,
  maxParticipants = MAX_ROOM_USERS,
  isActive = true,
  expiresAt = Date.now() + ROOM_EXPIRY_MS,
  moodTag = '',
  contentUrl = '',
  contentType = 'unknown',
  playbackStatus = 'idle',
  baseTime = 0,
  startedAt = null,
}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return null
  const now = new Date()
  // ExpiresAt defaults to the standard room lifetime unless a caller overrides it.
  const payload = {
    roomCode: normalizedCode,
    roomType: normalizeRoomType(roomType),
    sessionMode: normalizeSessionMode(sessionMode),
    createdBy: String(createdBy || ''),
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
  }

  // Upsert the durable room metadata row when MongoDB is available.
  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: payload.roomCode },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    )
    return RoomModel.findOne({ roomCode: payload.roomCode }).lean()
  }

  // Mirror the same room metadata in the in-memory fallback store.
  const existing = memoryStore.rooms.get(payload.roomCode)
  const next = {
    ...(existing || {}),
    ...payload,
    createdAt: existing?.createdAt || now,
  }
  memoryStore.rooms.set(payload.roomCode, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

/**
 * Marks a room as inactive and stamps closure metadata.
 * @param {string} roomCode - The room code to close.
 * @returns {Promise<void>} Nothing is returned.
 */
async function markRoomInactive(roomCode) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return
  const now = new Date()

  // Persist the inactive state and closure timestamps when MongoDB is connected.
  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: { isActive: false, closedAt: now, lastActivityAt: now } }
    ).catch(() => {})
    return
  }

  // Mirror the inactive state into the fallback room metadata map.
  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.isActive = false
  room.closedAt = now
  room.lastActivityAt = now
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

/**
 * Updates the persisted content URL and content type for a room.
 * @param {string} roomCode - The room code to update.
 * @param {object} [payload={}] - The next content state.
 * @returns {Promise<void>} Nothing is returned.
 */
async function updateRoomContentState(roomCode, { contentUrl = '', contentType = 'unknown' } = {}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return
  const updates = {
    contentUrl: sanitizeContentUrl(contentUrl),
    contentType: normalizeContentType(contentType),
    lastActivityAt: new Date(),
  }

  // Update the durable room row when persistence is available.
  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {})
    return
  }

  // Reflect the same content-state change into the in-memory room snapshot.
  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.contentUrl = updates.contentUrl
  room.contentType = updates.contentType
  room.lastActivityAt = updates.lastActivityAt
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

/**
 * Updates the creator UID for a room.
 * @param {string} roomCode - The room code to update.
 * @param {string} createdBy - The UID of the room creator or host.
 * @returns {Promise<void>} Nothing is returned.
 */
async function updateRoomCreator(roomCode, createdBy) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  const normalizedUid = String(createdBy || '').trim()
  if (!normalizedCode || !normalizedUid) return
  const updates = {
    createdBy: normalizedUid,
    lastActivityAt: new Date(),
  }

  // Persist the creator update when MongoDB is available.
  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {})
    return
  }

  // Mirror the creator change into the in-memory room metadata.
  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.createdBy = normalizedUid
  room.lastActivityAt = updates.lastActivityAt
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

/**
 * Updates persisted playback state for a room.
 * Playback state captures whether the room is playing or paused, the base time,
 * and the optional playback start timestamp used for synchronization.
 * @param {string} roomCode - The room code to update.
 * @param {object} [payload={}] - The next playback-state values.
 * @returns {Promise<void>} Nothing is returned.
 */
async function updateRoomPlaybackState(roomCode, { playbackStatus = 'idle', baseTime = 0, startedAt = null } = {}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return
  const updates = {
    playbackStatus: normalizePlaybackStatus(playbackStatus),
    baseTime: clampTime(baseTime),
    lastActivityAt: new Date(),
  }
  if (startedAt) {
    updates.startedAt = new Date(startedAt)
  }

  // Persist playback state into the room metadata row when MongoDB is connected.
  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {})
    return
  }

  // Apply the same playback state mutation to the fallback room snapshot.
  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.playbackStatus = updates.playbackStatus
  room.baseTime = updates.baseTime
  if (updates.startedAt) room.startedAt = updates.startedAt
  room.lastActivityAt = updates.lastActivityAt
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

/**
 * Upserts one participant row for a room.
 * Participant history tracks joins, leaves, roles, and whether the user is
 * currently active in the room.
 * @param {string} roomCode - The room code.
 * @param {string} userId - The participant UID.
 * @param {object} [updates={}] - The participant fields to apply.
 * @returns {Promise<object|null>} The stored participant row.
 */
async function upsertRoomParticipant(roomCode, userId, updates = {}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  const normalizedUid = String(userId || '').trim()
  if (!normalizedCode || !normalizedUid) return null
  const now = new Date()
  const payload = {
    roomCode: normalizedCode,
    userId: normalizedUid,
    joinedAt: updates.joinedAt ? new Date(updates.joinedAt) : now,
    leftAt: updates.leftAt ? new Date(updates.leftAt) : null,
    role: String(updates.role || 'member').slice(0, 32),
    isActive: updates.isActive !== false,
  }

  // Upsert the durable participant row in MongoDB when available.
  if (getMongoConnected()) {
    await RoomParticipantModel.updateOne(
      { roomCode: normalizedCode, userId: normalizedUid },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    )
    return RoomParticipantModel.findOne({ roomCode: normalizedCode, userId: normalizedUid }).lean()
  }

  // Memory mode stores participant rows in a keyed map by room and user.
  const key = roomParticipantKey(normalizedCode, normalizedUid)
  const existing = memoryStore.roomParticipants.get(key)
  const next = {
    ...(existing || {}),
    ...payload,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  memoryStore.roomParticipants.set(key, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

/**
 * Marks a room participant as having left the room.
 * @param {string} roomCode - The room code.
 * @param {string} userId - The participant UID.
 * @returns {Promise<object|null>} The updated participant row.
 */
async function markRoomParticipantLeft(roomCode, userId) {
  return upsertRoomParticipant(roomCode, userId, {
    leftAt: new Date(),
    isActive: false,
  })
}

/**
 * Lists every distinct participant ever associated with a room.
 * The result merges the live room runtime with historical participant rows so
 * session finalization has a complete participant list.
 * @param {string} roomCode - The room code to inspect.
 * @param {object|null} [roomSnapshot=null] - Optional live room snapshot.
 * @returns {Promise<string[]>} Distinct participant UIDs.
 */
async function listDistinctParticipantsForRoom(roomCode, roomSnapshot = null) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return []

  const uids = new Set()
  // Live room membership contributes currently connected users.
  if (roomSnapshot?.users instanceof Map) {
    roomSnapshot.users.forEach((_value, uid) => {
      if (uid) uids.add(String(uid))
    })
  }
  // Joined-at history catches users who were present earlier in the room lifecycle.
  if (roomSnapshot?.joinedAtByUid instanceof Map) {
    roomSnapshot.joinedAtByUid.forEach((_value, uid) => {
      if (uid) uids.add(String(uid))
    })
  }

  // Historical participant rows fill in users who are no longer present in memory.
  const historicalRows = await listRoomParticipantsByCode(normalizedCode)
  historicalRows.forEach((row) => {
    if (row?.userId) uids.add(String(row.userId))
  })

  return uniqueStrings([...uids])
}

/**
 * Finalizes a room's live video session into a completed watch session.
 * The sequence closes the live session, dedupes against recent finalized rows,
 * resolves participants and content metadata, builds highlights from reactions,
 * persists the completed watch session, backfills reaction session IDs,
 * refreshes analytics, and optionally auto-creates a shared memory.
 * @param {string} roomCode - The room being finalized.
 * @param {object|null} [roomSnapshot=null] - Optional live room snapshot.
 * @returns {Promise<object|null>} The finalized watch-session row or null.
 */
async function finalizeVideoSession(roomCode, roomSnapshot = null) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return
  const endedAt = new Date()
  let videoSession = null

  // Close the live video-session metadata row first so total watch time is captured.
  if (getMongoConnected()) {
    const existing = await VideoSessionModel.findOne({ roomCode: normalizedCode }).lean()
    if (existing && !existing.endedAt) {
      const startedAtMs = existing.startedAt ? new Date(existing.startedAt).getTime() : Date.now()
      const totalWatchTime = Math.max(0, Math.floor((endedAt.getTime() - startedAtMs) / 1000))
      await VideoSessionModel.updateOne(
        { roomCode: normalizedCode },
        { $set: { endedAt, totalWatchTime } }
      ).catch(() => {})
      videoSession = await VideoSessionModel.findOne({ roomCode: normalizedCode }).lean()
    } else {
      videoSession = existing
    }
  } else {
    const existing = memoryStore.videoSessions.get(normalizedCode)
    if (existing && !existing.endedAt) {
      const startedAtMs = existing.startedAt ? new Date(existing.startedAt).getTime() : Date.now()
      existing.endedAt = endedAt
      existing.totalWatchTime = Math.max(0, Math.floor((endedAt.getTime() - startedAtMs) / 1000))
      existing.updatedAt = endedAt
      memoryStore.videoSessions.set(normalizedCode, getProfileStoreCopy(existing))
      videoSession = getProfileStoreCopy(existing)
    } else if (existing) {
      videoSession = getProfileStoreCopy(existing)
    }
  }

  const roomMeta = await getRoomMetadataByCode(normalizedCode)
  const roomId = roomMeta?._id ? String(roomMeta._id) : ''
  const dedupeWindowStart = new Date(Date.now() - 36 * 60 * 60 * 1000)

  // Deduplicate finalized sessions so reconnects or repeated shutdown paths do not double-write.
  if (getMongoConnected()) {
    if (roomId) {
      const existingByRoomId = await WatchSessionModel.findOne({ roomId }).lean()
      if (existingByRoomId) return normalizeWatchSessionRow(existingByRoomId)
    } else {
      const existingByCode = await WatchSessionModel.findOne({
        roomCode: normalizedCode,
        endedAt: { $gte: dedupeWindowStart },
      }).sort({ endedAt: -1 }).lean()
      if (existingByCode) return normalizeWatchSessionRow(existingByCode)
    }
  } else if (roomId) {
    const existingByRoomId = memoryStore.watchSessions.find((row) => String(row.roomId || '') === roomId)
    if (existingByRoomId) return normalizeWatchSessionRow(existingByRoomId)
  } else {
    const existingByCode = memoryStore.watchSessions.find((row) => {
      if (String(row.roomCode || '') !== normalizedCode) return false
      const ended = row.endedAt ? new Date(row.endedAt).getTime() : 0
      return ended >= dedupeWindowStart.getTime()
    })
    if (existingByCode) return normalizeWatchSessionRow(existingByCode)
  }

  // Gather the full participant list from both live and historical room sources.
  const participants = await listDistinctParticipantsForRoom(normalizedCode, roomSnapshot)
  if (participants.length === 0) return null

  // Prefer explicit session start times and fall back to room creation time when needed.
  const roomStartedAt = Number.isFinite(Number(roomSnapshot?.createdAt))
    ? new Date(Number(roomSnapshot.createdAt))
    : (roomMeta?.startedAt || roomMeta?.createdAt ? new Date(roomMeta.startedAt || roomMeta.createdAt) : null)
  const videoStartedAt = videoSession?.startedAt ? new Date(videoSession.startedAt) : null
  const startedAt = videoStartedAt && !Number.isNaN(videoStartedAt.getTime())
    ? videoStartedAt
    : (roomStartedAt && !Number.isNaN(roomStartedAt.getTime()) ? roomStartedAt : new Date(endedAt.getTime() - 1000))

  const measuredWatchTime = clampSessionDuration(videoSession?.totalWatchTime)
  const fallbackDuration = clampSessionDuration(Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
  const duration = measuredWatchTime > 0 ? measuredWatchTime : fallbackDuration

  // Pull both highlight rows and the total reaction count for the completed session.
  const [reactionRows, reactionsCount] = await Promise.all([
    listRoomReactions(normalizedCode, { startedAt, endedAt, limit: MAX_SESSION_HIGHLIGHTS }),
    countRoomReactions(normalizedCode, { startedAt, endedAt }),
  ])
  if (duration < 20 && reactionsCount === 0) return null
  const highlights = buildSessionHighlightsFromReactions(reactionRows)

  // Resolve relationship and content context before persisting the completed session.
  const relationshipContext = await resolveRelationshipContextForSession(participants, roomSnapshot?.roomType || roomMeta?.roomType)
  const contentType = normalizeContentType(
    roomMeta?.contentType
    || roomSnapshot?.videoMetadata?.sourceType
    || videoSession?.sourceType
    || 'unknown'
  )
  const contentUrl = sanitizeContentUrl(
    roomMeta?.contentUrl
    || videoSession?.contentUrl
    || roomSnapshot?.videoMetadata?.contentUrl
    || ''
  )
  const contentTitle = sanitize(
    roomSnapshot?.videoMetadata?.videoName
    || videoSession?.videoName
    || ''
  ).slice(0, MAX_VIDEO_NAME_LENGTH)
  const moodTag = sanitizeRoomMoodTag(roomSnapshot?.moodTag || roomMeta?.moodTag || '')
  const inferredGenre = inferGenreFromSession({
    contentTitle,
    contentUrl,
    sessionMode: roomSnapshot?.sessionMode || roomMeta?.sessionMode || 'watch',
  })
  const createdBy = String(roomSnapshot?.createdBy || roomMeta?.createdBy || participants[0] || '')

  // Persist the completed watch session row.
  const sessionRow = await createWatchSession({
    roomCode: normalizedCode,
    roomId,
    roomType: roomSnapshot?.roomType || roomMeta?.roomType || 'friends',
    sessionMode: roomSnapshot?.sessionMode || roomMeta?.sessionMode || 'watch',
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
  })

  if (!sessionRow?.id) return null

  // Backfill reactions and refresh user/relationship analytics from the finalized session.
  await attachSessionIdToRoomReactions({
    roomCode: normalizedCode,
    sessionId: sessionRow.id,
    startedAt,
    endedAt,
  })
  await updateAnalyticsFromWatchSession(sessionRow)

  // Long-enough two-person sessions also create an automatic shared-memory note.
  if (participants.length === 2 && relationshipContext.relationshipId && sessionRow.duration >= WATCH_MEMORY_MIN_SECONDS) {
    const noteParts = []
    const sessionModeLabel = normalizeSessionMode(sessionRow.sessionMode || 'watch')
    if (sessionModeLabel === 'reading') noteParts.push('Auto memory: co-reading session')
    else if (sessionModeLabel === 'podcast') noteParts.push('Auto memory: podcast sync session')
    else if (sessionModeLabel === 'study') noteParts.push('Auto memory: study session')
    else noteParts.push('Auto memory: watch session')
    if (sessionRow.contentTitle) noteParts.push(`- ${sessionRow.contentTitle}`)
    noteParts.push(`(${Math.max(1, Math.round(sessionRow.duration / 60))}m)`)

    await createSharedMemory({
      userA: participants[0],
      userB: participants[1],
      roomCode: normalizedCode,
      memoryNote: noteParts.join(' '),
      createdBy,
      date: endedAt,
      sessionMode: sessionRow.sessionMode || 'watch',
      genre: sessionRow.genre || '',
      moodTag: moodTag || '',
      highlightTimestamp: '',
      sessionMinutes: Math.round(sessionRow.duration / 60),
      reactionCount: sessionRow.reactionsCount || 0,
    }).catch(() => {})
  }

  return sessionRow
}

module.exports = {
  getRoomMetadataByCode,
  listRoomParticipantsByCode,
  getRoomHistorySnapshot,
  normalizePlaybackStatus,
  clampSessionDuration,
  toUtcDayTimestamp,
  computeRollingStreak,
  timeSlotFromDate,
  topLabelsFromCounter,
  normalizeSessionReactionRow,
  relationshipTypeFromRoomType,
  buildPreferenceSnapshotFromSessions,
  createWatchSession,
  recordSessionReaction,
  listRoomReactions,
  countRoomReactions,
  attachSessionIdToRoomReactions,
  summarizeMoodTrend,
  summarizeWatchPattern,
  inferGenreFromSession,
  refreshUserAnalytics,
  refreshRelationshipAnalytics,
  resolveRelationshipContextForSession,
  buildSessionHighlightsFromReactions,
  updateAnalyticsFromWatchSession,
  roomParticipantKey,
  upsertRoomMetadata,
  markRoomInactive,
  updateRoomContentState,
  updateRoomCreator,
  updateRoomPlaybackState,
  upsertRoomParticipant,
  markRoomParticipantLeft,
  listDistinctParticipantsForRoom,
  finalizeVideoSession,
}
