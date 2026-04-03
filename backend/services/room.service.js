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

function normalizePlaybackStatus(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'playing' || raw === 'paused' || raw === 'idle') return raw
  return 'idle'
}

function clampSessionDuration(value) {
  const num = Math.floor(Number(value) || 0)
  return Math.max(0, Math.min(172800, num))
}

function toUtcDayTimestamp(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 0
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

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

function timeSlotFromDate(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 'unknown'
  const hour = date.getHours()
  if (hour >= 22 || hour < 5) return 'late_night'
  if (hour >= 18) return 'evening'
  if (hour >= 12) return 'afternoon'
  return 'morning'
}

function topLabelsFromCounter(counterMap, limit = 5) {
  return [...counterMap.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
    .slice(0, Math.max(1, limit))
    .map(([label]) => label)
}

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

function relationshipTypeFromRoomType(roomType) {
  const normalizedRoomType = normalizeRoomType(roomType)
  if (normalizedRoomType === 'family') return 'family'
  if (normalizedRoomType === 'duo') return 'couple'
  return 'group'
}

function buildPreferenceSnapshotFromSessions(rows = []) {
  const genreCounter = new Map()
  const slotCounter = new Map()

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

async function createWatchSession(payload = {}) {
  const normalized = normalizeWatchSessionRow(payload)
  if (!normalized.roomCode || normalized.participants.length === 0) {
    return null
  }

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

async function recordSessionReaction(payload = {}) {
  const normalized = normalizeSessionReactionRow(payload)
  if (!normalized.userUid) return null
  if (!normalized.roomCode && !normalized.sessionId) return null

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

  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
  pushBounded(memoryStore.sessionReactions, row, 16000)
  return normalizeSessionReactionRow(row)
}

async function listRoomReactions(roomCode, { startedAt = null, endedAt = null, limit = MAX_SESSION_REACTIONS } = {}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return []
  const safeLimit = Math.max(1, Math.min(10000, Number(limit) || MAX_SESSION_REACTIONS))
  const rangeStart = startedAt ? new Date(startedAt) : null
  const rangeEnd = endedAt ? new Date(endedAt) : null

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

async function countRoomReactions(roomCode, { startedAt = null, endedAt = null } = {}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return 0
  const rangeStart = startedAt ? new Date(startedAt) : null
  const rangeEnd = endedAt ? new Date(endedAt) : null

  if (getMongoConnected()) {
    const query = { roomCode: normalizedCode }
    if (rangeStart || rangeEnd) {
      query.createdAt = {}
      if (rangeStart) query.createdAt.$gte = rangeStart
      if (rangeEnd) query.createdAt.$lte = rangeEnd
    }
    return SessionReactionModel.countDocuments(query)
  }

  return memoryStore.sessionReactions.filter((row) => {
    if (String(row.roomCode || '') !== normalizedCode) return false
    const at = row.createdAt ? new Date(row.createdAt).getTime() : 0
    if (rangeStart && at < rangeStart.getTime()) return false
    if (rangeEnd && at > rangeEnd.getTime()) return false
    return true
  }).length
}

async function attachSessionIdToRoomReactions({ roomCode, sessionId, startedAt, endedAt }) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedCode || !normalizedSessionId) return 0
  const rangeStart = startedAt ? new Date(startedAt) : null
  const rangeEnd = endedAt ? new Date(endedAt) : null

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

function summarizeMoodTrend(rows = []) {
  const counter = new Map()
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

function summarizeWatchPattern(rows = []) {
  const slotCounter = new Map()
  const modeCounter = new Map()
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

function inferGenreFromSession({ contentTitle = '', contentUrl = '', sessionMode = 'watch' } = {}) {
  const hay = `${String(contentTitle || '')} ${String(contentUrl || '')}`.toLowerCase()
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

async function refreshUserAnalytics(uid, sessionRow) {
  const targetUid = String(uid || '').trim()
  if (!targetUid) return null
  const profile = await getProfileByUid(targetUid)
  if (!profile) return null

  const duration = clampSessionDuration(sessionRow?.duration)
  const endedAt = sessionRow?.endedAt ? new Date(sessionRow.endedAt) : new Date()
  const next = {
    ...profile,
    totalWatchTime: Math.max(0, Math.floor(Number(profile.totalWatchTime) || 0) + duration),
    totalSessions: Math.max(0, Math.floor(Number(profile.totalSessions) || 0) + 1),
    streakCount: computeRollingStreak(profile.lastSessionAt, endedAt, profile.streakCount),
    lastSessionAt: endedAt,
  }

  const sessions = await listWatchSessionsForUser(targetUid, { limit: 240 })
  const prefs = buildPreferenceSnapshotFromSessions(sessions)
  next.preferences = prefs
  return saveProfile(next)
}

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
  if (getMongoConnected()) {
    await RelationshipModel.updateOne(
      { pairKey },
      { $set: payload }
    )
  } else {
    memoryStore.relationships.set(pairKey, getProfileStoreCopy(next))
  }

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

  await regenerateRelationshipInsight(next, endedAt.getUTCFullYear())
  return next
}

async function resolveRelationshipContextForSession(participants, roomType) {
  const users = uniqueStrings(Array.isArray(participants) ? participants : []).sort()
  if (users.length !== 2) {
    return {
      relationshipRow: null,
      relationshipId: '',
      relationshipType: relationshipTypeFromRoomType(roomType),
    }
  }

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

async function updateAnalyticsFromWatchSession(sessionRow) {
  if (!sessionRow) return
  const participants = uniqueStrings(sessionRow.participants || [])
  if (participants.length === 0) return

  await Promise.allSettled(participants.map((uid) => refreshUserAnalytics(uid, sessionRow)))

  if (participants.length === 2) {
    const relationship = await getRelationshipRow(participants[0], participants[1])
    if (relationship?.status === 'accepted') {
      await refreshRelationshipAnalytics(relationship, sessionRow)
    }
  }
}

function roomParticipantKey(roomCode, userId) {
  return `${String(roomCode || '').toUpperCase()}__${String(userId || '')}`
}

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

  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: payload.roomCode },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    )
    return RoomModel.findOne({ roomCode: payload.roomCode }).lean()
  }

  const existing = memoryStore.rooms.get(payload.roomCode)
  const next = {
    ...(existing || {}),
    ...payload,
    createdAt: existing?.createdAt || now,
  }
  memoryStore.rooms.set(payload.roomCode, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

async function markRoomInactive(roomCode) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return
  const now = new Date()

  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: { isActive: false, closedAt: now, lastActivityAt: now } }
    ).catch(() => {})
    return
  }

  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.isActive = false
  room.closedAt = now
  room.lastActivityAt = now
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

async function updateRoomContentState(roomCode, { contentUrl = '', contentType = 'unknown' } = {}) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return
  const updates = {
    contentUrl: sanitizeContentUrl(contentUrl),
    contentType: normalizeContentType(contentType),
    lastActivityAt: new Date(),
  }

  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {})
    return
  }

  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.contentUrl = updates.contentUrl
  room.contentType = updates.contentType
  room.lastActivityAt = updates.lastActivityAt
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

