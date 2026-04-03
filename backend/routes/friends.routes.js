'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const {
  sendFriendRequest, respondFriendRequest,
  listFriendGraph, listRelationshipRowsForUser,
} = require('../services/friends.service.js')
const {
  listProfilesByUids, publicProfile,
  getProfileByUid,
} = require('../services/profile.service.js')
const {
  createNotification, markNotificationsReadByReference,
} = require('../services/notification.service.js')
const { logActivity } =
  require('../services/session.service.js')
const { createInviteRecord } =
  require('../services/invite.service.js')
const {
  pairKeyFromUsers, getRelationshipRow,
  setRelationshipType, normalizeRelationshipType,
} = require('../services/relationship.service.js')
const { normalizeSessionMode } =
  require('../utils/normalize.js')
const { uniqueStrings } =
  require('../utils/helpers.js')
const { isOnline, socketIdsForUser } =
  require('../utils/presence.js')
const { getIo } =
  require('../realtime/socketHub.js')

router.get('/friends', requireHttpAuth, async (req, res) => {
  const [me, friendGraph] = await Promise.all([
    getProfileByUid(req.authUser.uid),
    listFriendGraph(req.authUser.uid),
  ])
  if (!me) return res.status(404).json({ error: 'Profile not found' })

  const [friends, incoming, outgoing] = await Promise.all([
    listProfilesByUids(friendGraph.friends),
    listProfilesByUids(friendGraph.incomingRequests),
    listProfilesByUids(friendGraph.outgoingRequests),
  ])

  const withPresence = (profile) => ({
    ...publicProfile(profile),
    online: isOnline(profile.uid),
  })

  return res.json({
    friends: friends.map(withPresence),
    incomingRequests: incoming.map(withPresence),
    outgoingRequests: outgoing.map(withPresence),
  })
})

router.post('/friends/request', requireHttpAuth, async (req, res) => {
  try {
    const targetUid = String(req.body?.targetUid || '').trim()
    const result = await sendFriendRequest(req.authUser.uid, targetUid)
    const io = getIo()

    if (result.status === 'requested') {
      const referenceId = pairKeyFromUsers(req.authUser.uid, targetUid) || ''
      await createNotification({
        recipientUid: targetUid,
        senderUid: req.authUser.uid,
        type: 'friend_request',
        referenceId,
        payload: { status: 'pending' },
        actionRequired: true,
      })
      socketIdsForUser(targetUid).forEach((socketId) => {
        io?.to(socketId).emit('friend_request_received', {
          from: publicProfile(result.from),
        })
      })
    }

    await logActivity({
      uid: req.authUser.uid,
      targetUid,
      type: 'friend_request_sent',
      payload: { status: result.status },
    })

    return res.json({ status: result.status })
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not send request' })
  }
})

router.post('/friends/respond', requireHttpAuth, async (req, res) => {
  try {
    const requesterUid = String(req.body?.requesterUid || '').trim()
    const action = String(req.body?.action || '').trim()
    const result = await respondFriendRequest(req.authUser.uid, requesterUid, action)
    const referenceId = pairKeyFromUsers(req.authUser.uid, requesterUid) || ''
    const io = getIo()

    await markNotificationsReadByReference({
      recipientUid: req.authUser.uid,
      type: 'friend_request',
      referenceId,
    })

    socketIdsForUser(requesterUid).forEach((socketId) => {
      io?.to(socketId).emit('friend_request_updated', {
        fromUid: req.authUser.uid,
        action,
      })
    })

    if (action === 'accept') {
      const mePublic = publicProfile(result.target)
      await createNotification({
        recipientUid: requesterUid,
        senderUid: req.authUser.uid,
        type: 'friend_request_accepted',
        referenceId,
        payload: { action: 'accept' },
        actionRequired: false,
      })
      socketIdsForUser(requesterUid).forEach((socketId) => {
        io?.to(socketId).emit('friend_added', { friend: mePublic })
      })
    } else {
      await createNotification({
        recipientUid: requesterUid,
        senderUid: req.authUser.uid,
        type: 'friend_request_rejected',
        referenceId,
        payload: { action: 'reject' },
        actionRequired: false,
      })
    }

    await logActivity({
      uid: req.authUser.uid,
      targetUid: requesterUid,
      type: action === 'accept' ? 'friend_request_accepted' : 'friend_request_rejected',
      payload: { action },
    })

    return res.json({ status: action })
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not respond to request' })
  }
})

