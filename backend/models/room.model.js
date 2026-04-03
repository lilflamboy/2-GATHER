/**
 * Room persistence models for live sessions. A Room document stores durable
 * room metadata and playback/reading state, while RoomParticipant stores the
 * per-user join/leave history for that room over time.
 */

'use strict'

let RoomModel = null
let RoomParticipantModel = null

// These models load conditionally so the backend can still run without
// mongoose and fall back to the in-memory room store.
try {
  const mongoose = require('mongoose')
  const {
    ALLOWED_SESSION_MODES,
    ALLOWED_CONTENT_TYPES,
    MAX_ROOM_USERS,
  } = require('../config/constants.js')

  // A Room document captures the durable metadata for one share code, including
  // lifecycle timestamps, synchronized content state, and host permissions.
  const roomSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, unique: true, index: true }, // Uppercase share code users type to join a room; unique so one code maps to one durable room record.
      roomType: { type: String, enum: ["duo", "family", "friends"], default: "friends", index: true }, // High-level room social shape: duo for two-person sessions, family for shared family rooms, friends for general groups.
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true }, // Active engine mode such as watch, podcast, music, reading, or study.
      createdBy: { type: String, required: true, index: true }, // Firebase uid of the room creator/initial host.
      isActive: { type: Boolean, default: true, index: true }, // True while the room is still considered live and joinable.
      roomPasswordHash: { type: String, default: "" }, // Reserved hash field for protected rooms when password gating is enabled.
      maxParticipants: { type: Number, default: MAX_ROOM_USERS }, // Max room occupancy cap enforced during joins.
      moodTag: { type: String, default: "", index: true }, // Optional mood label attached to the room for discovery/history.
      contentUrl: { type: String, default: "" }, // Canonical synchronized media or document URL for the current session.
      contentType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown", index: true }, // Source family for the contentUrl so clients can choose the right player.
      playbackStatus: { type: String, enum: ["idle", "playing", "paused"], default: "idle", index: true }, // Current synchronized playback state for media-driven rooms.
      baseTime: { type: Number, default: 0 }, // Last authoritative playback position in seconds.
      startedAt: { type: Date, default: null }, // Timestamp from which playing state should advance when playback is active.
      // Host/member control flags that gate who can change shared playback
      // state without transferring ownership of the room.
      permissions: {
        play: { type: Boolean, default: true }, // Whether room members may trigger play events.
        pause: { type: Boolean, default: true }, // Whether room members may trigger pause events.
        seek: { type: Boolean, default: true }, // Whether room members may scrub/seek the shared timeline.
        skip: { type: Boolean, default: true }, // Whether room members may jump to bookmarks or skip-style actions.
      },
      createdAt: { type: Date, default: Date.now, index: true }, // Creation timestamp used for lifecycle cleanup and history sorting.
      expiresAt: { type: Date, default: Date.now, index: true }, // Planned expiry time after which the room should be auto-closed if inactive.
      closedAt: { type: Date, default: null }, // Timestamp recorded once the room is finalized/closed.
      lastActivityAt: { type: Date, default: Date.now, index: true }, // Last meaningful activity time used for room aging and dashboards.
    },
    { timestamps: true }
  )

  // RoomParticipant documents record each user's lifecycle inside a room so the
  // backend can rebuild history and authorization even after disconnects.
  const roomParticipantSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true }, // Uppercase room share code this participation row belongs to.
      userId: { type: String, required: true, index: true }, // Firebase uid of the participant.
      joinedAt: { type: Date, required: true, default: Date.now, index: true }, // First time the user joined this room record.
      leftAt: { type: Date, default: null }, // Most recent leave time when the user disconnects or exits.
      role: { type: String, default: "member" }, // Host/member role snapshot used for room authority and history views.
      isActive: { type: Boolean, default: true, index: true }, // Whether the user is currently treated as an active participant in the room.
    },
    { timestamps: true }
  )

  // One participant row is maintained per room/user pair and updated across
  // reconnects instead of creating duplicates for the same logical membership.
  roomParticipantSchema.index({ roomCode: 1, userId: 1 }, { unique: true })

  // Reuse existing compiled models during hot reloads/import churn.
  RoomModel = mongoose.models.Room || mongoose.model("Room", roomSchema)
  RoomParticipantModel = mongoose.models.RoomParticipant || mongoose.model("RoomParticipant", roomParticipantSchema)
} catch { }

module.exports = { RoomModel, RoomParticipantModel }
