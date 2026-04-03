/**
 * Handles memory statistics and shared-memory note endpoints.
 * Raw memory events accumulate watch time between two users, while shared
 * memories are authored notes that capture a meaningful moment from a session.
 */
'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const {
  addMemoryEvent, listMemoryEventsForUser,
  aggregateMemories, sanitizeSharedMemoryNote,
  sanitizeHighlightTimestamp, clampSharedSessionMinutes,
  clampReactionCount, createSharedMemory,
  listSharedMemoriesForUser,
} = require('../services/memory.service.js')
const {
  listProfilesByUids, publicProfile,
} = require('../services/profile.service.js')
const { getValidatedCoupleUsers } =
  require('../services/watchlist.service.js')
const { createNotification } =
  require('../services/notification.service.js')
const { logActivity } =
  require('../services/session.service.js')
const { uniqueStrings } =
  require('../utils/helpers.js')
const { normalizeSessionMode } =
  require('../utils/normalize.js')
const {
  sanitizeSharedMemoryGenre,
  sanitizeSharedMemoryMoodTag,
} = require('../utils/sanitize.js')
const { isOnlineVisible, socketIdsForUser } =
  require('../utils/presence.js')
const { getIo } =
  require('../sockets/socketHub.js')

/**
 * GET /api/memories
 * Returns aggregated memory totals for the authenticated user.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Summary watch-time totals plus per-friend breakdowns.
 */
router.get('/memories', requireHttpAuth, async (req, res) => {
  try {
    const events = await listMemoryEventsForUser(req.authUser.uid)
    const friendUids = uniqueStrings(events.flatMap((event) => event.users.filter((uid) => uid !== req.authUser.uid)))
    const friendProfiles = await listProfilesByUids(friendUids)
    const memories = aggregateMemories(req.authUser.uid, events, friendProfiles)
    return res.json(memories)
  } catch {
    return res.status(500).json({ error: 'Could not load memories' })
  }
})

/**
 * GET /api/shared-memories
 * Returns shared memory notes for the authenticated user, optionally filtered by partner.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Newest-first shared memory items enriched with partner identity and presence.
 */
router.get('/shared-memories', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || '').trim()
    const rows = await listSharedMemoriesForUser(req.authUser.uid, partnerUid)
    const otherUids = uniqueStrings(rows.flatMap((row) => [row.user1Id, row.user2Id]).filter((uid) => uid !== req.authUser.uid))
    const profiles = await listProfilesByUids(otherUids)
    const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]))

    // Serialize each memory with a compact partner payload instead of returning raw profile documents.
    const items = rows.map((row) => {
      const partnerId = row.user1Id === req.authUser.uid ? row.user2Id : row.user1Id
      const partner = profileByUid.get(partnerId)
      return {
        id: row.id,
        roomCode: row.roomCode || '',
        date: row.date,
        memoryNote: row.memoryNote,
        sessionMode: row.sessionMode || 'watch',
        genre: row.genre || '',
        moodTag: row.moodTag || '',
        highlightTimestamp: row.highlightTimestamp || '',
        sessionMinutes: clampSharedSessionMinutes(row.sessionMinutes),
        reactionCount: clampReactionCount(row.reactionCount),
        createdBy: row.createdBy || '',
        partner: partner
          ? {
            ...publicProfile(partner),
            online: isOnlineVisible(partner, req.authUser.uid),
          }
          : {
            uid: partnerId,
            username: '',
            displayName: 'Friend',
            photoURL: '',
            bio: '',
            online: false,
          },
      }
    })

    return res.json({ items })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not load shared memories' : (error.message || 'Could not load shared memories'),
    })
  }
})

