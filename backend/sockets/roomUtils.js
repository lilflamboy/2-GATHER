/**
 * Shared runtime helpers for 2-GATHER socket rooms. This file collects room
 * lifecycle helpers, user-management utilities, disconnect grace handling,
 * playback/read-state synchronization logic, and emit helpers used across the
 * room, video, and connection socket modules.
 */

'use strict'

const {
  rooms, pendingRoomUserDisconnects,
} = require('./roomStore.js')
const { getIo } =
  require('./socketHub.js')
const { log } =
  require('../utils/logger.js')
const {
  clampTime, deriveDocumentFileNameFromUrl,
  serializeRoomDocument, serializeReadingState,
} = require('../utils/helpers.js')
const {
  normalizeRoomType, normalizeSessionMode,
  resolveSessionEngine, normalizeContentType,
  normalizeRoomDocumentPayload,
} = require('../utils/normalize.js')
const {
  sanitizeRoomMoodTag, sanitizeContentUrl,
} = require('../utils/sanitize.js')
const {
  MAX_ROOM_USERS, ROOM_EXPIRY_MS,
  VIDEO_SCHEDULE_LEAD_MS, AUDIO_MUTATION_LOCK_MS,
  MEMBER_TIME_TTL_MS, SYNC_BUFFER_LOW_SECONDS,
  SYNC_WAIT_THRESHOLD, SYNC_NON_BUFFERING_EXTRA_GAP,
  SYNC_WAIT_COOLDOWN_MS, SYNC_WAIT_GRACE_MS,
  SYNC_RESUME_THRESHOLD, SYNC_RESUME_GRACE_MS,
  WATCH_MEMORY_MIN_SECONDS,
} = require('../config/constants.js')
const {
  markRoomInactive, finalizeVideoSession,
} = require('../services/room.service.js')
const { addMemoryEvent } =
  require('../services/memory.service.js')

/**
 * Builds the pending-disconnect map key for one room/user pair.
 * @param {string} roomCode - Room code that owns the disconnect timer.
 * @param {string} uid - User id the timer belongs to.
 * @returns {string} Stable `roomCode::uid` key for the pending timer map.
 */
function roomUserDisconnectKey(roomCode, uid) {
  return `${String(roomCode || '')}::${String(uid || '')}`
}

/**
 * Cancels one pending disconnect timer when a user reconnects in time.
 * @param {string} roomCode - Room code that owns the timer.
 * @param {string} uid - User id whose timer should be cancelled.
 * @returns {boolean} True when a pending timer existed and was cleared.
 */
function clearPendingRoomUserDisconnect(roomCode, uid) {
  const key = roomUserDisconnectKey(roomCode, uid)
  const pending = pendingRoomUserDisconnects.get(key)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingRoomUserDisconnects.delete(key)
  return true
}

/**
 * Cancels every pending disconnect timer associated with one room.
 * @param {string} roomCode - Room code whose pending disconnects should be cleared.
 * @returns {void}
 */
function clearPendingRoomDisconnects(roomCode) {
  const prefix = `${String(roomCode || '')}::`
  pendingRoomUserDisconnects.forEach((pending, key) => {
    if (!key.startsWith(prefix)) return
    clearTimeout(pending.timer)
    pendingRoomUserDisconnects.delete(key)
  })
}

/**
 * Schedules delayed user removal after a brief disconnect grace period.
 * @param {string} roomCode - Room code the disconnect belongs to.
 * @param {string} uid - User id that disconnected.
 * @param {number} graceMs - Grace period in milliseconds before cleanup runs.
 * @param {() => Promise<any> | any} callback - Cleanup callback executed if the user does not reconnect in time.
 * @returns {void}
 */
function schedulePendingRoomUserDisconnect(roomCode, uid, graceMs, callback) {
  const key = roomUserDisconnectKey(roomCode, uid)
  clearPendingRoomUserDisconnect(roomCode, uid)

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const timer = setTimeout(async () => {
    const latest = pendingRoomUserDisconnects.get(key)
    if (!latest || latest.token !== token) return
    pendingRoomUserDisconnects.delete(key)
    await callback()
  }, graceMs)
  timer.unref?.()

  pendingRoomUserDisconnects.set(key, { token, timer })
}

