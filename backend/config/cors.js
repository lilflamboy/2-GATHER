'use strict'

const {
  CLIENT_ORIGINS, NODE_ENV,
} = require('./constants.js')
const {
  isPrivateLanHost,
} = require('../utils/helpers.js')

function isAllowedOrigin(origin) {
  if (!origin || CLIENT_ORIGINS.includes(origin)) return true
  if (NODE_ENV === 'production') return false

  try {
    const parsed = new URL(origin)
    const host = parsed.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || isPrivateLanHost(host)
  } catch {
    return false
  }
}

module.exports = { isAllowedOrigin }
