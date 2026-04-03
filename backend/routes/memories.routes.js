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

router.get('/shared-memories', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || '').trim()
    const rows = await listSharedMemoriesForUser(req.authUser.uid, partnerUid)
    const otherUids = uniqueStrings(rows.flatMap((row) => [row.user1Id, row.user2Id]).filter((uid) => uid !== req.authUser.uid))
    const profiles = await listProfilesByUids(otherUids)
    const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]))

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
