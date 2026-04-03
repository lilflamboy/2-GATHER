/**
 * Shared accessor for the live Socket.IO server instance. A setter/getter pair
 * avoids importing `io` directly across the project, which would otherwise
 * create circular dependencies between socket bootstrap, helpers, routes, and
 * services that need to emit realtime events.
 */

'use strict'

let io = null

/**
 * Stores the Socket.IO server instance after startup creates it.
 * @param {import('socket.io').Server} nextIo - Newly created Socket.IO server.
 * @returns {import('socket.io').Server} The stored Socket.IO server instance.
 */
function setIo(nextIo) {
  io = nextIo
  return io
}

/**
 * Returns the shared Socket.IO server instance for out-of-band emits.
 * @returns {import('socket.io').Server | null} The current Socket.IO server, or null before startup finishes.
 */
function getIo() {
  return io
}

module.exports = { setIo, getIo }
