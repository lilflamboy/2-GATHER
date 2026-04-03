/**
 * Exposes read-only HTTP endpoints for persisted room data.
 * Most room actions happen over sockets because they are collaborative and
 * real-time, while these routes provide snapshot-style history retrieval.
 */
'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const { getRoomHistorySnapshot } =
  require('../services/room.service.js')

/**
 * GET /api/room-history/:roomCode
 * Returns the persisted and live history snapshot for one room.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {object} - Room metadata, participant history, video-session data, activity, chat, and live history.
 */
router.get('/room-history/:roomCode', requireHttpAuth, async (req, res) => {
  try {
    const payload = await getRoomHistorySnapshot(req.params.roomCode, req.authUser.uid)
    return res.json(payload)
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not load room history' : (error.message || 'Could not load room history'),
    })
  }
})

module.exports = router
