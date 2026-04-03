'use strict'

const rooms = new Map()
const pendingRoomUserDisconnects = new Map()

module.exports = {
  rooms,
  pendingRoomUserDisconnects,
}
