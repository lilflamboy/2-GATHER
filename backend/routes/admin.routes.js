/**
 * Exposes administrator-only HTTP endpoints.
 * These routes are separated from regular user routes because they expose
 * project-wide operational data and always require both authentication and
 * an explicit `isAdminUser` authorization check.
 */
'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const { isAdminUser } =
  require('../config/constants.js')
const { getProjectOverview } =
  require('../services/admin.service.js')

/**
 * GET /api/project-overview
 * Returns the aggregated admin overview for the project dashboard.
 * @requires auth - Yes, and the caller must also pass the isAdminUser check.
 * @body {none} - No request body.
 * @returns {object} - Project-wide counts, recent activity, recent rooms, and policy metadata.
 */
router.get('/project-overview', requireHttpAuth, async (req, res) => {
  try {
    // Admin routes enforce a second authorization gate beyond normal authentication.
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