/**
 * Creates the full in-memory runtime room object used by the socket layer.
 * The returned object holds membership, chat, playback, sync-wait, reading,
 * document, timer, and history state for one live room code.
 * @param {string} roomCode - Unique short room code for the live room.
 * @param {object} [options={}] - Initial room creation options from the host.
 * @returns {object} Fully initialized live room object.
 */
function makeRoom(roomCode, options = {}) {
  const normalizedType = normalizeRoomType(options.roomType)
  const normalizedSessionMode = normalizeSessionMode(options.sessionMode)
  const sessionEngine = resolveSessionEngine(normalizedSessionMode)
  const normalizedMoodTag = sanitizeRoomMoodTag(options.moodTag || '')
  const normalizedMaxParticipants = Math.max(
    2,
    Math.min(10, Number(options.maxParticipants) || (normalizedType === 'duo' ? 2 : MAX_ROOM_USERS))
  )
  const initialDocument = normalizedSessionMode === 'reading' && options.contentUrl
    ? serializeRoomDocument(normalizeRoomDocumentPayload({
      fileUrl: options.contentUrl,
      fileName: options.fileName || deriveDocumentFileNameFromUrl(options.contentUrl) || 'shared-document.pdf',
      fileSize: options.fileSize || 0,
      mimeType: options.mimeType || (String(options.contentType || '').toLowerCase() === 'pdf' ? 'application/pdf' : ''),
      totalPages: options.totalPages || 0,
    }))
    : null
  const nowMs = Date.now()
  const initialContentUrl = sanitizeContentUrl(options.contentUrl || '')
  const initialContentType = normalizeContentType(options.contentType || 'unknown')
  // Build the canonical live room snapshot that all socket handlers mutate in memory.
  return {
    roomCode,
    roomType: normalizedType,
    sessionMode: normalizedSessionMode,
    sessionEngineId: sessionEngine.id,
    moodTag: normalizedMoodTag,
    createdBy: String(options.createdBy || ''),
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
      status: 'paused',
      startTime: 0,
      serverTime: nowMs,
      updatedAt: nowMs,
      playbackRate: 1,
      updatedBy: String(options.createdBy || ''),
    },
    mediaType: initialContentType === 'youtube' ? 'youtube' : 'local',
    mediaMeta: {
      fileSignature: String(options.fileFingerprint || ''),
      url: initialContentUrl,
    },
    mutationLock: 0,
    lastAudioActionAt: 0,
    readingState: {
      page: 1,
      totalPages: initialDocument?.totalPages || 0,
      updatedAt: nowMs,
      updatedBy: String(options.createdBy || ''),
    },
    document: initialDocument,
    readingMutationLockUntil: 0,
    messages: [],
    videoMetadata: null,
    contentUrl: initialContentUrl,
    contentType: initialContentType,
    playbackStatus: 'idle',
    baseTime: 0,
    startedAt: null,
    history: [],
    expiresAt: Date.now() + ROOM_EXPIRY_MS,
    expiryTimer: null,
  }
}

/**
 * Resolves the music-room media type from the normalized source information.
 * @param {string} sourceType - Declared content source type.
 * @param {string} [contentUrl=''] - Current shared media URL if present.
 * @returns {string} Normalized media type used by music sync payloads.
 */
function resolveMusicMediaType(sourceType, contentUrl = '') {
  if (normalizeContentType(sourceType) === 'youtube') return 'youtube'
  return String(contentUrl || '').trim() ? 'local' : 'local'
}

/**
 * Determines whether video playback should be scheduled slightly in the future.
 * @param {object} room - Live room whose source metadata is being evaluated.
 * @param {boolean} [isPlaying=false] - Whether the next state is intended to play.
 * @returns {boolean} True when scheduled playback should be used.
 */
function shouldScheduleVideoPlayback(room, isPlaying = false) {
  if (!room || !isPlaying) return false
  const sourceType = normalizeContentType(room?.videoMetadata?.sourceType || room?.contentType || '')
  return sourceType === 'youtube'
}

