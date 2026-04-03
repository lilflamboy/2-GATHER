'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const { getValidatedCoupleUsers } =
  require('../services/watchlist.service.js')
const {
  sortedPairUsers, pairKeyFromUsers, normalizeWatchlistItem,
  mapCoupleSpace, getCoupleSpaceByUsers, saveCoupleSpace,
} = require('../services/relationship.service.js')
const { publicProfile } =
  require('../services/profile.service.js')
const { logActivity } =
  require('../services/session.service.js')
const {
  sanitize, sanitizeContentUrl,
} =
  require('../utils/sanitize.js')
const { isOnlineVisible, socketIdsForUser } =
  require('../utils/presence.js')
const { getIo } =
  require('../sockets/socketHub.js')
const {
  MAX_WATCHLIST_ITEMS,
  MAX_WATCHLIST_TITLE_LENGTH,
  MAX_WATCHLIST_URL_LENGTH,
  MAX_WATCHLIST_NOTES_LENGTH,
} = require('../config/constants.js')

router.get('/couple-space', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || '').trim()
    if (!partnerUid) {
      return res.status(400).json({ error: 'partnerUid is required' })
    }

    const { partner } = await getValidatedCoupleUsers(req.authUser.uid, partnerUid)
    const space = await getCoupleSpaceByUsers(req.authUser.uid, partnerUid, true)
    const mapped = mapCoupleSpace(space, req.authUser.uid)

    return res.json({
      partner: {
        ...publicProfile(partner),
        online: isOnlineVisible(partner, req.authUser.uid),
      },
      space: mapped,
    })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not load couple space' : (error.message || 'Could not load couple space'),
    })
  }
})

router.post('/couple-space/item', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || '').trim()
    const title = sanitize(String(req.body?.title || '')).slice(0, MAX_WATCHLIST_TITLE_LENGTH)
    const rawUrl = String(req.body?.url || '').trim()
    const url = sanitizeContentUrl(rawUrl).slice(0, MAX_WATCHLIST_URL_LENGTH)
    const notes = sanitize(String(req.body?.notes || '')).slice(0, MAX_WATCHLIST_NOTES_LENGTH)
    if (!partnerUid) return res.status(400).json({ error: 'partnerUid is required' })
    if (!title) return res.status(400).json({ error: 'title is required' })
    if (rawUrl && !url) return res.status(400).json({ error: 'url must be a valid http or https URL' })

    const { me, partner } = await getValidatedCoupleUsers(req.authUser.uid, partnerUid)
    const space = await getCoupleSpaceByUsers(req.authUser.uid, partnerUid, true)
    const watchlist = Array.isArray(space.watchlist) ? [...space.watchlist] : []
    if (watchlist.length >= MAX_WATCHLIST_ITEMS) {
      return res.status(400).json({ error: `Watchlist limit reached (${MAX_WATCHLIST_ITEMS})` })
    }

    const now = new Date()
    watchlist.unshift({
      id: `${req.authUser.uid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      url,
      notes,
      done: false,
      addedBy: req.authUser.uid,
      createdAt: now,
      updatedAt: now,
    })

    const saved = await saveCoupleSpace({
      ...space,
      pairKey: pairKeyFromUsers(req.authUser.uid, partnerUid),
      users: sortedPairUsers(req.authUser.uid, partnerUid),
      watchlist,
    })
    const mapped = mapCoupleSpace(saved, req.authUser.uid)
    const io = getIo()

    socketIdsForUser(partnerUid).forEach((socketId) => {
      io?.to(socketId).emit('couple_space_updated', {
        partnerUid: req.authUser.uid,
        partnerName: me.displayName,
        partnerUsername: me.username,
        itemTitle: title,
      })
    })

    await logActivity({
      uid: req.authUser.uid,
      targetUid: partnerUid,
      type: 'couple_watchlist_item_added',
      payload: { title, hasLink: !!url },
    })

    return res.json({
      partner: { ...publicProfile(partner), online: isOnlineVisible(partner, req.authUser.uid) },
      space: mapped,
    })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not add watchlist item' : (error.message || 'Could not add watchlist item'),
    })
  }
})

router.patch('/couple-space/item', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.body?.partnerUid || '').trim()
    const itemId = String(req.body?.itemId || '').trim()
    const action = String(req.body?.action || '').trim()
    if (!partnerUid || !itemId || !action) {
      return res.status(400).json({ error: 'partnerUid, itemId and action are required' })
    }
    if (!['toggle_done', 'remove', 'edit'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' })
    }

    const { me, partner } = await getValidatedCoupleUsers(req.authUser.uid, partnerUid)
    const space = await getCoupleSpaceByUsers(req.authUser.uid, partnerUid, true)
    let watchlist = Array.isArray(space.watchlist) ? [...space.watchlist] : []
    const itemIndex = watchlist.findIndex((item) => String(item.id) === itemId)
    if (itemIndex === -1) {
      return res.status(404).json({ error: 'Watchlist item not found' })
    }

    const currentItem = normalizeWatchlistItem(watchlist[itemIndex])
    if (action === 'remove') {
      watchlist = watchlist.filter((item) => String(item.id) !== itemId)
    } else if (action === 'toggle_done') {
      watchlist[itemIndex] = {
        ...currentItem,
        done: typeof req.body?.done === 'boolean' ? req.body.done : !currentItem.done,
        updatedAt: new Date(),
      }
    } else if (action === 'edit') {
      const nextTitle = sanitize(String(req.body?.title || currentItem.title)).slice(0, MAX_WATCHLIST_TITLE_LENGTH)
      const rawUrl = String(req.body?.url ?? currentItem.url).trim()
      const nextUrl = sanitizeContentUrl(rawUrl).slice(0, MAX_WATCHLIST_URL_LENGTH)
      if (!nextTitle) {
        return res.status(400).json({ error: 'title is required' })
      }
      if (rawUrl && !nextUrl) {
        return res.status(400).json({ error: 'url must be a valid http or https URL' })
      }
      watchlist[itemIndex] = {
        ...currentItem,
        title: nextTitle,
        url: nextUrl,
        notes: sanitize(String(req.body?.notes ?? currentItem.notes)).slice(0, MAX_WATCHLIST_NOTES_LENGTH),
        updatedAt: new Date(),
      }
    }

    const saved = await saveCoupleSpace({
      ...space,
      pairKey: pairKeyFromUsers(req.authUser.uid, partnerUid),
      users: sortedPairUsers(req.authUser.uid, partnerUid),
      watchlist,
    })
    const mapped = mapCoupleSpace(saved, req.authUser.uid)
    const io = getIo()

    socketIdsForUser(partnerUid).forEach((socketId) => {
      io?.to(socketId).emit('couple_space_updated', {
        partnerUid: req.authUser.uid,
        partnerName: me.displayName,
        partnerUsername: me.username,
        itemTitle: currentItem.title,
        action,
      })
    })

    await logActivity({
      uid: req.authUser.uid,
      targetUid: partnerUid,
      type: 'couple_watchlist_item_updated',
      payload: { action, itemId },
    })

    return res.json({
      partner: { ...publicProfile(partner), online: isOnlineVisible(partner, req.authUser.uid) },
      space: mapped,
    })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not update watchlist item' : (error.message || 'Could not update watchlist item'),
    })
  }
})

module.exports = router