/**
 * POST /api/shared-memories
 * Creates a new shared memory note between the caller and a partner.
 * @requires auth - Yes.
 * @body {string} partnerUid - The other participant in the memory.
 * @body {string} roomCode - Optional related room code.
 * @body {string} memoryNote - The authored note text.
 * @body {string} date - Optional memory date.
 * @body {string} sessionMode - The session mode for the memory.
 * @body {string} genre - Optional genre tag.
 * @body {string} moodTag - Optional mood tag.
 * @body {string} highlightTimestamp - Optional timestamp label.
 * @body {number} sessionMinutes - Session length in minutes.
 * @body {number} reactionCount - Number of reactions captured.
 * @returns {object} - The created shared-memory item with partner identity data.
 */
router.post('/shared-memories', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || '').trim()
    const roomCode = String(req.body?.roomCode || '').trim().toUpperCase()
    const memoryNote = sanitizeSharedMemoryNote(req.body?.memoryNote || '')
    const date = req.body?.date ? new Date(req.body.date) : new Date()
    const sessionMode = normalizeSessionMode(req.body?.sessionMode || 'watch')
    const genre = sanitizeSharedMemoryGenre(req.body?.genre || '')
    const moodTag = sanitizeSharedMemoryMoodTag(req.body?.moodTag || '')
    const highlightTimestamp = sanitizeHighlightTimestamp(req.body?.highlightTimestamp || '')
    const sessionMinutes = clampSharedSessionMinutes(req.body?.sessionMinutes)
    const reactionCount = clampReactionCount(req.body?.reactionCount)

    // Validate the required pair and note fields before creating the shared-memory record.
    if (!partnerUid) return res.status(400).json({ error: 'partnerUid is required' })
    if (!memoryNote) return res.status(400).json({ error: 'memoryNote is required' })

    const { me, partner } = await getValidatedCoupleUsers(req.authUser.uid, partnerUid)
    const row = await createSharedMemory({
      userA: req.authUser.uid,
      userB: partnerUid,
      roomCode,
      memoryNote,
      createdBy: req.authUser.uid,
      date,
      sessionMode,
      genre,
      moodTag,
      highlightTimestamp,
      sessionMinutes,
      reactionCount,
    })
    const io = getIo()

    // Record the authored shared memory in the caller's activity history.
    await logActivity({
      uid: req.authUser.uid,
      targetUid: partnerUid,
      roomCode,
      type: 'shared_memory_created',
      payload: {
        noteLength: memoryNote.length,
        sessionMode,
        genre,
        moodTag,
        hasHighlightTimestamp: !!highlightTimestamp,
        sessionMinutes,
        reactionCount,
      },
    })
    // Respect the partner's memoryNudges preference before sending notifications or socket pushes.
    if (partner.settings?.memoryNudges !== false) {
      await createNotification({
        recipientUid: partnerUid,
        senderUid: req.authUser.uid,
        type: 'shared_memory_added',
        referenceId: row.id,
        roomCode,
        payload: { noteLength: memoryNote.length },
        actionRequired: false,
      })

      socketIdsForUser(partnerUid).forEach((socketId) => {
        io?.to(socketId).emit('shared_memory_added', {
          fromUid: req.authUser.uid,
          fromUsername: me.username || '',
          fromName: me.displayName || '',
          roomCode,
        })
      })
    }
    // The addMemoryEvent argument order fix is `(uidA, uidB, seconds, roomCode)`.
    await addMemoryEvent(
      req.authUser.uid,
      partnerUid,
      Math.max(0, sessionMinutes * 60),
      roomCode
    ).catch(() => {})

    return res.status(201).json({
      item: {
        id: row.id,
        roomCode: row.roomCode,
        date: row.date,
        memoryNote: row.memoryNote,
        sessionMode: row.sessionMode || 'watch',
        genre: row.genre || '',
        moodTag: row.moodTag || '',
        highlightTimestamp: row.highlightTimestamp || '',
        sessionMinutes: clampSharedSessionMinutes(row.sessionMinutes),
        reactionCount: clampReactionCount(row.reactionCount),
        createdBy: row.createdBy,
        partner: {
          ...publicProfile(partner),
          online: isOnlineVisible(partner, req.authUser.uid),
        },
      },
    })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not create shared memory' : (error.message || 'Could not create shared memory'),
    })
  }
})

module.exports = router
