'use strict'

const admin = require('../config/firebase.js')
const { ensureProfile } =
  require('../services/profile.service.js')
const {
  isRateLimitExceeded, getRequestRateKey,
  httpAuthRateLimitHits,
} = require('../utils/rateLimit.js')
const {
  HTTP_RATE_LIMIT_WINDOW_MS,
  HTTP_AUTH_RATE_LIMIT_MAX,
} = require('../config/constants.js')

async function requireHttpAuth(req, res, next) {
  try {
    const key = getRequestRateKey(req, 'http-auth')
    if (isRateLimitExceeded(
      httpAuthRateLimitHits,
      key,
      HTTP_RATE_LIMIT_WINDOW_MS,
      HTTP_AUTH_RATE_LIMIT_MAX
    )) {
      return res.status(429).json({ error: 'Too many auth requests. Please slow down.' })
    }

    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const token = header.slice(7).trim()
    const decoded = await admin.auth().verifyIdToken(token)
    const identity = {
      uid: decoded.uid,
      name: decoded.name || decoded.email || 'Anonymous',
      email: decoded.email || '',
      phoneNumber: decoded.phone_number || '',
      photoURL: decoded.picture || '',
    }

    const profile = await ensureProfile(identity)
    req.authUser = identity
    req.profile = profile
    return next()
  } catch {
    return res.status(401).json({ error: 'Authentication failed' })
  }
}

module.exports = { requireHttpAuth }
