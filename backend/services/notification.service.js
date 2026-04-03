'use strict'

const { NotificationModel, getMongoConnected } =
  require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { pushBounded } =
  require('../utils/helpers.js')
const { sanitizeActivityPayload } =
  require('../utils/sanitize.js')

function normalizeNotificationType(type) {
  const value = String(type || "").trim().toLowerCase()
  if (!value) return "system"
  return value.slice(0, 64)
}

function normalizeNotificationRow(row = {}) {
  return {
    id: String(row._id || row.id || ""),
    recipientUid: String(row.recipientUid || ""),
    senderUid: String(row.senderUid || ""),
    type: normalizeNotificationType(row.type),
    referenceId: String(row.referenceId || ""),
    roomCode: String(row.roomCode || "").trim().toUpperCase().slice(0, 32),
    payload: sanitizeActivityPayload(row.payload || {}),
    actionRequired: !!row.actionRequired,
    isRead: !!row.isRead,
    readAt: row.readAt ? new Date(row.readAt) : null,
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  }
}

async function createNotification({
  recipientUid,
  senderUid = "",
  type,
  referenceId = "",
  roomCode = "",
  payload = {},
  actionRequired = false,
}) {
  const normalized = normalizeNotificationRow({
    recipientUid,
    senderUid,
    type,
    referenceId,
    roomCode,
    payload,
    actionRequired,
    isRead: false,
    readAt: null,
    createdAt: new Date(),
  })

  if (!normalized.recipientUid || !normalized.type) return null

  if (getMongoConnected()) {
    const doc = await NotificationModel.create({
      recipientUid: normalized.recipientUid,
      senderUid: normalized.senderUid,
      type: normalized.type,
      referenceId: normalized.referenceId,
      roomCode: normalized.roomCode,
      payload: normalized.payload,
      actionRequired: normalized.actionRequired,
      isRead: false,
      readAt: null,
      createdAt: normalized.createdAt,
    })
    return normalizeNotificationRow(doc.toObject())
  }

  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
  pushBounded(memoryStore.notifications, row, 5000)
  return row
}

async function listNotificationsForUser(uid, { limit = 40, unreadOnly = false } = {}) {
  const recipientUid = String(uid || "").trim()
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 40))
  if (!recipientUid) return []

  if (getMongoConnected()) {
    const query = { recipientUid }
    if (unreadOnly) query.isRead = false
    const rows = await NotificationModel.find(query)
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean()
    return rows.map((row) => normalizeNotificationRow(row))
  }

  return memoryStore.notifications
    .filter((item) => item.recipientUid === recipientUid)
    .filter((item) => !unreadOnly || !item.isRead)
    .slice(-safeLimit)
    .reverse()
    .map((item) => normalizeNotificationRow(item))
}

async function markNotificationRead(notificationId, uid) {
  const id = String(notificationId || "").trim()
  const recipientUid = String(uid || "").trim()
  if (!id || !recipientUid) return false
  const readAt = new Date()

  if (getMongoConnected()) {
    const result = await NotificationModel.updateOne(
      { _id: id, recipientUid },
      { $set: { isRead: true, readAt } }
    )
    return result.modifiedCount > 0
  }

  const index = memoryStore.notifications.findIndex((item) => item.id === id && item.recipientUid === recipientUid)
  if (index === -1) return false
  memoryStore.notifications[index] = {
    ...memoryStore.notifications[index],
    isRead: true,
    readAt,
  }
  return true
}

async function markAllNotificationsRead(uid) {
  const recipientUid = String(uid || "").trim()
  if (!recipientUid) return 0
  const readAt = new Date()

  if (getMongoConnected()) {
    const result = await NotificationModel.updateMany(
      { recipientUid, isRead: false },
      { $set: { isRead: true, readAt } }
    )
    return result.modifiedCount || 0
  }

  let count = 0
  memoryStore.notifications = memoryStore.notifications.map((item) => {
    if (item.recipientUid !== recipientUid || item.isRead) return item
    count += 1
    return { ...item, isRead: true, readAt }
  })
  return count
}

async function countUnreadNotifications(uid) {
  const recipientUid = String(uid || "").trim()
  if (!recipientUid) return 0
  if (getMongoConnected()) {
    return NotificationModel.countDocuments({ recipientUid, isRead: false })
  }
  return memoryStore.notifications.filter((item) => item.recipientUid === recipientUid && !item.isRead).length
}

async function markNotificationsReadByReference({ recipientUid, type = "", referenceId = "" }) {
  const uid = String(recipientUid || "").trim()
  const ref = String(referenceId || "").trim()
  const normalizedType = String(type || "").trim().toLowerCase()
  if (!uid || !ref) return 0
  const readAt = new Date()

  if (getMongoConnected()) {
    const query = {
      recipientUid: uid,
      referenceId: ref,
      isRead: false,
    }
    if (normalizedType) query.type = normalizedType
    const result = await NotificationModel.updateMany(query, { $set: { isRead: true, readAt } })
    return result.modifiedCount || 0
  }

  let count = 0
  memoryStore.notifications = memoryStore.notifications.map((item) => {
    if (item.recipientUid !== uid || item.referenceId !== ref || item.isRead) return item
    if (normalizedType && String(item.type || "").toLowerCase() !== normalizedType) return item
    count += 1
    return { ...item, isRead: true, readAt }
  })
  return count
}

module.exports = {
  normalizeNotificationType,
  normalizeNotificationRow,
  createNotification,
  listNotificationsForUser,
  markNotificationRead,
  markAllNotificationsRead,
  countUnreadNotifications,
  markNotificationsReadByReference,
}