router.post('/friends/invite-room', requireHttpAuth, async (req, res) => {
  try {
    const friendUid = String(req.body?.friendUid || '').trim()
    const roomCode = String(req.body?.roomCode || '').trim().toUpperCase()
    if (!friendUid || !roomCode) {
      return res.status(400).json({ error: 'friendUid and roomCode are required' })
    }

    const [me, friend] = await Promise.all([
      getProfileByUid(req.authUser.uid),
      getProfileByUid(friendUid),
    ])
    const friendGraph = await listFriendGraph(req.authUser.uid)
    if (!me || !friendGraph.friends.includes(friendUid)) {
      return res.status(403).json({ error: 'You can invite only friends' })
    }
    if (!friend) {
      return res.status(404).json({ error: 'Friend not found' })
    }
    if (friend.settings?.inviteNotifications === false) {
      return res.json({ delivered: false, deliveries: 0, mutedByFriend: true })
    }

    const sockets = socketIdsForUser(friendUid)
    const io = getIo()
    await createInviteRecord({
      fromUid: req.authUser.uid,
      toUid: friendUid,
      roomCode,
      status: 'sent',
    })
    await createNotification({
      recipientUid: friendUid,
      senderUid: req.authUser.uid,
      type: 'room_invite',
      referenceId: roomCode,
      roomCode,
      payload: {
        fromUsername: me.username || '',
        fromName: me.displayName || '',
      },
      actionRequired: true,
    })
    sockets.forEach((socketId) => {
      io?.to(socketId).emit('friend_invite', {
        fromUid: req.authUser.uid,
        fromUsername: me.username || '',
        fromName: me.displayName,
        fromPhotoURL: me.photoURL || '',
        roomCode,
        timestamp: Date.now(),
      })
    })

    await logActivity({
      uid: req.authUser.uid,
      targetUid: friendUid,
      roomCode,
      type: 'room_invite_sent',
      payload: { deliveries: sockets.length },
    })

    return res.json({ delivered: sockets.length > 0, deliveries: sockets.length })
  } catch {
    return res.status(500).json({ error: 'Could not send invite' })
  }
})

router.get('/relationships', requireHttpAuth, async (req, res) => {
  try {
    const uid = req.authUser.uid
    const rows = await listRelationshipRowsForUser(uid)

    const partnerUids = uniqueStrings(rows.map((row) => row.users.find((item) => item !== uid)).filter(Boolean))
    const partnerProfiles = await listProfilesByUids(partnerUids)
    const profileByUid = new Map(partnerProfiles.map((profile) => [profile.uid, profile]))

    const relationships = rows.map((row) => {
      const partnerUid = row.users.find((item) => item !== uid) || ''
      const partner = profileByUid.get(partnerUid)
      return {
        pairKey: row.pairKey,
        status: row.status,
        relationshipType: normalizeRelationshipType(row.relationshipType || 'friends'),
        requestedBy: row.requestedBy || '',
        lastActionBy: row.lastActionBy || '',
        lastActionAt: row.lastActionAt || row.updatedAt || row.createdAt || new Date(),
        totalWatchTime: Math.max(0, Number(row.totalWatchTime) || 0),
        totalSessions: Math.max(0, Number(row.totalSessions) || 0),
        longestSession: Math.max(0, Number(row.longestSession) || 0),
        streak: Math.max(0, Number(row.streak) || 0),
        firstWatchedAt: row.firstWatchedAt || null,
        lastWatchedAt: row.lastWatchedAt || null,
        lastSessionMode: normalizeSessionMode(row.lastSessionMode || 'watch'),
        topGenres: uniqueStrings(Array.isArray(row.topGenres) ? row.topGenres : []),
        activeTimeSlots: uniqueStrings(Array.isArray(row.activeTimeSlots) ? row.activeTimeSlots : []),
        partner: partner
          ? {
            ...publicProfile(partner),
            online: isOnline(partner.uid),
          }
          : {
            uid: partnerUid,
            username: '',
            displayName: 'Friend',
            photoURL: '',
            bio: '',
            online: false,
          },
      }
    })

    return res.json({ relationships })
  } catch {
    return res.status(500).json({ error: 'Could not load relationships' })
  }
})

router.patch('/relationships/tag', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || '').trim()
    const relationshipType = normalizeRelationshipType(req.body?.relationshipType || 'friends', 'friends')
    if (!partnerUid) {
      return res.status(400).json({ error: 'partnerUid is required' })
    }
    if (partnerUid === req.authUser.uid) {
      return res.status(400).json({ error: 'Cannot tag relationship with self' })
    }

    const row = await getRelationshipRow(req.authUser.uid, partnerUid)
    if (!row || row.status !== 'accepted') {
      return res.status(403).json({ error: 'Only accepted relationships can be tagged' })
    }

    const updated = await setRelationshipType(req.authUser.uid, partnerUid, relationshipType, req.authUser.uid)
    if (!updated) {
      return res.status(500).json({ error: 'Could not update relationship tag' })
    }

    await logActivity({
      uid: req.authUser.uid,
      targetUid: partnerUid,
      type: 'relationship_tag_updated',
      payload: { relationshipType },
    })

    const io = getIo()
    socketIdsForUser(partnerUid).forEach((socketId) => {
      io?.to(socketId).emit('relationship_tag_updated', {
        uid: req.authUser.uid,
        partnerUid,
        relationshipType,
      })
    })

    return res.json({
      relationship: {
        pairKey: updated.pairKey,
        relationshipType: normalizeRelationshipType(updated.relationshipType || relationshipType, 'friends'),
        status: updated.status || 'accepted',
      },
    })
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not update relationship tag' })
  }
})

module.exports = router
