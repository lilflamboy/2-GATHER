/**
 * Relationship persistence models for Lumiere's social graph. A Relationship
 * document represents the durable state between two users, while a CoupleSpace
 * document stores their shared watchlist. Both are keyed by pairKey, which is
 * built from the two user ids sorted into a stable `uidA__uidB` format.
 */

'use strict'

let RelationshipModel = null
let CoupleSpaceModel = null

// These models are optional at boot so the app can continue in in-memory mode
// when mongoose is unavailable.
try {
  const mongoose = require('mongoose')
  const { ALLOWED_SESSION_MODES } =
    require('../config/constants.js')

  // Embedded watchlist items are stored inside CoupleSpace so the shared
  // watchlist can be updated atomically with the owning pairKey document.
  const watchlistItemSchema = new mongoose.Schema(
    {
      id: { type: String, required: true }, // Stable client/server item id used for updates and deletes.
      title: { type: String, required: true }, // Human-readable watchlist title entered by a user.
      url: { type: String, default: "" }, // Optional normalized media/discovery URL attached to the item.
      notes: { type: String, default: "" }, // Freeform note users add for why they saved the item.
      done: { type: Boolean, default: false }, // Completion flag toggled once the pair has watched or finished the item.
      addedBy: { type: String, required: true }, // Firebase uid of the user who originally added the item.
      createdAt: { type: Date, default: Date.now }, // Original creation time for ordering and activity history.
      updatedAt: { type: Date, default: Date.now }, // Most recent edit time when title/url/notes/done changes.
    },
    { _id: false }
  )

  // CoupleSpace stores shared "couple dashboard" state that belongs to the
  // pair as a whole rather than to one individual user profile.
  const coupleSpaceSchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, unique: true, index: true }, // Sorted uid pair (`uidA__uidB`) that uniquely owns this shared space.
      users: { type: [String], required: true }, // The two user ids that make up the pairKey relationship.
      watchlist: { type: [watchlistItemSchema], default: [] }, // Shared watch/save-for-later items visible to both users.
      updatedAt: { type: Date, default: Date.now }, // Manual last-touch timestamp used by the service layer in addition to mongoose timestamps.
    },
    { timestamps: true }
  )

  // Relationship documents track the accepted/pending/blocked state between
  // two users plus aggregate analytics derived from their shared sessions.
  const relationshipSchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, unique: true, index: true }, // Sorted uid pair (`uidA__uidB`) so both users address the same relationship record.
      users: { type: [String], required: true, index: true }, // The two participant uids stored together for lookup and pair validation.
      requesterUid: { type: String, default: "", index: true }, // Original initiating user kept separately so pending requests can be reconstructed without diffing users[].
      recipientUid: { type: String, default: "", index: true }, // Original target user for pending or recently acted-on requests.
      status: { type: String, enum: ["pending", "accepted", "rejected", "blocked"], default: "pending", index: true }, // Lifecycle state: pending when requested, accepted after approval, rejected when declined, blocked when explicitly blocked.
      relationshipType: { type: String, enum: ["couple", "friends", "family"], default: "friends", index: true }, // Semantic label users assign after acceptance for dashboards and analytics.
      totalWatchTime: { type: Number, default: 0 }, // Aggregate shared session duration accumulated as completed sessions are finalized.
      totalSessions: { type: Number, default: 0 }, // Count of completed shared sessions between these two users.
      longestSession: { type: Number, default: 0 }, // Longest single finalized session duration seen for the pair.
      streak: { type: Number, default: 0 }, // Rolling consecutive-day streak refreshed from completed shared sessions.
      firstWatchedAt: { type: Date, default: null }, // Earliest shared-session completion time recorded for the pair.
      lastWatchedAt: { type: Date, default: null }, // Latest shared-session completion time used for recency and streak logic.
      topGenres: { type: [String], default: [] }, // Derived top genres inferred from the pair's completed sessions and shared memories.
      activeTimeSlots: { type: [String], default: [] }, // Derived time-of-day buckets when this pair most often spends time together.
      lastSessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch" }, // Most recent session mode completed by this pair.
      requestedBy: { type: String, default: "", index: true }, // Normalized requester field used by newer friend-request flows.
      lastActionBy: { type: String, default: "", index: true }, // User who most recently changed the relationship state or metadata.
      lastActionAt: { type: Date, default: Date.now }, // Timestamp of the latest request/accept/reject/tag action.
    },
    { timestamps: true }
  )

  // These indexes support pair lookups, dashboard fetches, and "pending
  // requests for me" queries without scanning the full relationship set.
  coupleSpaceSchema.index({ users: 1 })
  relationshipSchema.index({ users: 1 })
  relationshipSchema.index({ requesterUid: 1, status: 1, updatedAt: -1 })
  relationshipSchema.index({ recipientUid: 1, status: 1, updatedAt: -1 })

  // Reuse existing compiled models during hot reloads/import churn.
  RelationshipModel = mongoose.models.Relationship || mongoose.model("Relationship", relationshipSchema)
  CoupleSpaceModel = mongoose.models.CoupleSpace || mongoose.model("CoupleSpace", coupleSpaceSchema)
} catch { }

module.exports = { RelationshipModel, CoupleSpaceModel }
