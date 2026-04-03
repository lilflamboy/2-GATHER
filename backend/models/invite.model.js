'use strict'

let InviteModel = null
let NotificationModel = null

try {
  const mongoose = require('mongoose')

  const inviteSchema = new mongoose.Schema(
    {
      fromUid: { type: String, required: true, index: true },
      toUid: { type: String, required: true, index: true },
      roomCode: { type: String, required: true, index: true },
      status: { type: String, enum: ["sent", "seen", "accepted", "expired"], default: "sent", index: true },
      createdAt: { type: Date, default: Date.now, index: true },
      respondedAt: { type: Date, default: null },
    },
    { timestamps: true }
  )

  const notificationSchema = new mongoose.Schema(
    {
      recipientUid: { type: String, required: true, index: true },
      senderUid: { type: String, default: "", index: true },
      type: { type: String, required: true, index: true },
      referenceId: { type: String, default: "", index: true },
      roomCode: { type: String, default: "", index: true },
      payload: { type: mongoose.Schema.Types.Mixed, default: {} },
      actionRequired: { type: Boolean, default: false, index: true },
      isRead: { type: Boolean, default: false, index: true },
      readAt: { type: Date, default: null },
      createdAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  )

  inviteSchema.index({ toUid: 1, createdAt: -1 })
  notificationSchema.index({ recipientUid: 1, isRead: 1, createdAt: -1 })
  notificationSchema.index({ recipientUid: 1, actionRequired: 1, createdAt: -1 })

  InviteModel = mongoose.models.Invite || mongoose.model("Invite", inviteSchema)
  NotificationModel = mongoose.models.Notification || mongoose.model("Notification", notificationSchema)
} catch { }

module.exports = { InviteModel, NotificationModel }
