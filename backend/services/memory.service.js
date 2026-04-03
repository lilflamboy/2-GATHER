/**
 * Manages shared memory records and raw watch-time memory events.
 * Memory events are low-level time accumulations between two users, while
 * shared memories are authored notes that capture meaningful session moments.
 */
'use strict'

const {
  SharedMemoryModel, MemoryEventModel,
  getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const {
  sortedPairUsers, pairKeyFromUsers,
} = require('./relationship.service.js')
const { normalizeSessionMode } =
  require('../utils/normalize.js')
const {
  escapeAngleBrackets,
  sanitizeSharedMemoryGenre,
  sanitizeSharedMemoryMoodTag,
} = require('../utils/sanitize.js')
const { pushBounded } =
  require('../utils/helpers.js')
const {
  WATCH_MEMORY_MIN_SECONDS,
  MAX_SHARED_MEMORY_NOTE_LENGTH,
  MAX_SHARED_MEMORY_HIGHLIGHT_LENGTH,
  MAX_SHARED_MEMORY_SESSION_MINUTES,
  MAX_SHARED_MEMORY_REACTION_COUNT,
} = require('../config/constants.js')

/**
 * Records a raw watch-time event for a pair of users.
 * The argument order is always `(uidA, uidB, seconds, roomCode)`, and the two
 * UIDs are sorted before storage so the pair accumulates consistently.
 * @param {string} uidA - The first participant UID.
 * @param {string} uidB - The second participant UID.
 * @param {number} seconds - The watch duration represented by this event.
 * @param {string} [roomCode=''] - The room that produced the event.
 * @returns {Promise<void>} Nothing is returned.
 */
async function addMemoryEvent(uidA, uidB, seconds, roomCode = "") {
  if (!uidA || !uidB || uidA === uidB) return
  const safeSeconds = Math.floor(Number(seconds) || 0)
  if (safeSeconds < WATCH_MEMORY_MIN_SECONDS) return

  // Store user pairs in sorted order so both directions aggregate into one relationship bucket.
  const users = [uidA, uidB].sort()
  const payload = {
    users,
    seconds: safeSeconds,
    occurredAt: new Date(),
    roomCode: String(roomCode || "").slice(0, 32),
  }

  // Memory events are durably appended when MongoDB is available.
  if (getMongoConnected()) {
    await MemoryEventModel.create(payload)
    return
  }

  // Otherwise append the event to the fallback in-memory ledger.
  memoryStore.memoryEvents.push(payload)
}

/**
 * Lists recent memory events for one user.
 * Both storage paths return the newest events first and cap the response to a
 * bounded history window.
 * @param {string} uid - The user whose memory events should be loaded.
 * @returns {Promise<object[]>} Recent memory events for that user.
 */
async function listMemoryEventsForUser(uid) {
  if (!uid) return []

  // Query the persistent memory-event collection when MongoDB is connected.
  if (getMongoConnected()) {
    return MemoryEventModel.find({ users: uid }).sort({ occurredAt: -1 }).limit(5000).lean()
  }

  // Rebuild the same newest-first slice from the fallback event array.
  return memoryStore.memoryEvents
    .filter((event) => event.users.includes(uid))
    .slice(-5000)
    .reverse()
    .map((event) => ({ ...event }))
}

/**
 * Aggregates raw memory events into summary totals and per-friend buckets.
 * The aggregation produces week, month, year, and all-time watch totals that
 * power the memory stats view.
 * @param {string} uid - The user whose memories are being summarized.
 * @param {object[]} events - The raw memory events to aggregate.
 * @param {object[]} friendProfiles - Profiles used to enrich friend labels.
 * @returns {object} Aggregate totals and per-friend breakdowns.
 */
function aggregateMemories(uid, events, friendProfiles) {
  const now = Date.now()
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000
  const yearAgo = now - 365 * 24 * 60 * 60 * 1000

  const profileByUid = new Map(friendProfiles.map((profile) => [profile.uid, profile]))
  const byFriend = new Map()

  const summary = {
    weekSeconds: 0,
    monthSeconds: 0,
    yearSeconds: 0,
    allSeconds: 0,
  }

  // Roll every event into both the global totals and the relevant friend bucket.
  events.forEach((event) => {
    const occurredAt = new Date(event.occurredAt).getTime()
    const seconds = Math.max(0, Number(event.seconds) || 0)
    const friendUid = event.users[0] === uid ? event.users[1] : event.users[0]
    if (!friendUid) return

    if (!byFriend.has(friendUid)) {
      const profile = profileByUid.get(friendUid)
      byFriend.set(friendUid, {
        uid: friendUid,
        username: profile?.username || "",
        displayName: profile?.displayName || "Friend",
        photoURL: profile?.photoURL || "",
        weekSeconds: 0,
        monthSeconds: 0,
        yearSeconds: 0,
        allSeconds: 0,
      })
    }

    const bucket = byFriend.get(friendUid)
    bucket.allSeconds += seconds
    summary.allSeconds += seconds

    if (occurredAt >= yearAgo) {
      bucket.yearSeconds += seconds
      summary.yearSeconds += seconds
    }
    if (occurredAt >= monthAgo) {
      bucket.monthSeconds += seconds
      summary.monthSeconds += seconds
    }
    if (occurredAt >= weekAgo) {
      bucket.weekSeconds += seconds
      summary.weekSeconds += seconds
    }
  })

  return {
    summary,
    byFriend: [...byFriend.values()].sort((a, b) => b.allSeconds - a.allSeconds),
  }
}

/**
 * Sanitizes a user-authored shared-memory note.
 * Notes escape angle brackets, trim whitespace, and enforce the configured
 * maximum length before they are stored or returned.
 * @param {string} note - The raw note text.
 * @returns {string} The sanitized note string.
 */
function sanitizeSharedMemoryNote(note) {
  if (typeof note !== "string") return ""
  return escapeAngleBrackets(note).trim().slice(0, MAX_SHARED_MEMORY_NOTE_LENGTH)
}

/**
 * Validates and truncates a highlight timestamp string.
 * Only `mm:ss` and `hh:mm:ss`-style values are accepted so timestamp chips stay
 * compact and predictable.
 * @param {string} value - The raw highlight timestamp.
 * @returns {string} The normalized timestamp or an empty string.
 */
function sanitizeHighlightTimestamp(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.slice(0, MAX_SHARED_MEMORY_HIGHLIGHT_LENGTH)
  }
  return ""
}

