/**
 * Invite and Notification persistence models. Invite records represent direct
 * room invites exchanged between users, while Notification records are the
 * generic inbox items surfaced in the UI for friend requests, invites, shared
 * memories, and other attention-worthy events.
 */

'use strict'

let InviteModel = null
let NotificationModel = null

// Load these models conditionally so the backend can degrade gracefully when
// mongoose is not available.
try {
  const mongoose = require('mongoose')

  // Invite rows track short-lived room invitations sent from one user to
  // another and their response lifecycle.
  const inviteSchema = new mongoose.Schema(
    {
      fromUid: { type: String, required: true, index: true }, // Firebase uid of the sender who initiated the invite.
      toUid: { type: String, required: true, index: true }, // Firebase uid of the invited recipient.
      roomCode: { type: String, required: true, index: true }, // Room share code the recipient is being invited into.
      status: { type: String, enum: ["sent", "seen", "accepted", "expired"], default: "sent", index: true }, // Invite lifecycle: sent when created, seen after acknowledgement, accepted on join, expired when no longer valid.
      createdAt: { type: Date, default: Date.now, index: true }, // Original send time used for expiry and invite inbox ordering.
      respondedAt: { type: Date, default: null }, // Timestamp when the invite was seen or accepted.
    },
    { timestamps: true }
  )

  // Notification rows power the generic inbox. They differ from Invite because
  // they can point to many event types, not just room invitations.
  const notificationSchema = new mongoose.Schema(
    {
      recipientUid: { type: String, required: true, index: true }, // User who should see this notification in their inbox.
      senderUid: { type: String, default: "", index: true }, // Optional actor uid that triggered the notification.
      type: { type: String, required: true, index: true }, // Notification category such as friend_request, room_invite, or shared_memory_added.
      referenceId: { type: String, default: "", index: true }, // Foreign key-ish reference to the related pairKey, roomCode, invite, or other domain record.
      roomCode: { type: String, default: "", index: true }, // Optional room code attached when the notification is room-specific.
      payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible metadata blob rendered by the client for this notification type.
      actionRequired: { type: Boolean, default: false, index: true }, // Whether the UI should show this as something the user can act on.
      isRead: { type: Boolean, default: false, index: true }, // Inbox read/unread state.
      readAt: { type: Date, default: null }, // Timestamp when the notification was marked read.
      createdAt: { type: Date, default: Date.now, index: true }, // Creation time for inbox ordering.
    },
    { timestamps: true }
  )

  // These indexes accelerate inbox fetches and "latest invite for user" style
  // queries that sort by recency.
  inviteSchema.index({ toUid: 1, createdAt: -1 })
  notificationSchema.index({ recipientUid: 1, isRead: 1, createdAt: -1 })
  notificationSchema.index({ recipientUid: 1, actionRequired: 1, createdAt: -1 })

  // Reuse compiled models when this module is re-imported in development.
  InviteModel = mongoose.models.Invite || mongoose.model("Invite", inviteSchema)
  NotificationModel = mongoose.models.Notification || mongoose.model("Notification", notificationSchema)
} catch { }

module.exports = { InviteModel, NotificationModel }
