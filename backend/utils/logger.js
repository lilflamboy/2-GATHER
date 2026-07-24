/**
 * Tiny logging wrapper for the 2-GATHER backend. Using one module instead of
 * console directly keeps the `[2-gather]` prefix consistent, makes log streams
 * easier to filter, and leaves one future extension point for structured logs,
 * remote log shipping, or environment-specific sinks.
 */

'use strict'

/**
 * Writes a standard informational log line.
 * @param {...any} args - Values to forward to console.log after the prefix.
 * @returns {void} This helper only writes to stdout.
 */
const log   = (...args) => console.log('[2-gather]',   ...args)

/**
 * Writes a warning log line for recoverable or suspicious conditions.
 * @param {...any} args - Values to forward to console.warn after the prefix.
 * @returns {void} This helper only writes warning output.
 */
const warn  = (...args) => console.warn('[2-gather]',  ...args)

/**
 * Writes an error log line for failures that should stand out in diagnostics.
 * @param {...any} args - Values to forward to console.error after the prefix.
 * @returns {void} This helper only writes error output.
 */
const error = (...args) => console.error('[2-gather]', ...args)

module.exports = { log, warn, error }
