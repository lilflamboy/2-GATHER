/**
 * Handles authenticated profile, username, search, and personal activity routes.
 * Every endpoint in this file requires `requireHttpAuth`, and responses are
 * shaped around the caller's own profile plus safe public-profile views of others.
 */
'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const {
  getProfileByUid, publicProfile, claimUsername,
  searchProfiles, isUsernameAvailable, saveProfile,
  relationshipWith, listProfilesByUids,
} = require('../services/profile.service.js')
const { listFriendGraph, relationshipWithGraph } =
  require('../services/friends.service.js')
const { logActivity, listActivityForUser } =
  require('../services/session.service.js')
const {
  USERNAME_REGEX, DEFAULT_SETTINGS, isAdminUser,
} = require('../config/constants.js')
const { normalizeUsername } =
  require('../utils/normalize.js')
const {
  sanitize, sanitizeBio, sanitizePhotoURL,
} = require('../utils/sanitize.js')
const { uniqueStrings } =
  require('../utils/helpers.js')
const { getMongoConnected } =
  require('../models/db.js')
const { isOnline } =
  require('../utils/presence.js')

/**
 * GET /api/username/check
 * Checks whether a normalized username is available for the authenticated user.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Availability status plus the normalized username that was checked.
 */
router.get('/username/check', requireHttpAuth, async (req, res) => {
  const username = normalizeUsername(req.query.username)
  // Validate username format before performing availability checks.
  if (!USERNAME_REGEX.test(username)) {
    return res.status(400).json({ available: false, error: 'Username must be 3-20 chars' })
  }

  // Pass the caller UID as uidToIgnore so an existing owner can re-check their own sparse username row.
  const available = await isUsernameAvailable(username, req.authUser.uid)
  return res.json({ available, username })
})

/**
 * POST /api/username/claim
 * Claims a username for the authenticated user's profile.
 * @requires auth - Yes.
 * @body {string} username - The desired one-time username claim.
 * @returns {object} - The caller's public profile after the claim succeeds.
 */
router.post('/username/claim', requireHttpAuth, async (req, res) => {
  try {
    // The service enforces the one-time claim rule and handles availability races.
    const profile = await claimUsername(req.authUser.uid, req.body?.username)
    await logActivity({
      uid: req.authUser.uid,
      type: 'username_claimed',
      payload: { username: profile.username || '' },
    })
    // Serialize through publicProfile so only safe identity fields are returned.
    return res.json({ profile: publicProfile(profile) })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not claim username' : (error.message || 'Could not claim username'),
    })
  }
})

/**
 * GET /api/me
 * Returns the authenticated user's enriched profile summary.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Public profile fields plus settings, counts, analytics, and derived preferences.
 */
router.get('/me', requireHttpAuth, async (req, res) => {
  const profile = await getProfileByUid(req.authUser.uid)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }
  const friendGraph = await listFriendGraph(req.authUser.uid)

  // Return a curated profile view instead of the raw stored document.
  return res.json({
    profile: {
      ...publicProfile(profile),
      email: profile.email || '',
      bio: profile.bio || '',
      isAdmin: isAdminUser(req.authUser.uid),
      settings: profile.settings || { ...DEFAULT_SETTINGS },
      friendsCount: friendGraph.friends.length,
      incomingRequestsCount: friendGraph.incomingRequests.length,
      outgoingRequestsCount: friendGraph.outgoingRequests.length,
      totalWatchTime: Math.max(0, Number(profile.totalWatchTime) || 0),
      totalSessions: Math.max(0, Number(profile.totalSessions) || 0),
      streakCount: Math.max(0, Number(profile.streakCount) || 0),
      preferences: {
        favoriteGenres: uniqueStrings(Array.isArray(profile.preferences?.favoriteGenres) ? profile.preferences.favoriteGenres : []),
        activeTimeSlots: uniqueStrings(Array.isArray(profile.preferences?.activeTimeSlots) ? profile.preferences.activeTimeSlots : []),
      },
    },
  })
})

