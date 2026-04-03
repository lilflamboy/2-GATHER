'use strict'

function errorHandler(err, req, res, next) {
  const status = err.status || 500
  const message = err.message || 'Internal server error'
  res.status(status).json({ error: message })
}

module.exports = { errorHandler }
