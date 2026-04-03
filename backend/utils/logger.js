/**
 * Tiny logging wrapper for the Lumiere backend. Using one module instead of
 * console directly keeps the `[lumiere]` prefix consistent, makes log streams
 * easier to filter, and leaves one future extension point for structured logs,
 * remote log shipping, or environment-specific sinks.
 */

'use strict'

/**
 * Writes a standard informational log line.
 * @param {...any} args - Values to forward to console.log after the prefix.
 * @returns {void} This helper only writes to stdout.
 */
const log   = (...args) => console.log('[lumiere]',   ...args)

/**
 * Writes a warning log line for recoverable or suspicious conditions.
 * @param {...any} args - Values to forward to console.warn after the prefix.
 * @returns {void} This helper only writes warning output.
 */
const warn  = (...args) => console.warn('[lumiere]',  ...args)

/**
 * Writes an error log line for failures that should stand out in diagnostics.
 * @param {...any} args - Values to forward to console.error after the prefix.
 * @returns {void} This helper only writes error output.
 */
const error = (...args) => console.error('[lumiere]', ...args)

module.exports = { log, warn, error }