/**
 * Calculates the absolute future start time used for scheduled playback modes.
 * @param {object} room - Live room whose playback mode is being resolved.
 * @param {boolean} [isPlaying=false] - Whether the next state is intended to play.
 * @param {number} [nowSec=Date.now() / 1000] - Current server time in seconds.
 * @returns {number} Scheduled server start time in seconds, or 0 when unused.
 */
function getScheduledVideoStartAt(room, isPlaying = false, nowSec = Date.now() / 1000) {
  if (!shouldScheduleVideoPlayback(room, isPlaying)) return 0
  return nowSec + (VIDEO_SCHEDULE_LEAD_MS / 1000)
}

/**
 * Builds the canonical payload sent to music-room clients for audio sync.
 * @param {object} room - Live room whose audio state is being serialized.
 * @returns {object} Serialized music/media state payload for socket broadcasts.
 */
function buildRoomMusicStatePayload(room) {
  return {
    mediaType: String(room?.mediaType || 'local'),
    mediaMeta: {
      fileSignature: String(room?.mediaMeta?.fileSignature || ''),
      url: String(room?.mediaMeta?.url || ''),
    },
    audioState: {
      status: String(room?.audioState?.status || 'paused'),
      startTime: clampTime(Number(room?.audioState?.startTime) || 0),
      serverTime: Math.max(0, Number(room?.audioState?.serverTime) || Date.now()),
      updatedAt: Math.max(0, Number(room?.audioState?.updatedAt) || Date.now()),
      playbackRate: (typeof room?.audioState?.playbackRate === 'number' && room.audioState.playbackRate > 0)
        ? room.audioState.playbackRate
        : 1,
      updatedBy: String(room?.audioState?.updatedBy || ''),
    },
  }
}

/**
 * Resolves the current shared audio position from the last server-side audio state.
 * @param {object} room - Live room whose music playback state is being read.
 * @param {number} [nowMs=Date.now()] - Current server timestamp in milliseconds.
 * @returns {number} Current audio position clamped into the allowed media range.
 */
function resolveRoomAudioPosition(room, nowMs = Date.now()) {
  const state = room?.audioState || {}
  const baseTime = clampTime(Number(state.startTime) || 0)
  if (String(state.status || 'paused') !== 'playing') return baseTime
  const serverTimeMs = Math.max(0, Number(state.serverTime) || nowMs)
  const elapsedSeconds = Math.max(0, (nowMs - serverTimeMs) / 1000)
  return clampTime(baseTime + elapsedSeconds)
}

/**
 * Acquires the short-lived mutation lock used to serialize audio state changes.
 * @param {object} room - Live room attempting to mutate audio playback.
 * @returns {boolean} True when the caller acquired the lock.
 */
function acquireAudioMutationLock(room) {
  if (!room) return false
  const nowMs = Date.now()
  if (Number(room.mutationLock) > nowMs) return false
  room.mutationLock = nowMs + AUDIO_MUTATION_LOCK_MS
  return true
}

/**
 * Validates whether a music control request can change the shared room state.
 * @param {object} room - Live room being controlled.
 * @param {string} [requesterFileSignature=''] - Local file signature supplied by the client.
 * @returns {{ ok: boolean, error?: string }} Validation result for the control request.
 */
function validateMusicControlRequest(room, requesterFileSignature = '') {
  if (!room) return { ok: false, error: 'Room not found' }
  if (room.sessionMode !== 'music') return { ok: false, error: 'Room is not in music mode' }
  const expectedSignature = String(room.mediaMeta?.fileSignature || '')
  if (room.mediaType === 'local' && expectedSignature) {
    const normalizedSignature = String(requesterFileSignature || '').trim()
    if (!normalizedSignature || normalizedSignature !== expectedSignature) {
      return { ok: false, error: 'Load the matching local audio file before controlling playback' }
    }
  }
  return { ok: true }
}