/**
 * Clamps shared-memory session minutes into the configured range.
 * Zero is allowed because some memories may reference a moment rather than a
 * complete timed session.
 * @param {number} value - The raw session length in minutes.
 * @returns {number} The bounded session-minute value.
 */
function clampSharedSessionMinutes(value) {
  const num = Math.floor(Number(value) || 0)
  return Math.max(0, Math.min(MAX_SHARED_MEMORY_SESSION_MINUTES, num))
}

/**
 * Clamps the recorded reaction count for a shared memory.
 * @param {number} value - The raw reaction count.
 * @returns {number} The bounded reaction count.
 */
function clampReactionCount(value) {
  const num = Math.floor(Number(value) || 0)
  return Math.max(0, Math.min(MAX_SHARED_MEMORY_REACTION_COUNT, num))
}

/**
 * Normalizes a shared-memory row into the canonical stored shape.
 * The pair key is derived from sorted user IDs, text fields are sanitized,
 * counters are clamped, and timestamps are coerced into Date objects.
 * @param {object} [row={}] - The raw shared-memory row.
 * @returns {object} The normalized shared-memory record.
 */
function normalizeSharedMemoryRow(row = {}) {
  const pairUsers = sortedPairUsers(row.user1Id, row.user2Id)
  const user1Id = pairUsers?.[0] || String(row.user1Id || "")
  const user2Id = pairUsers?.[1] || String(row.user2Id || "")
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
  }
}

/**
 * Creates a user-authored shared memory between two users.
 * The payload is validated, pair-scoped, normalized, and then persisted via
 * MongoDB or pushed into the bounded in-memory shared-memory list.
 * @param {object} payload - The shared-memory creation payload.
 * @returns {Promise<object>} The stored shared-memory record.
 */
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
  const users = sortedPairUsers(userA, userB)
  if (!users) {
    const error = new Error("Two valid users are required")
    error.status = 400
    throw error
  }

  const note = sanitizeSharedMemoryNote(memoryNote)
  if (!note) {
    const error = new Error("memoryNote is required")
    error.status = 400
    throw error
  }

  // Normalize the authored memory into the canonical shared-memory row.
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
  })

  // Persist the normalized memory row when MongoDB is available.
  if (getMongoConnected()) {
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
    })
    return normalizeSharedMemoryRow(doc.toObject())
  }

  // Otherwise append to the bounded in-memory shared-memory list.
  pushBounded(memoryStore.sharedMemories, payload, 4000)
  return payload
}

/**
 * Lists shared memories for a user, optionally narrowed to one partner.
 * Results are returned newest-first and capped to a bounded history window in
 * both persistence modes.
 * @param {string} uid - The user requesting memories.
 * @param {string} [partnerUid=''] - Optional partner UID to scope the query.
 * @returns {Promise<object[]>} Matching shared-memory records.
 */
async function listSharedMemoriesForUser(uid, partnerUid = "") {
  const selfUid = String(uid || "").trim()
  if (!selfUid) return []
  const partner = String(partnerUid || "").trim()
  const pairKey = partner ? pairKeyFromUsers(selfUid, partner) : null

  // Query the durable shared-memory collection when MongoDB is connected.
  if (getMongoConnected()) {
    const query = pairKey
      ? { pairKey }
      : { $or: [{ user1Id: selfUid }, { user2Id: selfUid }] }
    const rows = await SharedMemoryModel.find(query).sort({ date: -1, createdAt: -1 }).limit(200).lean()
    return rows.map((row) => normalizeSharedMemoryRow(row))
  }

  // Mirror the same filtering and ordering over the fallback shared-memory array.
  return memoryStore.sharedMemories
    .filter((row) => {
      if (pairKey) return row.pairKey === pairKey
      return row.user1Id === selfUid || row.user2Id === selfUid
    })
    .slice(-200)
    .reverse()
    .map((row) => normalizeSharedMemoryRow(row))
}

module.exports = {
  addMemoryEvent,
  listMemoryEventsForUser,
  aggregateMemories,
  sanitizeSharedMemoryNote,
  sanitizeHighlightTimestamp,
  clampSharedSessionMinutes,
  clampReactionCount,
  normalizeSharedMemoryRow,
  createSharedMemory,
  listSharedMemoriesForUser,
}
