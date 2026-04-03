'use strict'

let SharedMemoryModel = null
let MemoryEventModel = null

try {
  const mongoose = require('mongoose')
  const { ALLOWED_SESSION_MODES } =
    require('../config/constants.js')

  const memoryEventSchema = new mongoose.Schema(
    {
      users: { type: [String], required: true, index: true },
      seconds: { type: Number, required: true },
      occurredAt: { type: Date, required: true, default: Date.now, index: true },
      roomCode: { type: String, default: "" },
    },
    { timestamps: true }
  )

  const sharedMemorySchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, index: true },
      user1Id: { type: String, required: true, index: true },
      user2Id: { type: String, required: true, index: true },
      roomCode: { type: String, default: "", index: true },
      date: { type: Date, default: Date.now, index: true },
      memoryNote: { type: String, default: "" },
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true },
      genre: { type: String, default: "" },
      moodTag: { type: String, default: "" },
      highlightTimestamp: { type: String, default: "" },
      sessionMinutes: { type: Number, default: 0 },
      reactionCount: { type: Number, default: 0 },
      createdBy: { type: String, required: true, index: true },
    },
    { timestamps: true }
  )

  memoryEventSchema.index({ users: 1, occurredAt: -1 })
  sharedMemorySchema.index({ pairKey: 1, date: -1 })

  SharedMemoryModel = mongoose.models.SharedMemory || mongoose.model("SharedMemory", sharedMemorySchema)
  MemoryEventModel = mongoose.models.MemoryEvent || mongoose.model("MemoryEvent", memoryEventSchema)
} catch { }

module.exports = { SharedMemoryModel, MemoryEventModel }