/**
 * Broadcasts the authoritative audio/music sync payload to everyone in a room.
 * @param {object} room - Live room whose audio state should be emitted.
 * @param {object} [options={}] - Additional broadcast metadata such as action labels.
 * @returns {void}
 */
function broadcastRoomAudioSync(room, options = {}) {
  if (!room?.roomCode) return
  const io = getIo()
  const payload = {
    ...buildRoomMusicStatePayload(room),
    action: String(options.action || ''),
    triggeredBy: String(options.triggeredBy || ''),
    serverNow: Date.now(),
    hardSync: options.hardSync === true,
  }
  io.to(room.roomCode).emit('audio_sync', payload)
}

/**
 * Serializes the reading-state slice of one live room for socket payloads.
 * @param {object} room - Live room whose reading state is being serialized.
 * @returns {object} Normalized reading state payload.
 */
function getRoomReadingStatePayload(room) {
  return serializeReadingState(room?.readingState || {}, room?.document || null)
}

/**
 * Serializes the shared document slice of one live room for socket payloads.
 * @param {object} room - Live room whose document state is being serialized.
 * @returns {object | null} Normalized document payload or null.
 */
function getRoomDocumentPayload(room) {
  return serializeRoomDocument(room?.document || null)
}

/**
 * Builds the initial co-reading state payload sent after joins and document changes.
 * @param {object} room - Live room whose reading snapshot is being built.
 * @returns {object} Initial reading payload including document, page, and host id.
 */
function buildReadingInitialStatePayload(room) {
  const readingState = getRoomReadingStatePayload(room)
  return {
    document: getRoomDocumentPayload(room),
    page: readingState.page,
    totalPages: readingState.totalPages,
    readingState,
    hostId: String(room?.createdBy || ''),
  }
}

/**
 * Chooses the next host by earliest join time among the remaining room members.
 * @param {object} room - Live room whose ownership may need to transfer.
 * @returns {string} Next host uid or an empty string when no users remain.
 */
function pickNextRoomHostUid(room) {
  if (!room?.users || room.users.size === 0) return ''
  return [...room.users.keys()]
    .sort((uidA, uidB) => {
      const joinedAtA = Number(room.joinedAtByUid?.get(uidA) || 0)
      const joinedAtB = Number(room.joinedAtByUid?.get(uidB) || 0)
      return joinedAtA - joinedAtB
    })[0] || ''
}

/**
 * Normalizes a room user's socket storage into a Set for multi-tab support.
 * @param {object} roomUser - Live room-user record.
 * @returns {Set<string>} Mutable socket-id set for the user.
 */
function ensureRoomUserSocketSet(roomUser) {
  if (!roomUser) return new Set()
  if (roomUser.socketIds instanceof Set) return roomUser.socketIds

  const set = new Set()
  if (Array.isArray(roomUser.socketIds)) {
    roomUser.socketIds.forEach((socketId) => {
      if (typeof socketId === 'string' && socketId) set.add(socketId)
    })
  } else if (typeof roomUser.socketId === 'string' && roomUser.socketId) {
    set.add(roomUser.socketId)
  }

  roomUser.socketIds = set
  return set
}

/**
 * Returns every active socket id currently attached to one room user.
 * @param {object} roomUser - Live room-user record.
 * @returns {string[]} Array of active socket ids for that user.
 */
function getRoomUserSocketIds(roomUser) {
  if (!roomUser) return []
  return [...ensureRoomUserSocketSet(roomUser)]
}

/**
 * Inserts or refreshes one room user, supporting reconnects and multiple tabs.
 * @param {object} room - Live room receiving the user.
 * @param {object} userIdentity - Authenticated identity snapshot for the user.
 * @param {string} socketId - Current socket id being attached.
 * @returns {{ user: object, isRejoin: boolean, hadActiveSocketsBefore: boolean }} Result describing whether this was a rejoin.
 */
