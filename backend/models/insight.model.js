'use strict'

let ChatArchiveModel = null
let InsightModel = null
let MilestoneModel = null

try {
  const mongoose = require('mongoose')

  const chatArchiveSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true },
      messageId: { type: String, required: true, unique: true },
      uid: { type: String, required: true, index: true },
      senderName: { type: String, default: "" },
      senderUsername: { type: String, default: "" },
      text: { type: String, default: "" },
      type: { type: String, default: "text" },
      timestamp: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  )

  const milestoneSchema = new mongoose.Schema(
    {
      relationshipId: { type: String, default: "", index: true },
      pairKey: { type: String, default: "", index: true },
      users: { type: [String], default: [], index: true },
      type: { type: String, required: true, index: true },
      achievedAt: { type: Date, default: Date.now, index: true },
      payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
  )

  const insightSchema = new mongoose.Schema(
    {
      relationshipId: { type: String, default: "", index: true },
      pairKey: { type: String, default: "", index: true },
      users: { type: [String], default: [], index: true },
      year: { type: Number, required: true, index: true },
      summaryText: { type: String, default: "" },
      favoriteGenre: { type: String, default: "" },
      watchPattern: { type: String, default: "" },
      moodTrend: { type: String, default: "" },
      generatedAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  )

  chatArchiveSchema.index({ roomCode: 1, timestamp: -1 })
  milestoneSchema.index({ pairKey: 1, achievedAt: -1 })
  milestoneSchema.index(
    { pairKey: 1, type: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { pairKey: { $type: "string", $ne: "" }, type: { $type: "string", $ne: "" } },
    }
  )
  milestoneSchema.index({ users: 1, achievedAt: -1 })
  insightSchema.index({ pairKey: 1, generatedAt: -1 })
  insightSchema.index(
    { pairKey: 1, year: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { pairKey: { $type: "string", $ne: "" } },
    }
  )
  insightSchema.index({ users: 1, year: -1 })

  ChatArchiveModel = mongoose.models.ChatArchive || mongoose.model("ChatArchive", chatArchiveSchema)
  InsightModel = mongoose.models.Insight || mongoose.model("Insight", insightSchema)
  MilestoneModel = mongoose.models.Milestone || mongoose.model("Milestone", milestoneSchema)
} catch { }

module.exports = { ChatArchiveModel, InsightModel, MilestoneModel }
