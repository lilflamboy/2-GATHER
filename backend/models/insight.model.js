/**
 * Insight-domain persistence models. Insight stores yearly relationship
 * summaries, Milestone stores achievement-style records for a relationship, and
 * ChatArchive stores durable chat history separately from live room state so
 * active rooms can stay lightweight while history remains queryable.
 */

'use strict'

let ChatArchiveModel = null
let InsightModel = null
let MilestoneModel = null

// These models load conditionally so the server can keep running in in-memory
// mode when mongoose is unavailable.
try {
  const mongoose = require('mongoose')

  // ChatArchive keeps durable chat history after live room messages have moved
  // out of transient socket state.
  const chatArchiveSchema = new mongoose.Schema(
    {
      roomCode: { type: String, required: true, index: true }, // Room share code the archived message belonged to.
      messageId: { type: String, required: true, unique: true }, // Stable message id so each chat event is archived only once.
      uid: { type: String, required: true, index: true }, // Sender uid for the archived message.
      senderName: { type: String, default: "" }, // Display name snapshot captured at send time.
      senderUsername: { type: String, default: "" }, // Username snapshot captured at send time.
      text: { type: String, default: "" }, // Sanitized message body.
      type: { type: String, default: "text" }, // Message category such as text or bookmark.
      timestamp: { type: Date, default: Date.now, index: true }, // Original message timestamp used for room-history ordering.
    },
    { timestamps: true }
  )

  // Milestones are durable achievements earned by a pair/relationship, such as
  // streak or time-together thresholds.
  const milestoneSchema = new mongoose.Schema(
    {
      relationshipId: { type: String, default: "", index: true }, // Relationship identifier/pair handle when available from higher-level services.
      pairKey: { type: String, default: "", index: true }, // Sorted uid pair owning the achievement.
      users: { type: [String], default: [], index: true }, // Participant uids copied for user-centric milestone queries.
      type: { type: String, required: true, index: true }, // Milestone category such as streak, first_session, or hours_together.
      achievedAt: { type: Date, default: Date.now, index: true }, // When the milestone was first reached.
      payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // Flexible data blob with milestone-specific numbers and labels.
    },
    { timestamps: true }
  )

  // Insights are generated yearly summaries for a relationship, keeping the
  // derived summary separate from raw sessions and milestones.
  const insightSchema = new mongoose.Schema(
    {
      relationshipId: { type: String, default: "", index: true }, // Relationship identifier/pair handle when available.
      pairKey: { type: String, default: "", index: true }, // Sorted uid pair this yearly summary belongs to.
      users: { type: [String], default: [], index: true }, // Participant uids copied for user-centric insight queries.
      year: { type: Number, required: true, index: true }, // Calendar year the summary covers.
      summaryText: { type: String, default: "" }, // Generated narrative summary of the relationship's year together.
      favoriteGenre: { type: String, default: "" }, // Derived top genre for the year.
      watchPattern: { type: String, default: "" }, // Derived narrative about when/how the pair watched together.
      moodTrend: { type: String, default: "" }, // Derived narrative about the pair's mood trend across the year.
      generatedAt: { type: Date, default: Date.now, index: true }, // When this yearly summary was generated or refreshed.
    },
    { timestamps: true }
  )

  // These indexes support room chat history, milestone dashboards, and
  // one-insight-per-pair-per-year guarantees.
  chatArchiveSchema.index({ roomCode: 1, timestamp: -1 })
  milestoneSchema.index({ pairKey: 1, achievedAt: -1 })
  milestoneSchema.index(
    { pairKey: 1, type: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { pairKey: { $type: "string", $ne: "" }, type: { $type: "string", $ne: "" } }, // Only enforce uniqueness for fully formed pair/type milestone rows.
    }
  )
  milestoneSchema.index({ users: 1, achievedAt: -1 })
  insightSchema.index({ pairKey: 1, generatedAt: -1 })
  insightSchema.index(
    { pairKey: 1, year: 1 },
    {
      unique: true,
      sparse: true,
      partialFilterExpression: { pairKey: { $type: "string", $ne: "" } }, // Keep one yearly insight per pair while ignoring incomplete placeholder rows.
    }
  )
  insightSchema.index({ users: 1, year: -1 })

  // Reuse compiled models during repeated imports and hot reloads.
  ChatArchiveModel = mongoose.models.ChatArchive || mongoose.model("ChatArchive", chatArchiveSchema)
  InsightModel = mongoose.models.Insight || mongoose.model("Insight", insightSchema)
  MilestoneModel = mongoose.models.Milestone || mongoose.model("Milestone", milestoneSchema)
} catch { }

module.exports = { ChatArchiveModel, InsightModel, MilestoneModel }