/**
 * PATCH /api/me
 * Updates mutable profile fields for the authenticated user.
 * @requires auth - Yes.
 * @body {string} displayName - Optional updated display name.
 * @body {string} photoURL - Optional updated avatar URL or data URI.
 * @body {string} bio - Optional updated biography text.
 * @body {object} settings - Optional notification and privacy preferences.
 * @returns {object} - The saved full profile document after the update.
 */
router.patch('/me', requireHttpAuth, async (req, res) => {
  try {
    const profile = await getProfileByUid(req.authUser.uid)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const next = { ...profile }

    // Only explicitly allowed mutable fields can be changed here; identity keys remain immutable.
    if (typeof req.body?.displayName === 'string') {
      const displayName = sanitize(req.body.displayName).slice(0, 60)
      if (!displayName) {
        return res.status(400).json({ error: 'Display name is required' })
      }
      next.displayName = displayName
    }

    if (typeof req.body?.photoURL === 'string') {
      next.photoURL = sanitizePhotoURL(req.body.photoURL)
    }

    if (typeof req.body?.bio === 'string') {
      next.bio = sanitizeBio(req.body.bio)
    }

    // Settings updates merge with existing values and configured defaults.
    if (req.body?.settings && typeof req.body.settings === 'object') {
      next.settings = {
        inviteNotifications: req.body.settings.inviteNotifications ?? profile.settings?.inviteNotifications ?? DEFAULT_SETTINGS.inviteNotifications,
        memoryNudges: req.body.settings.memoryNudges ?? profile.settings?.memoryNudges ?? DEFAULT_SETTINGS.memoryNudges,
        showOnlineStatus: req.body.settings.showOnlineStatus ?? profile.settings?.showOnlineStatus ?? DEFAULT_SETTINGS.showOnlineStatus,
      }
    }

    const saved = await saveProfile(next)
    await logActivity({
      uid: req.authUser.uid,
      type: 'profile_updated',
      payload: {
        displayName: saved.displayName || '',
        hasPhoto: !!saved.photoURL,
      },
    })
    return res.json({ profile: saved })
  } catch {
    return res.status(500).json({ error: 'Could not update profile' })
  }
})

/**
 * GET /api/users/search
 * Searches for other users by username, display name, or email.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Matching users serialized as public profiles plus relationship state.
 */
router.get('/users/search', requireHttpAuth, async (req, res) => {
  const q = String(req.query.q || '').trim()
  // Require a minimally useful search query before querying profiles.
  if (q.length < 2) {
    return res.json({ users: [] })
  }

  const [me, friendGraph] = await Promise.all([
    getProfileByUid(req.authUser.uid),
    listFriendGraph(req.authUser.uid),
  ])
  const users = await searchProfiles(q, req.authUser.uid, 14)
  // Relationship state is derived from either the normalized graph or the legacy memory fallback fields.
  const result = users.map((profile) => ({
    ...publicProfile(profile),
    relationship: getMongoConnected() ? relationshipWithGraph(friendGraph, profile.uid) : relationshipWith(me, profile.uid),
  }))

  return res.json({ users: result })
})

/**
 * GET /api/activity
 * Returns recent activity events for the authenticated user.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Activity items enriched with lightweight target-user previews where available.
 */
router.get('/activity', requireHttpAuth, async (req, res) => {
  try {
    // Clamp the requested activity limit so the route stays bounded.
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 40))
    const rows = await listActivityForUser(req.authUser.uid, limit)
    const targetUids = uniqueStrings(rows.map((row) => row.targetUid).filter(Boolean))
    const profiles = await listProfilesByUids(targetUids)
    const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]))

    // Serialize target users into a small safe shape instead of returning raw profile documents.
    return res.json({
      items: rows.map((row) => {
        const target = profileByUid.get(row.targetUid || '')
        return {
          type: row.type,
          roomCode: row.roomCode || '',
          targetUid: row.targetUid || '',
          target: target
            ? {
              uid: target.uid,
              username: target.username || '',
              displayName: target.displayName || 'Friend',
              photoURL: target.photoURL || '',
            }
            : null,
          payload: row.payload || {},
          occurredAt: row.occurredAt,
        }
      }),
    })
  } catch {
    return res.status(500).json({ error: 'Could not load activity' })
  }
})

module.exports = router
