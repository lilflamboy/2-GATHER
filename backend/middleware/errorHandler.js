'use strict'

function errorHandler(err, req, res, next) {
  const status = err.status || 500
  const message = status >= 500
    ? 'Internal server error'
    : (err.message || 'Request failed')
  res.status(status).json({ error: message })
}

module.exports = { errorHandler }
