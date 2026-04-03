'use strict'

let VideoSessionModel = null
let WatchSessionModel = null
let SessionReactionModel = null
let ActivityEventModel = null

try {
  const mongoose = require('mongoose')
  const {
    ALLOWED_SESSION_MODES,
    ALLOWED_CONTENT_TYPES,
    ALLOWED_REACTION_TYPES,
    ALLOWED_RELATIONSHIP_TYPES,
  } = require('../config/constants.js')

  const activityEventSchema = new mongoose.Schema(
    {
      uid: { type: String, required: true, index: true },
      type: { type: String, required: true, index: true },
      roomCode: { type: String, default: "", index: true },
      targetUid: { type: String, default: "", index: true },
      payload: { type: mongoose.Schema.Types.Mixed, default: {} },
      occurredAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  )

  const videoSessionSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, unique: true, index: true },
      videoName: { type: String, default: "" },
      duration: { type: Number, default: 0 },
      sourceType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown" },
      fileFingerprint: { type: String, default: "" },
      contentUrl: { type: String, default: "" },
      startedAt: { type: Date, default: Date.now },
      endedAt: { type: Date, default: null },
      totalWatchTime: { type: Number, default: 0 },
      updatedBy: { type: String, default: "", index: true },
    },
    { timestamps: true }
  )

  const sessionHighlightSchema = new mongoose.Schema(
    {
      timestamp: { type: Number, default: 0 },
      type: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction" },
      userUid: { type: String, default: "" },
      reactionType: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction" },
      emoji: { type: String, default: "" },
      createdAt: { type: Date, default: Date.now },
    },
    { _id: false }
  )

  const watchSessionSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true },
      roomId: { type: String, default: "", index: true },
      roomType: { type: String, enum: ["duo", "family", "friends"], default: "friends", index: true },
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true },
      participants: { type: [String], required: true, index: true },
      relationshipId: { type: String, default: "", index: true },
      relationshipType: { type: String, enum: ALLOWED_RELATIONSHIP_TYPES, default: "group", index: true },
      contentUrl: { type: String, default: "" },
      contentTitle: { type: String, default: "" },
      contentType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown", index: true },
      genre: { type: String, default: "" },
      moodTag: { type: String, default: "", index: true },
      duration: { type: Number, default: 0 },
      startedAt: { type: Date, default: Date.now, index: true },
      endedAt: { type: Date, default: Date.now, index: true },
      reactionsCount: { type: Number, default: 0 },
      highlights: { type: [sessionHighlightSchema], default: [] },
      createdBy: { type: String, default: "", index: true },
    },
    { timestamps: true }
  )

  const sessionReactionSchema = new mongoose.Schema(
    {
      sessionId: { type: String, default: "", index: true },
      roomCode: { type: String, default: "", index: true },
      userUid: { type: String, required: true, index: true },
      messageId: { type: String, default: "", index: true },
      timestamp: { type: Number, default: 0 },
      reactionType: { type: String, enum: ALLOWED_REACTION_TYPES, default: "reaction", index: true },
      emoji: { type: String, default: "" },
      createdAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  )

  activityEventSchema.index({ uid: 1, occurredAt: -1 })
  watchSessionSchema.index({ participants: 1, endedAt: -1 })
  watchSessionSchema.index({ relationshipId: 1, endedAt: -1 })
  watchSessionSchema.index({ roomCode: 1, endedAt: -1 })
  watchSessionSchema.index(
    { roomId: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { roomId: { $type: "string", $ne: "" } },
    }
  )
  sessionReactionSchema.index({ sessionId: 1, createdAt: -1 })
  sessionReactionSchema.index({ roomCode: 1, createdAt: -1 })
  sessionReactionSchema.index({ userUid: 1, createdAt: -1 })

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