function upsertRoomUser(room, userIdentity, socketId) {
  const existing = room.users.get(userIdentity.uid)
  if (existing) {
    const hadActiveSocketsBefore = getRoomUserSocketIds(existing).length > 0
    existing.name = userIdentity.name
    existing.username = userIdentity.username
    existing.photoURL = userIdentity.photoURL
    const sockets = ensureRoomUserSocketSet(existing)
    sockets.add(socketId)
    existing.socketId = socketId
    return {
      user: existing,
      isRejoin: true,
      hadActiveSocketsBefore,
    }
  }

  const roomUser = {
    uid: userIdentity.uid,
    name: userIdentity.name,
    username: userIdentity.username,
    photoURL: userIdentity.photoURL,
    socketIds: new Set([socketId]),
    socketId,
  }
  room.users.set(userIdentity.uid, roomUser)
  return {
    user: roomUser,
    isRejoin: false,
    hadActiveSocketsBefore: false,
  }
}

/**
 * Removes one socket id from a room user while preserving other live tabs.
 * @param {object} room - Live room containing the user.
 * @param {string} uid - User id being updated.
 * @param {string} socketId - Socket id that disconnected.
 * @returns {{ roomUser: object | null, activeSocketCount: number }} Updated room-user state and remaining socket count.
 */
function removeSocketFromRoomUser(room, uid, socketId) {
  const roomUser = room.users.get(uid)
  if (!roomUser) return { roomUser: null, activeSocketCount: 0 }

  const sockets = ensureRoomUserSocketSet(roomUser)
  sockets.delete(socketId)
  roomUser.socketId = sockets.size > 0 ? [...sockets][0] : null

  return {
    roomUser,
    activeSocketCount: sockets.size,
  }
}

/**
 * Emits one socket event to every active socket owned by a room user.
 * @param {object} roomUser - Room user whose sockets should receive the event.
 * @param {string} eventName - Socket event name to emit.
 * @param {object} payload - Event payload to send.
 * @returns {void}
 */
function emitToRoomUserSockets(roomUser, eventName, payload) {
  const io = getIo()
  getRoomUserSocketIds(roomUser).forEach((socketId) => {
    io.to(socketId).emit(eventName, payload)
  })
}

/**
 * Emits one socket event to every active socket for a specific uid in a room.
 * This is used because one user may have multiple tabs connected at once.
 * @param {object} room - Live room containing the target user.
 * @param {string} targetUid - User id whose sockets should receive the event.
 * @param {string} eventName - Socket event name to emit.
 * @param {object} payload - Event payload to send.
 * @returns {number} Number of sockets that received the event.
 */
function emitToUidSocketsInRoom(room, targetUid, eventName, payload) {
  const target = room.users.get(targetUid)
  if (!target) return 0

  const io = getIo()
  const socketIds = getRoomUserSocketIds(target)
  socketIds.forEach((socketId) => {
    io.to(socketId).emit(eventName, payload)
  })
  return socketIds.length
}

/**
 * Schedules the room-expiry timeout for one live room.
 * @param {object} room - Live room whose expiry timer should be refreshed.
 * @returns {void}
 */
function scheduleExpiry(room) {
  if (!room) return
  clearTimeout(room.expiryTimer)
  room.expiryTimer = setTimeout(() => expireRoom(room.roomCode), ROOM_EXPIRY_MS)
}

/**
 * Expires a live room, broadcasts closure, cleans timers, and finalizes any
 * room/session persistence side effects before deleting the runtime room object.
 * @param {string} roomCode - Room code to expire.
 * @returns {void}
 */
function expireRoom(roomCode) {
  const room = rooms.get(roomCode)
  if (!room) return
  clearTimeout(room.expiryTimer)
  clearPendingRoomDisconnects(roomCode)
  const io = getIo()
  io.to(roomCode).emit('room_expired')
  io.in(roomCode).socketsLeave(roomCode)
  rooms.delete(roomCode)
  markRoomInactive(roomCode).catch(() => {})
  finalizeVideoSession(roomCode, room).catch(() => {})
  log(`[expired] ${roomCode}`)
}

/**
 * Deletes a room only when no members remain, preserving empty-room cleanup semantics.
 * @param {string} roomCode - Room code that may now be empty.
 * @returns {void}
 */
