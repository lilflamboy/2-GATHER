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

async function addMemoryEvent(uidA, uidB, seconds, roomCode = "") {
  if (!uidA || !uidB || uidA === uidB) return
  const safeSeconds = Math.floor(Number(seconds) || 0)
  if (safeSeconds < WATCH_MEMORY_MIN_SECONDS) return

  const users = [uidA, uidB].sort()
  const payload = {
    users,
    seconds: safeSeconds,
    occurredAt: new Date(),
    roomCode: String(roomCode || "").slice(0, 32),
  }

  if (getMongoConnected()) {
    await MemoryEventModel.create(payload)
    return
  }

  memoryStore.memoryEvents.push(payload)
}

async function listMemoryEventsForUser(uid) {
  if (!uid) return []

  if (getMongoConnected()) {
    return MemoryEventModel.find({ users: uid }).sort({ occurredAt: -1 }).limit(5000).lean()
  }

  return memoryStore.memoryEvents
    .filter((event) => event.users.includes(uid))
    .slice(-5000)
    .reverse()
    .map((event) => ({ ...event }))
}

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

function sanitizeSharedMemoryNote(note) {
  if (typeof note !== "string") return ""
  return escapeAngleBrackets(note).trim().slice(0, MAX_SHARED_MEMORY_NOTE_LENGTH)
}

function sanitizeHighlightTimestamp(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.slice(0, MAX_SHARED_MEMORY_HIGHLIGHT_LENGTH)
  }
  return ""
}

function clampSharedSessionMinutes(value) {
  const num = Math.floor(Number(value) || 0)
  return Math.max(0, Math.min(MAX_SHARED_MEMORY_SESSION_MINUTES, num))
}

function clampReactionCount(value) {
  const num = Math.floor(Number(value) || 0)
  return Math.max(0, Math.min(MAX_SHARED_MEMORY_REACTION_COUNT, num))
}

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

  pushBounded(memoryStore.sharedMemories, payload, 4000)
  return payload
}

async function listSharedMemoriesForUser(uid, partnerUid = "") {
  const selfUid = String(uid || "").trim()
  if (!selfUid) return []
  const partner = String(partnerUid || "").trim()
  const pairKey = partner ? pairKeyFromUsers(selfUid, partner) : null

  if (getMongoConnected()) {
    const query = pairKey
      ? { pairKey }
      : { $or: [{ user1Id: selfUid }, { user2Id: selfUid }] }
    const rows = await SharedMemoryModel.find(query).sort({ date: -1, createdAt: -1 }).limit(200).lean()
    return rows.map((row) => normalizeSharedMemoryRow(row))
  }

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
