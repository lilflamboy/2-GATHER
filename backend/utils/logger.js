'use strict'

const log   = (...args) => console.log('[lumiere]',   ...args)
const warn  = (...args) => console.warn('[lumiere]',  ...args)
const error = (...args) => console.error('[lumiere]', ...args)

module.exports = { log, warn, error }
