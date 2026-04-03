/**
 * Handles notification list and read-state endpoints.
 * Notifications track durable user-facing events with a read/unread lifecycle,
 * which is distinct from transient real-time socket pushes.
 */
'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const {
  listNotificationsForUser, markNotificationRead,
  markAllNotificationsRead, countUnreadNotifications,
} = require('../services/notification.service.js')
const {
  listProfilesByUids, publicProfile,
} = require('../services/profile.service.js')
const { uniqueStrings } =
  require('../utils/helpers.js')
const { isOnlineVisible } =
  require('../utils/presence.js')

/**
 * GET /api/notifications
 * Returns recent notifications for the authenticated user with unread counts.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Unread count plus newest-first notification items enriched with sender info.
 */
router.get('/notifications', requireHttpAuth, async (req, res) => {
  try {
    // Bound notification listing options so the client cannot request unbounded history.
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 40))
    const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unreadOnly || '').toLowerCase())
    const [items, unreadCount] = await Promise.all([
      listNotificationsForUser(req.authUser.uid, { limit, unreadOnly }),
      countUnreadNotifications(req.authUser.uid),
    ])

    const senderUids = uniqueStrings(items.map((item) => item.senderUid).filter(Boolean))
    const senderProfiles = await listProfilesByUids(senderUids)
    const senderByUid = new Map(senderProfiles.map((profile) => [profile.uid, profile]))

    // Serialize senders through the public profile view so raw profile documents are never returned.
    return res.json({
      unreadCount,
      items: items.map((item) => {
        const sender = senderByUid.get(item.senderUid)
        return {
          id: item.id,
          type: item.type,
          referenceId: item.referenceId,
          roomCode: item.roomCode || '',
          payload: item.payload || {},
          actionRequired: !!item.actionRequired,
          isRead: !!item.isRead,
          readAt: item.readAt,
          createdAt: item.createdAt,
          sender: sender
            ? {
              ...publicProfile(sender),
              online: isOnlineVisible(sender, req.authUser.uid),
            }
            : item.senderUid
              ? {
                uid: item.senderUid,
                username: '',
                displayName: 'Friend',
                photoURL: '',
                bio: '',
                online: false,
              }
              : null,
        }
      }),
    })
  } catch {
    return res.status(500).json({ error: 'Could not load notifications' })
  }
})

/**
 * POST /api/notifications/read
 * Marks one notification as read for the authenticated user.
 * @requires auth - Yes.
 * @body {string} notificationId - The notification to mark as read.
 * @returns {object} - A simple success object when the notification is updated.
 */
router.post('/notifications/read', requireHttpAuth, async (req, res) => {
  try {
    // Require a concrete notification ID so the route cannot accidentally behave like a bulk update.
    const notificationId = String(req.body?.notificationId || '').trim()
    if (!notificationId) {
      return res.status(400).json({ error: 'notificationId is required' })
    }
    const ok = await markNotificationRead(notificationId, req.authUser.uid)
    if (!ok) {
      return res.status(404).json({ error: 'Notification not found' })
    }
    return res.json({ ok: true })
  } catch {
    return res.status(500).json({ error: 'Could not mark notification read' })
  }
})

/**
 * POST /api/notifications/read-all
 * Marks every unread notification as read for the authenticated user.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - A success flag plus the number of rows updated.
 */
router.post('/notifications/read-all', requireHttpAuth, async (req, res) => {
  try {
    const updated = await markAllNotificationsRead(req.authUser.uid)
    return res.json({ ok: true, updated })
  } catch {
    return res.status(500).json({ error: 'Could not mark notifications read' })
  }
})

module.exports = router
