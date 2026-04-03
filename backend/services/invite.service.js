'use strict'

const { InviteModel, getMongoConnected } =
  require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { pushBounded } =
  require('../utils/helpers.js')

async function createInviteRecord({ fromUid, toUid, roomCode, status = 'sent' }) {
  const normalized = {
    fromUid: String(fromUid || ''),
    toUid: String(toUid || ''),
    roomCode: String(roomCode || '').trim().toUpperCase().slice(0, 32),
    status: ['sent', 'seen', 'accepted', 'expired'].includes(status) ? status : 'sent',
    createdAt: new Date(),
    respondedAt: null,
  }
  if (!normalized.fromUid || !normalized.toUid || !normalized.roomCode) return null

  if (getMongoConnected()) {
    return InviteModel.create(normalized)
  }

  const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...normalized }
  pushBounded(memoryStore.invites, row, 3000)
  return row
}

module.exports = { createInviteRecord }
