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

function clampSessionDuration(value) {
  const num = Math.floor(Number(value) || 0)
  return Math.max(0, Math.min(172800, num))
}

function normalizeReactionType(value, fallback = 'reaction') {
  const raw = String(value || '').trim().toLowerCase()
  if (ALLOWED_REACTION_TYPES.includes(raw)) return raw
  return ALLOWED_REACTION_TYPES.includes(fallback) ? fallback : 'reaction'
}

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

function normalizeWatchSessionRow(row = {}) {
  const participants = uniqueStrings(Array.isArray(row.participants) ? row.participants : [])
  const startedAt = row.startedAt ? new Date(row.startedAt) : new Date()
  const endedAt = row.endedAt ? new Date(row.endedAt) : new Date()
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

  if (getMongoConnected()) {
    const query = { relationshipId: key }
    if (rangeStart && rangeEnd) {
      query.endedAt = { $gte: rangeStart, $lt: rangeEnd }
    }
    const rows = await WatchSessionModel.find(query).sort({ endedAt: -1 }).limit(safeLimit).lean()
    return rows.map((row) => normalizeWatchSessionRow(row))
  }

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

  if (getMongoConnected()) {
    await ActivityEventModel.create(normalized).catch(() => {})
    return
  }

  pushBounded(memoryStore.activityEvents, normalized, 4000)
}

async function touchRoomActivity(roomCode) {
  const normalizedCode = String(roomCode || "").trim().toUpperCase()
  if (!normalizedCode) return
  const now = new Date()

  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: { lastActivityAt: now } }
    ).catch(() => {})
    return
  }

  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.lastActivityAt = now
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
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
  }
  if (!normalized.roomCode) return null

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

  if (getMongoConnected()) {
    await ChatArchiveModel.updateOne(
      { messageId: payload.messageId },
      { $set: payload },
      { upsert: true }
    ).catch(() => {})
    return
  }

  pushBounded(memoryStore.chatMessages, { ...payload }, 5000)
}

async function listActivityForUser(uid, limit = 40) {
  const selfUid = String(uid || "").trim()
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 40))
  if (!selfUid) return []

  if (getMongoConnected()) {
    return ActivityEventModel.find({ uid: selfUid }).sort({ occurredAt: -1 }).limit(safeLimit).lean()
  }

  return memoryStore.activityEvents
    .filter((item) => item.uid === selfUid)
    .slice(-safeLimit)
    .reverse()
    .map((item) => getProfileStoreCopy(item))
}

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