async function updateRoomCreator(roomCode, createdBy) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  const normalizedUid = String(createdBy || '').trim()
  if (!normalizedCode || !normalizedUid) return
  const updates = {
    createdBy: normalizedUid,
    lastActivityAt: new Date(),
  }

  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {})
    return
  }

  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.createdBy = normalizedUid
  room.lastActivityAt = updates.lastActivityAt
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

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

  if (getMongoConnected()) {
    await RoomModel.updateOne(
      { roomCode: normalizedCode },
      { $set: updates }
    ).catch(() => {})
    return
  }

  const room = memoryStore.rooms.get(normalizedCode)
  if (!room) return
  room.playbackStatus = updates.playbackStatus
  room.baseTime = updates.baseTime
  if (updates.startedAt) room.startedAt = updates.startedAt
  room.lastActivityAt = updates.lastActivityAt
  memoryStore.rooms.set(normalizedCode, getProfileStoreCopy(room))
}

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

  if (getMongoConnected()) {
    await RoomParticipantModel.updateOne(
      { roomCode: normalizedCode, userId: normalizedUid },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    )
    return RoomParticipantModel.findOne({ roomCode: normalizedCode, userId: normalizedUid }).lean()
  }

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

async function markRoomParticipantLeft(roomCode, userId) {
  return upsertRoomParticipant(roomCode, userId, {
    leftAt: new Date(),
    isActive: false,
  })
}

async function listDistinctParticipantsForRoom(roomCode, roomSnapshot = null) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return []

  const uids = new Set()
  if (roomSnapshot?.users instanceof Map) {
    roomSnapshot.users.forEach((_value, uid) => {
      if (uid) uids.add(String(uid))
    })
  }
  if (roomSnapshot?.joinedAtByUid instanceof Map) {
    roomSnapshot.joinedAtByUid.forEach((_value, uid) => {
      if (uid) uids.add(String(uid))
    })
  }

  const historicalRows = await listRoomParticipantsByCode(normalizedCode)
  historicalRows.forEach((row) => {
    if (row?.userId) uids.add(String(row.userId))
  })

  return uniqueStrings([...uids])
}

async function finalizeVideoSession(roomCode, roomSnapshot = null) {
  const normalizedCode = String(roomCode || '').trim().toUpperCase()
  if (!normalizedCode) return
  const endedAt = new Date()
  let videoSession = null

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

  const participants = await listDistinctParticipantsForRoom(normalizedCode, roomSnapshot)
  if (participants.length === 0) return null

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

  const [reactionRows, reactionsCount] = await Promise.all([
    listRoomReactions(normalizedCode, { startedAt, endedAt, limit: MAX_SESSION_HIGHLIGHTS }),
    countRoomReactions(normalizedCode, { startedAt, endedAt }),
  ])
  if (duration < 20 && reactionsCount === 0) return null
  const highlights = buildSessionHighlightsFromReactions(reactionRows)

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

  await attachSessionIdToRoomReactions({
    roomCode: normalizedCode,
    sessionId: sessionRow.id,
    startedAt,
    endedAt,
  })
  await updateAnalyticsFromWatchSession(sessionRow)

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