function deleteIfEmpty(roomCode) {
  const room = rooms.get(roomCode)
  if (room && room.users.size === 0) {
    clearTimeout(room.expiryTimer)
    clearPendingRoomDisconnects(roomCode)
    rooms.delete(roomCode)
    markRoomInactive(roomCode).catch(() => {})
    finalizeVideoSession(roomCode, room).catch(() => {})
  }
}

/**
 * Generates a human-friendly room code that avoids ambiguous characters.
 * @returns {string} Unique six-character room code not currently used in memory.
 */
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  } while (rooms.has(code))
  return code
}

/**
 * Serializes the current room user map into the public socket payload shape.
 * @param {object} room - Live room whose user list should be serialized.
 * @returns {Array<{ uid: string, name: string, username: string, photoURL: string }>} Public member list.
 */
function getUserList(room) {
  return [...room.users.values()].map(({ uid, name, username, photoURL }) => ({ uid, name, username, photoURL }))
}

/**
 * Clears the active sync-wait state and resumes any members who were paused.
 * @param {string} roomCode - Room code whose wait-mode should be cleared.
 * @returns {void}
 */
function clearSyncWait(roomCode) {
  const room = rooms.get(roomCode)
  if (!room) return
  if (!room.syncWait.active) {
    room.syncWait.candidateUid = null
    room.syncWait.candidateSince = 0
    room.syncWait.resumeSince = 0
    return
  }

  const { waitingForUid, waitingForUsername } = room.syncWait
  room.syncWait.pausedUids.forEach((pausedUid) => {
    const pausedUser = room.users.get(pausedUid)
    if (pausedUser) {
      emitToRoomUserSockets(pausedUser, 'resume_sync_wait', {
        waitForUid: waitingForUid,
        waitForUsername: waitingForUsername,
      })
    }
  })

  room.syncWait.active = false
  room.syncWait.waitingForUid = null
  room.syncWait.waitingForUsername = null
  room.syncWait.pausedUids.clear()
  room.syncWait.candidateUid = null
  room.syncWait.candidateSince = 0
  room.syncWait.resumeSince = 0
  room.syncWait.lastClearedAt = Date.now()
  const io = getIo()
  io.to(roomCode).emit('sync_waiting_resolved', {
    waitForUid: waitingForUid,
    waitForUsername: waitingForUsername,
  })
}

/**
 * Returns recent per-member playback samples used to detect sync drift.
 * @param {object} room - Live room whose member heartbeat samples are being read.
 * @returns {Array<object>} Active member playback samples after stale entries are removed.
 */
function getActiveMemberTimes(room) {
  const now = Date.now()
  const members = []

  room.memberTimes.forEach((value, uid) => {
    const user = room.users.get(uid)
    const hasSockets = user && getRoomUserSocketIds(user).length > 0
    if (!hasSockets || (now - value.updatedAt) > MEMBER_TIME_TTL_MS || !Number.isFinite(value.time)) {
      room.memberTimes.delete(uid)
      return
    }

    const rawBufferAhead = Number(value.bufferAhead)
    const rawReadyState = Number(value.readyState)
    members.push({
      uid,
      time: clampTime(value.time),
      username: value.username || user.username || user.name || 'friend',
      bufferAhead: Number.isFinite(rawBufferAhead)
        ? Math.max(0, Math.min(120, rawBufferAhead))
        : null,
      readyState: Number.isFinite(rawReadyState)
        ? Math.max(0, Math.min(4, Math.floor(rawReadyState)))
        : null,
      isBuffering: value.isBuffering === true,
    })
  })

  return members
}

/**
 * Heuristic that estimates whether one member is buffering or otherwise unable to keep up.
 * @param {object} member - Member playback sample from `getActiveMemberTimes`.
 * @returns {boolean} True when the member likely needs wait-mode protection.
 */
function isMemberLikelyBuffering(member) {
  if (!member) return false
  if (member.isBuffering) return true

  const hasBufferAhead = Number.isFinite(member.bufferAhead)
  const hasReadyState = Number.isFinite(member.readyState)
  if (!hasBufferAhead && !hasReadyState) return false

  const lowBufferAhead = hasBufferAhead ? member.bufferAhead < SYNC_BUFFER_LOW_SECONDS : false
  const lowReadyState = hasReadyState ? member.readyState > 0 && member.readyState < 3 : false
  if (lowBufferAhead) return true
  return lowReadyState && !hasBufferAhead
}

