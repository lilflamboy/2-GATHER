'use strict'

let RelationshipModel = null
let CoupleSpaceModel = null

try {
  const mongoose = require('mongoose')
  const { ALLOWED_SESSION_MODES } =
    require('../config/constants.js')

  const watchlistItemSchema = new mongoose.Schema(
    {
      id: { type: String, required: true },
      title: { type: String, required: true },
      url: { type: String, default: "" },
      notes: { type: String, default: "" },
      done: { type: Boolean, default: false },
      addedBy: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
    },
    { _id: false }
  )

  const coupleSpaceSchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, unique: true, index: true },
      users: { type: [String], required: true },
      watchlist: { type: [watchlistItemSchema], default: [] },
      updatedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
  )

  const relationshipSchema = new mongoose.Schema(
    {
      pairKey: { type: String, required: true, unique: true, index: true },
      users: { type: [String], required: true, index: true },
      requesterUid: { type: String, default: "", index: true },
      recipientUid: { type: String, default: "", index: true },
      status: { type: String, enum: ["pending", "accepted", "rejected", "blocked"], default: "pending", index: true },
      relationshipType: { type: String, enum: ["couple", "friends", "family"], default: "friends", index: true },
      totalWatchTime: { type: Number, default: 0 },
      totalSessions: { type: Number, default: 0 },
      longestSession: { type: Number, default: 0 },
      streak: { type: Number, default: 0 },
      firstWatchedAt: { type: Date, default: null },
      lastWatchedAt: { type: Date, default: null },
      topGenres: { type: [String], default: [] },
      activeTimeSlots: { type: [String], default: [] },
      lastSessionMode: { type: String, enum: ALLOWED_SESSION_MODES, default: "watch" },
      requestedBy: { type: String, default: "", index: true },
      lastActionBy: { type: String, default: "", index: true },
      lastActionAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
  )

  coupleSpaceSchema.index({ users: 1 })
  relationshipSchema.index({ users: 1 })
  relationshipSchema.index({ requesterUid: 1, status: 1, updatedAt: -1 })
  relationshipSchema.index({ recipientUid: 1, status: 1, updatedAt: -1 })

  RelationshipModel = mongoose.models.Relationship || mongoose.model("Relationship", relationshipSchema)
  CoupleSpaceModel = mongoose.models.CoupleSpace || mongoose.model("CoupleSpace", coupleSpaceSchema)
} catch { }

module.exports = { RelationshipModel, CoupleSpaceModel }
