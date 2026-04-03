/**
 * In-memory runtime store for live socket rooms. This data exists for speed
 * and coordination only: it mirrors the currently active room state but is not
 * durable, so it is dropped on process restart unlike MongoDB-backed records.
 */

'use strict'

// Active rooms keyed by `roomCode -> room object`. Each room object carries
// users, chat messages, playback state, reading state, timers, and sync helpers
// while the room is alive.
const rooms = new Map()

// Pending disconnect cleanup timers keyed by `roomCode::uid -> { token, timer }`.
// A grace period is used so brief reconnects do not immediately evict users or
// tear down host/session state.
const pendingRoomUserDisconnects = new Map()

module.exports = {
  rooms,
  pendingRoomUserDisconnects,
}