/**
 * Evaluates playback drift across room members and drives the sync-wait algorithm.
 * When the fastest and slowest members diverge beyond threshold, faster members
 * are temporarily paused until the lagging member catches back up.
 * @param {string} roomCode - Room code whose sync-wait state should be updated.
 * @returns {void}
 */
function handleSyncWait(roomCode) {
  const room = rooms.get(roomCode)
  if (!room) return
  const now = Date.now()
  if (!(room.syncWait.pausedUids instanceof Set)) {
    room.syncWait.pausedUids = new Set(room.syncWait.pausedUids || [])
  }
  if (!Number.isFinite(Number(room.syncWait.candidateSince))) room.syncWait.candidateSince = 0
  if (!Number.isFinite(Number(room.syncWait.resumeSince))) room.syncWait.resumeSince = 0
  if (!Number.isFinite(Number(room.syncWait.lastClearedAt))) room.syncWait.lastClearedAt = 0
  if (typeof room.syncWait.candidateUid !== 'string') room.syncWait.candidateUid = null

  const members = getActiveMemberTimes(room)
  if (members.length < 2) {
    room.syncWait.candidateUid = null
    room.syncWait.candidateSince = 0
    room.syncWait.resumeSince = 0
    clearSyncWait(roomCode)
    return
  }

  let slowest = members[0]
  let fastest = members[0]
  members.forEach((member) => {
    if (member.time < slowest.time) slowest = member
    if (member.time > fastest.time) fastest = member
  })

  const gap = Math.max(0, fastest.time - slowest.time)
  if (!room.syncWait.active) {
    // Wait-mode only activates after the gap stays large enough for the full grace window.
    if (gap < SYNC_WAIT_THRESHOLD) {
      room.syncWait.candidateUid = null
      room.syncWait.candidateSince = 0
      return
    }
    if ((now - room.syncWait.lastClearedAt) < SYNC_WAIT_COOLDOWN_MS) {
      room.syncWait.candidateUid = null
      room.syncWait.candidateSince = 0
      return
    }

    const slowestLikelyBuffering = isMemberLikelyBuffering(slowest)
    const activationThreshold = slowestLikelyBuffering
      ? SYNC_WAIT_THRESHOLD
      : (SYNC_WAIT_THRESHOLD + SYNC_NON_BUFFERING_EXTRA_GAP)
    if (gap < activationThreshold) {
      room.syncWait.candidateUid = null
      room.syncWait.candidateSince = 0
      return
    }

    if (room.syncWait.candidateUid !== slowest.uid) {
      room.syncWait.candidateUid = slowest.uid
      room.syncWait.candidateSince = now
      return
    }
    if ((now - room.syncWait.candidateSince) < SYNC_WAIT_GRACE_MS) return

    room.syncWait.active = true
    room.syncWait.waitingForUid = slowest.uid
    room.syncWait.waitingForUsername = slowest.username || 'friend'
    room.syncWait.pausedUids.clear()
    room.syncWait.resumeSince = 0
  }

  const waitingUid = room.syncWait.waitingForUid
  const waitingMember = members.find((member) => member.uid === waitingUid)
  if (!waitingMember) {
    clearSyncWait(roomCode)
    return
  }

  const waitingForUsername = waitingMember.username || room.syncWait.waitingForUsername || 'friend'
  room.syncWait.waitingForUsername = waitingForUsername

  // Compare everyone against the waiting member to decide who should pause and when wait-mode can clear.
  let maxGapFromWaiting = 0
  const shouldBePaused = new Set()
  const pauseThreshold = room.syncWait.active ? SYNC_RESUME_THRESHOLD : SYNC_WAIT_THRESHOLD
  members.forEach((member) => {
    if (member.uid === waitingUid) return
    const memberGap = Math.max(0, member.time - waitingMember.time)
    maxGapFromWaiting = Math.max(maxGapFromWaiting, memberGap)
    if (memberGap >= pauseThreshold) {
      shouldBePaused.add(member.uid)
    }
  })

  ;[...room.syncWait.pausedUids].forEach((pausedUid) => {
    if (shouldBePaused.has(pausedUid)) return
    const pausedUser = room.users.get(pausedUid)
    if (pausedUser) {
      emitToRoomUserSockets(pausedUser, 'resume_sync_wait', {
        waitForUid: waitingUid,
        waitForUsername: waitingForUsername,
      })
    }
    room.syncWait.pausedUids.delete(pausedUid)
  })

  shouldBePaused.forEach((pausedUid) => {
    if (room.syncWait.pausedUids.has(pausedUid)) return
    const pausedUser = room.users.get(pausedUid)
    if (pausedUser) {
      emitToRoomUserSockets(pausedUser, 'force_sync_wait', {
        waitForUid: waitingUid,
        waitForUsername: waitingForUsername,
      })
      room.syncWait.pausedUids.add(pausedUid)
    }
  })

  const io = getIo()
  io.to(roomCode).emit('sync_waiting', {
    waitForUid: waitingUid,
    waitForUsername: waitingForUsername,
    gap: Number(maxGapFromWaiting.toFixed(2)),
  })

  if (maxGapFromWaiting <= SYNC_RESUME_THRESHOLD) {
    if (!room.syncWait.resumeSince) room.syncWait.resumeSince = now
    if ((now - room.syncWait.resumeSince) >= SYNC_RESUME_GRACE_MS) {
      clearSyncWait(roomCode)
    }
    return
  }
  room.syncWait.resumeSince = 0
}

