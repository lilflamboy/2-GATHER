'use strict'

const {
  ActivityEventModel, VideoSessionModel,
  ChatArchiveModel, RoomModel,
  getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { getProfileStoreCopy, pushBounded } =
  require('../utils/helpers.js')
const { normalizeContentType } =
  require('../utils/normalize.js')
const {
  sanitize, sanitizeContentUrl,
  sanitizeActivityPayload,
} = require('../utils/sanitize.js')
const {
  MAX_VIDEO_NAME_LENGTH,
  MAX_VIDEO_TIME,
} = require('../config/constants.js')

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
  logActivity,
  touchRoomActivity,
  saveVideoSessionMetadata,
  archiveChatMessage,
  listActivityForUser,
  getVideoSessionByRoomCode,
}
