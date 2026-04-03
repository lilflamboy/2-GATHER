/**
 * Authenticates incoming HTTP requests with Firebase ID tokens.
 * This middleware runs near the start of the Express request lifecycle for
 * protected routes, verifies the caller, ensures a profile exists, and then
 * attaches both the authenticated identity and the persisted profile to `req`.
 */
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

/**
 * Validates a Bearer token and enriches the request with authenticated user context.
 * The auth rate-limit check runs before Firebase verification to avoid expensive
 * remote token verification calls for abusive clients. After `verifyIdToken`,
 * the decoded payload is reshaped into a trusted identity object, `ensureProfile`
 * is called so every authenticated request has a synchronized profile record,
 * and then `req.authUser` and `req.profile` are attached for downstream routes.
 * `req.authUser` contains the trusted Firebase identity fields, while
 * `req.profile` contains the app-level Lumiere profile document.
 * @param {object} req - The Express request object.
 * @param {object} res - The Express response object.
 * @param {Function} next - The next middleware in the Express chain.
 * @returns {Promise<object|void>} A JSON error response or control passed to `next()`.
 */
async function requireHttpAuth(req, res, next) {
  try {
    // Rate-limit auth attempts before token verification to avoid needless Firebase round trips.
    const key = getRequestRateKey(req, 'http-auth')
    if (isRateLimitExceeded(
      httpAuthRateLimitHits,
      key,
      HTTP_RATE_LIMIT_WINDOW_MS,
      HTTP_AUTH_RATE_LIMIT_MAX
    )) {
      return res.status(429).json({ error: 'Too many auth requests. Please slow down.' })
    }

    // Protected HTTP routes require a standard Bearer token in the Authorization header.
    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    // Verify the Firebase ID token and rebuild the app-level identity shape from the decoded claims.
    const token = header.slice(7).trim()
    const decoded = await admin.auth().verifyIdToken(token)
    const identity = {
      uid: decoded.uid,
      name: decoded.name || decoded.email || 'Anonymous',
      email: decoded.email || '',
      phoneNumber: decoded.phone_number || '',
      photoURL: decoded.picture || '',
    }

    // Ensure every authenticated request has a synchronized Lumiere profile document.
    const profile = await ensureProfile(identity)
    req.authUser = identity
    req.profile = profile
    return next()
  } catch {
    return res.status(401).json({ error: 'Authentication failed' })
  }
}

module.exports = { requireHttpAuth }