/**
 * Records shared overlap time between a disconnecting user and the members still in the room.
 * @param {object} room - Live room being left.
 * @param {string} leavingUid - User id that is leaving.
 * @param {string} roomCode - Room code used for memory-event attribution.
 * @returns {Promise<void>} Resolves after memory-event writes have been attempted.
 */
async function recordOverlapForLeavingUser(room, leavingUid, roomCode) {
  if (typeof addMemoryEvent !== 'function') return
  const leftAt = Date.now()
  const leavingJoinedAt = room.joinedAtByUid.get(leavingUid)
  if (!leavingJoinedAt) return

  const tasks = []
  room.joinedAtByUid.forEach((otherJoinedAt, otherUid) => {
    if (otherUid === leavingUid) return
    if (!room.users.has(otherUid)) return

    const overlapMs = leftAt - Math.max(leavingJoinedAt, otherJoinedAt)
    const overlapSeconds = Math.floor(overlapMs / 1000)
    if (overlapSeconds >= WATCH_MEMORY_MIN_SECONDS) {
      tasks.push(addMemoryEvent(leavingUid, otherUid, overlapSeconds, roomCode))
    }
  })

  if (tasks.length > 0) {
    await Promise.allSettled(tasks)
  }
}

module.exports = {
  roomUserDisconnectKey,
  clearPendingRoomUserDisconnect,
  clearPendingRoomDisconnects,
  schedulePendingRoomUserDisconnect,
  makeRoom,
  resolveMusicMediaType,
  shouldScheduleVideoPlayback,
  getScheduledVideoStartAt,
  buildRoomMusicStatePayload,
  resolveRoomAudioPosition,
  acquireAudioMutationLock,
  validateMusicControlRequest,
  broadcastRoomAudioSync,
  getRoomReadingStatePayload,
  getRoomDocumentPayload,
  buildReadingInitialStatePayload,
  pickNextRoomHostUid,
  ensureRoomUserSocketSet,
  getRoomUserSocketIds,
  upsertRoomUser,
  removeSocketFromRoomUser,
  emitToRoomUserSockets,
  emitToUidSocketsInRoom,
  scheduleExpiry,
  expireRoom,
  deleteIfEmpty,
  generateCode,
  getUserList,
  clearSyncWait,
  getActiveMemberTimes,
  isMemberLikelyBuffering,
  handleSyncWait,
  recordOverlapForLeavingUser,
}
