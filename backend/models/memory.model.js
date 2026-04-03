/**
 * Memory-domain persistence models. MemoryEvent stores raw shared watch-time
 * overlap between users, while SharedMemory stores user-authored memory notes
 * about a session. Together they power the memories timeline and richer shared
 * memory features.
 */

'use strict'

let SharedMemoryModel = null
let MemoryEventModel = null

// These models load conditionally so the backend can fall back to the
// in-memory store when mongoose is unavailable.
try {
  const mongoose = require('mongoose')
  const { ALLOWED_SESSION_MODES } =
    require('../config/constants.js')

  // MemoryEvent is the low-level "you spent time together" record created from
  // overlapping room participation and finalized sessions.
  const memoryEventSchema = new mongoose.Schema(
    {
      users: { type: [String], required: true, index: true }, // Sorted uid pair for the two users who shared the time together.
      seconds: { type: Number, required: true }, // Duration of the overlap chunk in seconds; multiple events accumulate over time.
      occurredAt: { type: Date, required: true, default: Date.now, index: true }, // When this watch-time overlap happened.
      roomCode: { type: String, default: "" }, // Optional room code the overlap came from.
    },
    { timestamps: true }
  )

  // SharedMemory stores the richer user-created note that turns raw overlap
  // into a memorable moment with mood, genre, and highlight context.
  const sharedMemorySchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, index: true }, // Sorted uid pair (`uidA__uidB`) connecting the memory to a relationship.
      user1Id: { type: String, required: true, index: true }, // First participant uid in the stored pair.
      user2Id: { type: String, required: true, index: true }, // Second participant uid in the stored pair.
      roomCode: { type: String, default: "", index: true }, // Optional room code where the memorable session happened.
      date: { type: Date, default: Date.now, index: true }, // User-facing date assigned to this memory entry.
      memoryNote: { type: String, default: "" }, // Freeform memory text written by the creator.
      sessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch", index: true }, // Session mode associated with the memory.
      genre: { type: String, default: "" }, // Genre label captured for the memorable session.
      moodTag: { type: String, default: "" }, // Mood label describing the tone of the memory.
      highlightTimestamp: { type: String, default: "" }, // Human-readable timestamp string pointing to the memorable moment.
      sessionMinutes: { type: Number, default: 0 }, // Approximate session length in minutes captured when the memory was created.
      reactionCount: { type: Number, default: 0 }, // Number of reactions/highlights associated with that session.
      createdBy: { type: String, required: true, index: true }, // User who authored the shared memory note.
    },
    { timestamps: true }
  )

  // Pair/date lookups are the main query path for memory timelines and shared
  // memory dashboards.
  memoryEventSchema.index({ users: 1, occurredAt: -1 })
  sharedMemorySchema.index({ pairKey: 1, date: -1 })

  // Reuse compiled models during repeated imports and hot reloads.
  SharedMemoryModel = mongoose.models.SharedMemory || mongoose.model("SharedMemory", sharedMemorySchema)
  MemoryEventModel = mongoose.models.MemoryEvent || mongoose.model("MemoryEvent", memoryEventSchema)
} catch { }

module.exports = { SharedMemoryModel, MemoryEventModel }
