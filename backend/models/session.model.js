/**
 * Session-domain persistence models. VideoSession stores live room playback
 * metadata, WatchSession stores finalized historical sessions, SessionReaction
 * stores individual reaction events, and ActivityEvent stores the audit-style
 * user activity feed. They are separate because they have different lifecycles,
 * query patterns, and retention needs.
 */

'use strict'

let VideoSessionModel = null
let WatchSessionModel = null
let SessionReactionModel = null
let ActivityEventModel = null

// Load these models conditionally so the app can fall back to in-memory state
// when mongoose is not available.
try {
  const mongoose = require('mongoose')
  const {
    ALLOWED_SESSION_MODES,
    ALLOWED_CONTENT_TYPES,
    ALLOWED_REACTION_TYPES,
    ALLOWED_RELATIONSHIP_TYPES,
  } = require('../config/constants.js')

  // Activity events are lightweight audit-log rows shown in user activity feeds
  // and used for social/event history outside of chat.
  const activityEventSchema = new mongoose.Schema(
    {
      uid: { type: String, required: true, index: true }, // Actor uid that performed the activity.
      type: { type: String, required: true, index: true }, // Event category such as profile_updated, friend_request_sent, or room_invite_sent.
      roomCode: { type: String, default: "", index: true }, // Optional room code when the action was tied to a room.
      targetUid: { type: String, default: "", index: true }, // Optional other user involved in the activity.
      payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible detail object with per-event metadata for UI rendering.
      occurredAt: { type: Date, default: Date.now, index: true }, // Canonical event time used for feed ordering.
    },
    { timestamps: true }
  )

  // VideoSession tracks the current live synchronized media state for one room
  // while that room is active.
  const videoSessionSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, unique: true, index: true }, // Room share code owning this live session record.
      videoName: { type: String, default: "" }, // User-visible title of the active media/document source.
      duration: { type: Number, default: 0 }, // Known total media duration in seconds, used for sync and analytics.
      sourceType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown" }, // Content source family so clients know how to interpret playback metadata.
      fileFingerprint: { type: String, default: "" }, // Stable signature used to detect whether all clients are watching the same file.
      contentUrl: { type: String, default: "" }, // Canonical content URL attached to this live session.
      startedAt: { type: Date, default: Date.now }, // Time the current live session began.
      endedAt: { type: Date, default: null }, // Time the live session was finalized/closed.
      totalWatchTime: { type: Number, default: 0 }, // Aggregate room watch seconds accumulated while the session is live.
      updatedBy: { type: String, default: "", index: true }, // Last user uid that changed the live session metadata.
    },
    { timestamps: true }
  )

  // Session highlights are embedded snapshots built from reactions/bookmarks so
  // a completed session can show its memorable moments without another join.
  const sessionHighlightSchema = new mongoose.Schema(
    {
      timestamp: { type: Number, default: 0 }, // Playback offset in seconds where the highlight happened.
      type: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction" }, // Normalized highlight category used by the UI and analytics.
      userUid: { type: String, default: "" }, // User who created the reaction/bookmark that produced this highlight.
      reactionType: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction" }, // Specific reaction label preserved for richer highlight summaries.
      emoji: { type: String, default: "" }, // Original emoji payload when the highlight came from emoji-based reactions.
      createdAt: { type: Date, default: Date.now }, // Time the highlight row was created during session finalization.
    },
    { _id: false }
  )

  // WatchSession is the durable historical record created after a room is
  // finalized. It powers dashboards, insights, streaks, and history views.
  const watchSessionSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true }, // Room share code the completed session came from.
      roomId: { type: String, default: "", index: true }, // Optional immutable room/session identifier used for dedupe when available.
      roomType: { type: String, enum: ["duo", "family", "friends"], default: "friends", index: true }, // Social room shape the session took place in.
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true }, // Mode used for the completed session: watch, podcast, music, reading, or study.
      participants: { type: [String], required: true, index: true }, // All participant uids involved in the session, used for history queries.
      relationshipId: { type: String, default: "", index: true }, // pairKey-like identifier when the session belongs to a two-user relationship context.
      relationshipType: { type: String, enum: ALLOWED_RELATIONSHIP_TYPES, default: "group", index: true }, // Relationship label derived from the room context when available.
      contentUrl: { type: String, default: "" }, // Final normalized content URL recorded for the session.
      contentTitle: { type: String, default: "" }, // Final media/document title shown in session history.
      contentType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown", index: true }, // Content family used for filtering and playback-specific analytics.
      genre: { type: String, default: "" }, // Derived genre tag inferred from the session content or later enrichment.
      moodTag: { type: String, default: "", index: true }, // Mood label attached to the room/session for social context.
      duration: { type: Number, default: 0 }, // Final completed session length in seconds.
      startedAt: { type: Date, default: Date.now, index: true }, // Session start time.
      endedAt: { type: Date, default: Date.now, index: true }, // Session end/finalization time.
      reactionsCount: { type: Number, default: 0 }, // Total number of reaction events counted for the session.
      highlights: { type: [sessionHighlightSchema], default: [] }, // Embedded memorable-moment rows built from reactions and bookmarks.
      createdBy: { type: String, default: "", index: true }, // User who originally created the room/session.
    },
    { timestamps: true }
  )

  // SessionReaction stores raw per-reaction events so highlights, counts, and
  // post-session summaries can be recomputed later.
  const sessionReactionSchema = new mongoose.Schema(
    {
      sessionId: { type: String, default: "", index: true }, // Optional finalized WatchSession id once reactions are attached after session close.
      roomCode: { type: String, default: "", index: true }, // Live room code used before a finalized session id exists.
      userUid: { type: String, required: true, index: true }, // User who created the reaction event.
      messageId: { type: String, default: "", index: true }, // Optional chat message id when the reaction is tied to chat rather than playback only.
      timestamp: { type: Number, default: 0 }, // Playback offset in seconds where the reaction happened.
      reactionType: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction", index: true }, // Normalized reaction label used in analytics and highlights.
      emoji: { type: String, default: "" }, // Original emoji payload when applicable.
      createdAt: { type: Date, default: Date.now, index: true }, // Event time for ordering and session summarization.
    },
    { timestamps: true }
  )

  // Session and activity indexes support feed ordering, relationship history,
  // room-history lookups, and post-session enrichment jobs.
  activityEventSchema.index({ uid: 1, occurredAt: -1 })
  watchSessionSchema.index({ participants: 1, endedAt: -1 })
  watchSessionSchema.index({ relationshipId: 1, endedAt: -1 })
  watchSessionSchema.index({ roomCode: 1, endedAt: -1 })
  watchSessionSchema.index(
    { roomId: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { roomId: { $type: "string", $ne: "" } }, // Only enforce uniqueness when a non-empty roomId was actually recorded.
    }
  )
  sessionReactionSchema.index({ sessionId: 1, createdAt: -1 })
  sessionReactionSchema.index({ roomCode: 1, createdAt: -1 })
  sessionReactionSchema.index({ userUid: 1, createdAt: -1 })

  // Reuse existing compiled models during development reloads.
  VideoSessionModel = mongoose.models.VideoSession || mongoose.model("VideoSession", videoSessionSchema)
  WatchSessionModel = mongoose.models.WatchSession || mongoose.model("WatchSession", watchSessionSchema)
  SessionReactionModel = mongoose.models.SessionReaction || mongoose.model("SessionReaction", sessionReactionSchema)
  ActivityEventModel = mongoose.models.ActivityEvent || mongoose.model("ActivityEvent", activityEventSchema)
} catch { }

module.exports = {
  VideoSessionModel,
  WatchSessionModel,
  SessionReactionModel,
  ActivityEventModel,
}
