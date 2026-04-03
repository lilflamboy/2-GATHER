/**
 * Handles friendship, relationship, and room-invite routes.
 * The friend graph model tracks confirmed friends, incoming requests,
 * outgoing requests, blocked relationships, and pair-level relationship tags.
 */
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
const { isOnlineVisible, socketIdsForUser } =
  require('../utils/presence.js')
const { getIo } =
  require('../sockets/socketHub.js')
const { rooms } =
  require('../sockets/roomStore.js')

/**
 * GET /api/friends
 * Returns the authenticated user's friend graph grouped by friends and requests.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Friends, incoming requests, and outgoing requests with privacy-aware online status.
 */
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

  /**
   * Adds privacy-aware presence data to a public profile.
   * @param {object} profile - The stored friend profile.
   * @returns {object} The public profile plus online visibility state.
   */
  const withPresence = (profile) => ({
    ...publicProfile(profile),
    online: isOnlineVisible(profile, req.authUser.uid),
  })

  return res.json({
    friends: friends.map(withPresence),
    incomingRequests: incoming.map(withPresence),
    outgoingRequests: outgoing.map(withPresence),
  })
})

/**
 * POST /api/friends/request
 * Sends a friend request or reports the current relationship state.
 * @requires auth - Yes.
 * @body {string} targetUid - The user to be friended.
 * @returns {object} - A status describing whether the request was created, already exists, or needs acceptance.
 */
router.post('/friends/request', requireHttpAuth, async (req, res) => {
  try {
    const targetUid = String(req.body?.targetUid || '').trim()
    const result = await sendFriendRequest(req.authUser.uid, targetUid)
    const io = getIo()

    // New pending requests create a durable notification and a real-time socket event for the target user.
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

    // Record the social action for the caller's activity timeline.
    await logActivity({
      uid: req.authUser.uid,
      targetUid,
      type: 'friend_request_sent',
      payload: { status: result.status },
    })

    return res.json({ status: result.status })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not send request' : (error.message || 'Could not send request'),
    })
  }
})

/**
 * POST /api/friends/respond
 * Accepts or rejects an incoming friend request.
 * @requires auth - Yes.
 * @body {string} requesterUid - The original requester.
 * @body {string} action - Either `accept` or `reject`.
 * @returns {object} - A status confirming which action was applied.
 */
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

    // Accepted requests also create a persistent acceptance notification and friend-added socket event.
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

    // Record the response so it appears in the caller's activity history.
    await logActivity({
      uid: req.authUser.uid,
      targetUid: requesterUid,
      type: action === 'accept' ? 'friend_request_accepted' : 'friend_request_rejected',
      payload: { action },
    })

    return res.json({ status: action })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not respond to request' : (error.message || 'Could not respond to request'),
    })
  }
})

/**
 * POST /api/friends/invite-room
 * Sends a room invite to an existing friend.
 * @requires auth - Yes.
 * @body {string} friendUid - The friend being invited.
 * @body {string} roomCode - The target live room.
 * @returns {object} - Delivery status, delivery count, and mute information when invites are disabled.
 */
router.post('/friends/invite-room', requireHttpAuth, async (req, res) => {
  try {
    const friendUid = String(req.body?.friendUid || '').trim()
    const roomCode = String(req.body?.roomCode || '').trim().toUpperCase()
    // Validate the required friend and room identifiers before doing relationship checks.
    if (!friendUid || !roomCode) {
      return res.status(400).json({ error: 'friendUid and roomCode are required' })
    }
    // Security fix: only users currently in a room may invite others into it.
    const room = rooms.get(roomCode)
    if (!room || !room.users.has(req.authUser.uid)) {
      return res.status(403).json({ error: 'You can only invite friends to rooms you are currently in' })
    }

    // Load both sides of the invite and confirm the target is actually a friend.
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
    // Respect the recipient's invite-notification preference before creating deliveries.
    if (friend.settings?.inviteNotifications === false) {
      return res.json({ delivered: false, deliveries: 0, mutedByFriend: true })
    }

    const sockets = socketIdsForUser(friendUid)
    const io = getIo()
    // Create both a durable invite record and a durable notification before emitting sockets.
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

    // Record invite delivery counts for the caller's activity feed.
    await logActivity({
      uid: req.authUser.uid,
      targetUid: friendUid,
      roomCode,
      type: 'room_invite_sent',
      payload: { deliveries: sockets.length },
    })

    return res.json({ delivered: sockets.length > 0, deliveries: sockets.length })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not send invite' : (error.message || 'Could not send invite'),
    })
  }
})

/**
 * GET /api/relationships
 * Returns accepted and pending relationship rows for the authenticated user.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Relationship analytics, tags, partner identity, and privacy-aware online state.
 */
router.get('/relationships', requireHttpAuth, async (req, res) => {
  try {
    const uid = req.authUser.uid
    const rows = await listRelationshipRowsForUser(uid)

    // Load every partner profile once so relationships can be enriched without repeated lookups.
    const partnerUids = uniqueStrings(rows.map((row) => row.users.find((item) => item !== uid)).filter(Boolean))
    const partnerProfiles = await listProfilesByUids(partnerUids)
    const profileByUid = new Map(partnerProfiles.map((profile) => [profile.uid, profile]))

    // Return analytics-ready relationship rows with a small public partner payload.
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
            online: isOnlineVisible(partner, req.authUser.uid),
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

/**
 * PATCH /api/relationships/tag
 * Updates the relationship type tag for an accepted pair.
 * @requires auth - Yes.
 * @body {string} partnerUid - The other user in the relationship.
 * @body {string} relationshipType - The new normalized relationship type.
 * @returns {object} - The updated relationship tag summary.
 */
router.patch('/relationships/tag', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || '').trim()
    const relationshipType = normalizeRelationshipType(req.body?.relationshipType || 'friends', 'friends')
    // Validate the partner and prevent nonsensical self-tagging.
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

    // Persist the new relationship tag and broadcast the change to the partner's live sessions.
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
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not update relationship tag' : (error.message || 'Could not update relationship tag'),
    })
  }
})

module.exports = router
