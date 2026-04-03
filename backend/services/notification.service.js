/**
 * Manages persistent notification records for the Lumiere backend.
 * Notifications are the durable counterpart to real-time socket pushes and
 * let clients list, count, and mark message-like events as read later.
 */
'use strict'

const { NotificationModel, getMongoConnected } =
  require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { pushBounded } =
  require('../utils/helpers.js')
const { sanitizeActivityPayload } =
  require('../utils/sanitize.js')

/**
 * Normalizes a notification type into a safe, compact identifier.
 * Types are lowercased and length-limited so they can be safely stored,
 * queried, and compared across MongoDB and memory paths.
 * @param {string} type - The raw notification type.
 * @returns {string} The normalized type, defaulting to `system`.
 */
function normalizeNotificationType(type) {
  const value = String(type || "").trim().toLowerCase()
  if (!value) return "system"
  return value.slice(0, 64)
}

/**
 * Converts a raw notification row into the canonical notification shape.
 * The normalizer aligns MongoDB documents and memory rows, sanitizes payload
 * data, and coerces all date-like fields into Date instances.
 * @param {object} [row={}] - The raw notification row.
 * @returns {object} The normalized notification record.
 */
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

/**
 * Creates a new unread notification for a recipient.
 * The same normalized payload is persisted to MongoDB when available or pushed
 * into the bounded in-memory notification list during fallback mode.
 * @param {object} payload - The notification creation payload.
 * @returns {Promise<object|null>} The created normalized notification row.
 */
async function createNotification({
  recipientUid,
  senderUid = "",
  type,
  referenceId = "",
  roomCode = "",
  payload = {},
  actionRequired = false,
}) {
  // Normalize once so both storage paths stay consistent.
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

  // Store notifications durably when MongoDB is connected.
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

  // Keep the fallback notification list bounded to avoid unbounded memory growth.
  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
  pushBounded(memoryStore.notifications, row, 5000)
  return row
}

/**
 * Lists notifications for a specific user with optional unread filtering.
 * MongoDB returns the newest rows directly, while memory mode rebuilds the
 * same ordering from the bounded notification array.
 * @param {string} uid - The notification recipient UID.
 * @param {object} [options={}] - Listing options.
 * @returns {Promise<object[]>} The normalized notifications for the user.
 */
async function listNotificationsForUser(uid, { limit = 40, unreadOnly = false } = {}) {
  const recipientUid = String(uid || "").trim()
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 40))
  if (!recipientUid) return []

  // Query the notification collection directly when persistence is available.
  if (getMongoConnected()) {
    const query = { recipientUid }
    if (unreadOnly) query.isRead = false
    const rows = await NotificationModel.find(query)
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean()
    return rows.map((row) => normalizeNotificationRow(row))
  }

  // Mirror the same filter and newest-first ordering from the in-memory list.
  return memoryStore.notifications
    .filter((item) => item.recipientUid === recipientUid)
    .filter((item) => !unreadOnly || !item.isRead)
    .slice(-safeLimit)
    .reverse()
    .map((item) => normalizeNotificationRow(item))
}

/**
 * Marks a single notification as read for the owning recipient.
 * Both storage paths require the notification to belong to the caller before
 * flipping the `isRead` flag and stamping `readAt`.
 * @param {string} notificationId - The notification identifier.
 * @param {string} uid - The recipient UID.
 * @returns {Promise<boolean>} True when a notification was updated.
 */
async function markNotificationRead(notificationId, uid) {
  const id = String(notificationId || "").trim()
  const recipientUid = String(uid || "").trim()
  if (!id || !recipientUid) return false
  const readAt = new Date()

  // Update the matching row in MongoDB when persistent storage is available.
  if (getMongoConnected()) {
    const result = await NotificationModel.updateOne(
      { _id: id, recipientUid },
      { $set: { isRead: true, readAt } }
    )
    return result.modifiedCount > 0
  }

  // Patch the in-memory row in place while preserving other notification fields.
  const index = memoryStore.notifications.findIndex((item) => item.id === id && item.recipientUid === recipientUid)
  if (index === -1) return false
  memoryStore.notifications[index] = {
    ...memoryStore.notifications[index],
    isRead: true,
    readAt,
  }
  return true
}

/**
 * Marks every unread notification for a user as read.
 * This supports bulk "mark all read" actions in the client and returns the
 * number of rows that changed in either storage path.
 * @param {string} uid - The recipient UID.
 * @returns {Promise<number>} The number of notifications updated.
 */
async function markAllNotificationsRead(uid) {
  const recipientUid = String(uid || "").trim()
  if (!recipientUid) return 0
  const readAt = new Date()

  // Bulk-update unread notifications in MongoDB for efficiency.
  if (getMongoConnected()) {
    const result = await NotificationModel.updateMany(
      { recipientUid, isRead: false },
      { $set: { isRead: true, readAt } }
    )
    return result.modifiedCount || 0
  }

  // Rewrite the in-memory list while counting how many unread rows changed.
  let count = 0
  memoryStore.notifications = memoryStore.notifications.map((item) => {
    if (item.recipientUid !== recipientUid || item.isRead) return item
    count += 1
    return { ...item, isRead: true, readAt }
  })
  return count
}

/**
 * Counts unread notifications for a given user.
 * This is typically used to power the header badge without fetching the full
 * notification list.
 * @param {string} uid - The recipient UID.
 * @returns {Promise<number>} The unread notification count.
 */
async function countUnreadNotifications(uid) {
  const recipientUid = String(uid || "").trim()
  if (!recipientUid) return 0
  if (getMongoConnected()) {
    return NotificationModel.countDocuments({ recipientUid, isRead: false })
  }
  return memoryStore.notifications.filter((item) => item.recipientUid === recipientUid && !item.isRead).length
}

/**
 * Marks notifications read by shared reference ID and optional type.
 * Reference-based updates let the app clear related notifications in bulk once
 * the user acts on the underlying invite, request, or room event.
 * @param {object} payload - The matching criteria.
 * @returns {Promise<number>} The number of notifications updated.
 */
async function markNotificationsReadByReference({ recipientUid, type = "", referenceId = "" }) {
  const uid = String(recipientUid || "").trim()
  const ref = String(referenceId || "").trim()
  const normalizedType = String(type || "").trim().toLowerCase()
  if (!uid || !ref) return 0
  const readAt = new Date()

  // Use a filtered bulk update in MongoDB when persistence is available.
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

  // Apply the same reference matching rules across the in-memory notification list.
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
