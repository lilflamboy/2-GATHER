'use strict'

/**
 * CORS configuration helpers for the 2-GATHER backend. This file decides which
 * browser origins are allowed to call the API so cross-origin requests are
 * explicit, predictable, and easy to audit.
 */

// CLIENT_ORIGINS is assembled in constants.js from env values, split on commas,
// trimmed, stripped of empties, and de-duplicated before this file uses it.
const {
  CLIENT_ORIGINS, NODE_ENV,
} = require('./constants.js')

// Private LAN and loopback hosts are allowed in development so phones, tablets,
// and other devices on the same network can test the app without production
// origins being opened up broadly.
const {
  isPrivateLanHost,
} = require('../utils/helpers.js')

/**
 * Decides whether a request origin should be allowed through CORS checks.
 * @param {string | undefined | null} origin - The request Origin header value.
 * @returns {boolean} True when the origin is safe to allow.
 */
function isAllowedOrigin(origin) {
  // Requests without an Origin header are typically server-to-server, curl, or
  // same-device flows, so they are allowed rather than blocked by browser CORS.
  if (!origin || CLIENT_ORIGINS.includes(origin)) return true

  // Production only trusts the explicit allowlist to avoid accidentally
  // exposing the API to unexpected browser origins.
  if (NODE_ENV === 'production') return false

  try {
    // Development also allows localhost, loopback, and private LAN hosts so
    // teammates can test across devices on the same network.
    const parsed = new URL(origin)
    const host = parsed.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || isPrivateLanHost(host)
  } catch {
    // Malformed origins are treated as unsafe and rejected.
    return false
  }
}

module.exports = { isAllowedOrigin }
