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
const { isOnline } =
  require('../utils/presence.js')

router.get('/notifications', requireHttpAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 40))
    const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unreadOnly || '').toLowerCase())
    const [items, unreadCount] = await Promise.all([
      listNotificationsForUser(req.authUser.uid, { limit, unreadOnly }),
      countUnreadNotifications(req.authUser.uid),
    ])

    const senderUids = uniqueStrings(items.map((item) => item.senderUid).filter(Boolean))
    const senderProfiles = await listProfilesByUids(senderUids)
    const senderByUid = new Map(senderProfiles.map((profile) => [profile.uid, profile]))

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
              online: isOnline(sender.uid),
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

router.post('/notifications/read', requireHttpAuth, async (req, res) => {
  try {
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

router.post('/notifications/read-all', requireHttpAuth, async (req, res) => {
  try {
    const updated = await markAllNotificationsRead(req.authUser.uid)
    return res.json({ ok: true, updated })
  } catch {
    return res.status(500).json({ error: 'Could not mark notifications read' })
  }
})

module.exports = router
