'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const { getValidatedCoupleUsers } =
  require('../services/watchlist.service.js')
const {
  listWatchSessionsForUser,
} = require('../services/session.service.js')
const {
  listProfilesByUids, publicProfile,
} = require('../services/profile.service.js')
const {
  listMilestonesForUser, listInsightsForUser,
  getInsightForPairYear, regenerateRelationshipInsight,
} = require('../services/insight.service.js')
const {
  pairKeyFromUsers, getRelationshipByPairKey,
} = require('../services/relationship.service.js')
const { uniqueStrings } =
  require('../utils/helpers.js')
const { isOnline } =
  require('../utils/presence.js')

router.get('/watch-sessions', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || '').trim()
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    if (partnerUid) {
      await getValidatedCoupleUsers(req.authUser.uid, partnerUid)
    }

    const rows = await listWatchSessionsForUser(req.authUser.uid, {
      partnerUid,
      limit,
      year: req.query.year || null,
    })
    const otherUids = uniqueStrings(
      rows.flatMap((row) => (Array.isArray(row.participants) ? row.participants : []))
        .filter((uid) => uid !== req.authUser.uid)
    )
    const profiles = await listProfilesByUids(otherUids)
    const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]))

    return res.json({
      items: rows.map((row) => ({
        id: row.id,
        roomCode: row.roomCode,
        roomType: row.roomType,
        sessionMode: row.sessionMode,
        relationshipId: row.relationshipId || '',
        relationshipType: row.relationshipType || 'group',
        contentUrl: row.contentUrl || '',
        contentTitle: row.contentTitle || '',
        contentType: row.contentType || 'unknown',
        genre: row.genre || '',
        moodTag: row.moodTag || '',
        duration: row.duration || 0,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        reactionsCount: row.reactionsCount || 0,
        highlights: row.highlights || [],
        participants: row.participants.map((participantUid) => {
          const profile = profileByUid.get(participantUid)
          if (!profile) {
            return {
              uid: participantUid,
              username: '',
              displayName: participantUid === req.authUser.uid ? 'You' : 'Friend',
              photoURL: '',
              bio: '',
              online: isOnline(participantUid),
            }
          }
          return {
            ...publicProfile(profile),
            online: isOnline(profile.uid),
          }
        }),
      })),
    })
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not load watch sessions' })
  }
})

router.get('/milestones', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || '').trim()
    if (partnerUid) {
      await getValidatedCoupleUsers(req.authUser.uid, partnerUid)
    }
    const items = await listMilestonesForUser(req.authUser.uid, partnerUid)
    return res.json({
      items: items.map((row) => ({
        id: row.id,
        relationshipId: row.relationshipId,
        pairKey: row.pairKey,
        users: row.users,
        type: row.type,
        achievedAt: row.achievedAt,
        payload: row.payload || {},
      })),
    })
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not load milestones' })
  }
})

router.get('/insights', requireHttpAuth, async (req, res) => {
  try {
    const partnerUid = String(req.query.partnerUid || '').trim()
    const rawYear = Number(req.query.year)
    const hasYear = Number.isFinite(rawYear)
    const year = hasYear
      ? Math.max(2000, Math.min(2200, Math.floor(rawYear)))
      : new Date().getFullYear()

    if (partnerUid) {
      await getValidatedCoupleUsers(req.authUser.uid, partnerUid)
      const pairKey = pairKeyFromUsers(req.authUser.uid, partnerUid)
      if (!pairKey) {
        return res.status(400).json({ error: 'Invalid partner relationship' })
      }

      let insight = await getInsightForPairYear(pairKey, year)
      if (!insight) {
        const relationshipRow = await getRelationshipByPairKey(pairKey)
        if (relationshipRow?.status === 'accepted') {
          insight = await regenerateRelationshipInsight(relationshipRow, year)
        }
      }

      if (!insight) {
        return res.json({ item: null })
      }

      return res.json({ item: insight })
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    const rows = await listInsightsForUser(req.authUser.uid, { year: hasYear ? year : null, limit })
    return res.json({ items: rows })
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not load insights' })
  }
})

module.exports = router
