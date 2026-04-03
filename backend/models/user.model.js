'use strict'

let UserProfileModel = null

try {
  const mongoose = require('mongoose')

  const userProfileSchema = new mongoose.Schema(
    {
      uid: { type: String, required: true, unique: true, index: true },
      username: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
      displayName: { type: String, default: "" },
      photoURL: { type: String, default: "" },
      email: { type: String, default: "" },
      phoneNumber: { type: String, default: "" },
      bio: { type: String, default: "" },
      friends: { type: [String], default: [] },
      incomingRequests: { type: [String], default: [] },
      outgoingRequests: { type: [String], default: [] },
      settings: {
        inviteNotifications: { type: Boolean, default: true },
        memoryNudges: { type: Boolean, default: true },
        showOnlineStatus: { type: Boolean, default: true },
      },
      totalWatchTime: { type: Number, default: 0 },
      totalSessions: { type: Number, default: 0 },
      streakCount: { type: Number, default: 0 },
      lastSessionAt: { type: Date, default: null },
      preferences: {
        favoriteGenres: { type: [String], default: [] },
        activeTimeSlots: { type: [String], default: [] },
      },
      lastSeenAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
  )

  userProfileSchema.index({ username: 1 }, { unique: true, sparse: true })
  userProfileSchema.index(
    { email: 1 },
    {
      unique: true,
      partialFilterExpression: { email: { $type: "string", $ne: "" } },
    }
  )
  userProfileSchema.index(
    { phoneNumber: 1 },
    {
      unique: true,
      partialFilterExpression: { phoneNumber: { $type: "string", $ne: "" } },
    }
  )

  UserProfileModel = mongoose.models.UserProfile || mongoose.model("UserProfile", userProfileSchema)
} catch { }

module.exports = { UserProfileModel }
