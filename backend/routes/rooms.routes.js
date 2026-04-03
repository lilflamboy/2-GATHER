'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const { getRoomHistorySnapshot } =
  require('../services/room.service.js')

router.get('/room-history/:roomCode', requireHttpAuth, async (req, res) => {
  try {
    const payload = await getRoomHistorySnapshot(req.params.roomCode, req.authUser.uid)
    return res.json(payload)
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not load room history' })
  }
})

module.exports = router
