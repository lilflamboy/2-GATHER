/**
 * Centralizes Express error responses for the HTTP layer.
 * Express only treats a middleware as a global error handler when it is
 * registered last after all normal routes, allowing thrown or forwarded
 * errors to flow here. Safe 4xx messages are returned to clients directly,
 * while 5xx failures respond with a generic message.
 */
'use strict'

/**
 * Sends a normalized JSON error response for uncaught route errors.
 * The four-argument signature is required for Express to recognize this as
 * an error handler. Status codes fall back to 500, and 5xx responses hide
 * internal messages to avoid exposing server details.
 * @param {Error} err - The error passed through the Express chain.
 * @param {object} req - The Express request object.
 * @param {object} res - The Express response object.
 * @param {Function} next - The next middleware function, unused here.
 * @returns {void} Nothing is returned.
 */
function errorHandler(err, req, res, next) {
  const status = err.status || 500
  const message = status >= 500
    ? 'Internal server error'
    : (err.message || 'Request failed')
  res.status(status).json({ error: message })
}

module.exports = { errorHandler }
