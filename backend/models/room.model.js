'use strict'

let RoomModel = null
let RoomParticipantModel = null

try {
  const mongoose = require('mongoose')
  const {
    ALLOWED_SESSION_MODES,
    ALLOWED_CONTENT_TYPES,
    MAX_ROOM_USERS,
  } = require('../config/constants.js')

  const roomSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, unique: true, index: true },
      roomType: { type: String, enum: ["duo", "family", "friends"], default: "friends", index: true },
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true },
      createdBy: { type: String, required: true, index: true },
      isActive: { type: Boolean, default: true, index: true },
      roomPasswordHash: { type: String, default: "" },
      maxParticipants: { type: Number, default: MAX_ROOM_USERS },
      moodTag: { type: String, default: "", index: true },
      contentUrl: { type: String, default: "" },
      contentType: { type: String, enum: ALLOWED_CONTENT_TYPES, default: "unknown", index: true },
      playbackStatus: { type: String, enum: ["idle", "playing", "paused"], default: "idle", index: true },
      baseTime: { type: Number, default: 0 },
      startedAt: { type: Date, default: null },
      permissions: {
        play: { type: Boolean, default: true },
        pause: { type: Boolean, default: true },
        seek: { type: Boolean, default: true },
        skip: { type: Boolean, default: true },
      },
      createdAt: { type: Date, default: Date.now, index: true },
      expiresAt: { type: Date, default: Date.now, index: true },
      closedAt: { type: Date, default: null },
      lastActivityAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  )

  const roomParticipantSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true },
      userId: { type: String, required: true, index: true },
      joinedAt: { type: Date, required: true, default: Date.now, index: true },
      leftAt: { type: Date, default: null },
      role: { type: String, default: "member" },
      isActive: { type: Boolean, default: true, index: true },
    },
    { timestamps: true }
  )

  roomParticipantSchema.index({ roomCode: 1, userId: 1 }, { unique: true })

  RoomModel = mongoose.models.Room || mongoose.model("Room", roomSchema)
  RoomParticipantModel = mongoose.models.RoomParticipant || mongoose.model("RoomParticipant", roomParticipantSchema)
} catch { }

module.exports = { RoomModel, RoomParticipantModel }
