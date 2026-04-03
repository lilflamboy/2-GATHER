'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const { isAdminUser } =
  require('../config/constants.js')
const { getProjectOverview } =
  require('../services/admin.service.js')

router.get('/project-overview', requireHttpAuth, async (req, res) => {
  try {
    if (!isAdminUser(req.authUser.uid)) {
      return res.status(403).json({ error: 'Metadata is available only for admins' })
    }
    const overview = await getProjectOverview(req.authUser.uid)
    return res.json(overview)
  } catch {
    return res.status(500).json({ error: 'Could not load project overview' })
  }
})

module.exports = router
