/**
 * UserProfile documents store the backend-facing social identity for each
 * Firebase account. Firebase Auth proves who the user is, while this document
 * stores Lumiere-specific profile fields, friend graph state, preferences, and
 * aggregate watch statistics.
 */

'use strict'

let UserProfileModel = null

// The model is wrapped in try/catch so environments without mongoose can still
// boot and use the in-memory fallback paths.
try {
  const mongoose = require('mongoose')

  // This schema keeps account identity, relationship graph state, preferences,
  // and lightweight analytics in one per-user document keyed by Firebase uid.
  const userProfileSchema = new mongoose.Schema(
    {
      uid: { type: String, required: true, unique: true, index: true }, // Firebase uid is the canonical primary key so backend records line up with auth identities.
      username: { type: String, unique: true, sparse: true, lowercase: true, trim: true }, // Sparse uniqueness allows many users to have no username yet while still enforcing uniqueness once claimed.
      displayName: { type: String, default: "" }, // Human-readable name shown throughout the app.
      photoURL: { type: String, default: "" }, // Avatar URL or data URI chosen by the user.
      email: { type: String, default: "" }, // Contact email mirrored from Firebase or later profile updates.
      phoneNumber: { type: String, default: "" }, // Optional phone number mirrored from Firebase when available.
      bio: { type: String, default: "" }, // Short profile bio shown in dashboards and profile views.
      friends: { type: [String], default: [] }, // Accepted friend uid list for the user's side of the friend graph.
      incomingRequests: { type: [String], default: [] }, // Pending requester uids waiting for this user to respond.
      outgoingRequests: { type: [String], default: [] }, // Pending recipient uids this user has already requested.
      // Per-user notification/privacy toggles that shape how other services
      // serialize presence and decide whether to deliver reminders.
      settings: {
        inviteNotifications: { type: Boolean, default: true }, // Whether room/friend invite notifications should be delivered.
        memoryNudges: { type: Boolean, default: true }, // Whether shared-memory nudges and related reminders are allowed.
        showOnlineStatus: { type: Boolean, default: true }, // Whether other users are allowed to see this user's presence state.
      },
      totalWatchTime: { type: Number, default: 0 }, // Aggregate watched/listened/studied seconds accumulated from completed sessions.
      totalSessions: { type: Number, default: 0 }, // Count of completed sessions that contributed to this user's history.
      streakCount: { type: Number, default: 0 }, // Rolling consecutive-day streak derived from session activity.
      lastSessionAt: { type: Date, default: null }, // Timestamp of the latest completed session used for streak and dashboard summaries.
      // Derived taste/profile summaries refreshed from completed sessions and
      // memory history rather than entered manually by the user.
      preferences: {
        favoriteGenres: { type: [String], default: [] }, // Derived top genres learned from completed watch/shared-memory history.
        activeTimeSlots: { type: [String], default: [] }, // Derived time-of-day labels inferred from when sessions usually happen.
      },
      lastSeenAt: { type: Date, default: Date.now }, // Most recent presence update written on disconnect/last-seen touch.
    },
    { timestamps: true }
  )

  // Email should only be unique when present, which is why the partial filter
  // ignores empty-string placeholder values.
  userProfileSchema.index(
    { email: 1 },
    {
      unique: true,
      partialFilterExpression: { email: { $type: "string", $ne: "" } },
    }
  )
  // Phone numbers follow the same partial uniqueness rule as email.
  userProfileSchema.index(
    { phoneNumber: 1 },
    {
      unique: true,
      partialFilterExpression: { phoneNumber: { $type: "string", $ne: "" } },
    }
  )

  // Reuse an existing compiled model during hot reloads so mongoose does not
  // throw OverwriteModelError in dev or repeated imports.
  UserProfileModel = mongoose.models.UserProfile || mongoose.model("UserProfile", userProfileSchema)
} catch { }

module.exports = { UserProfileModel }
