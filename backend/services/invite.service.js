/**
 * Stores room invite records that can later be surfaced as notifications
 * or invitation history. Invite rows track invitation lifecycle state and
 * are distinct from notifications, which are the user-facing delivery layer.
 */
'use strict'

const { InviteModel, getMongoConnected } =
  require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { pushBounded } =
  require('../utils/helpers.js')

/**
 * Creates a persisted or in-memory room invite record.
 * Invite rows capture who sent the invite, who received it, which room it
 * targets, and the current invite lifecycle status.
 * @param {object} payload - The invite creation payload.
 * @param {string} payload.fromUid - The sender UID.
 * @param {string} payload.toUid - The recipient UID.
 * @param {string} payload.roomCode - The invited room code.
 * @param {string} [payload.status='sent'] - The initial invite status.
 * @returns {Promise<object|null>} The created invite row or null when invalid.
 */
async function createInviteRecord({ fromUid, toUid, roomCode, status = 'sent' }) {
  // Normalize the invite so both storage paths share the same shape.
  const normalized = {
    fromUid: String(fromUid || ''),
    toUid: String(toUid || ''),
    roomCode: String(roomCode || '').trim().toUpperCase().slice(0, 32),
    status: ['sent', 'seen', 'accepted', 'expired'].includes(status) ? status : 'sent',
    createdAt: new Date(),
    respondedAt: null,
  }
  if (!normalized.fromUid || !normalized.toUid || !normalized.roomCode) return null

  // Persist invites in MongoDB when durable storage is available.
  if (getMongoConnected()) {
    return InviteModel.create(normalized)
  }

  // Fall back to the bounded in-memory invite list when MongoDB is unavailable.
  const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...normalized }
  pushBounded(memoryStore.invites, row, 3000)
  return row
}

module.exports = { createInviteRecord }
