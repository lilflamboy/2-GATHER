'use strict'

const {
  RoomModel, RoomParticipantModel, ActivityEventModel,
  ChatArchiveModel, getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { getProfileStoreCopy } =
  require('../utils/helpers.js')
const { getVideoSessionByRoomCode } =
  require('./session.service.js')
const { rooms } =
  require('../sockets/roomStore.js')

async function getRoomMetadataByCode(roomCode) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return null

  if (getMongoConnected()) {
    return RoomModel.findOne({ roomCode: normalizedCode }).lean()
  }

  const room = memoryStore.rooms.get(normalizedCode)
  return room ? getProfileStoreCopy(room) : null
}

async function listRoomParticipantsByCode(roomCode) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return []

  if (getMongoConnected()) {
    return RoomParticipantModel.find({ roomCode: normalizedCode }).sort({ joinedAt: 1 }).lean()
  }

  return [...memoryStore.roomParticipants.values()]
    .filter((row) => row.roomCode === normalizedCode)
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
    .map((row) => getProfileStoreCopy(row))
}

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
  if (!isLiveMember && !wasParticipant) {
    const error = new Error('You do not have access to this room history')
    error.status = 403
    throw error
  }

  const roomMeta = await getRoomMetadataByCode(normalizedCode)
  const videoSession = await getVideoSessionByRoomCode(normalizedCode)

  let activities = []
  let chat = []
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

module.exports = {
  getRoomMetadataByCode,
  listRoomParticipantsByCode,
  getRoomHistorySnapshot,
}
