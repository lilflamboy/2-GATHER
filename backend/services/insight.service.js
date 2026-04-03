/**
 * Generates and serves relationship insights and milestones.
 * Insights are yearly summaries derived from watch-session history, while
 * milestones are durable achievement records like first session or 100 hours.
 */
'use strict'

const {
  InsightModel, MilestoneModel,
  getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { pairKeyFromUsers } =
  require('./relationship.service.js')
const { listWatchSessionsForRelationship } =
  require('./session.service.js')
const {
  uniqueStrings, getProfileStoreCopy, pushBounded,
} = require('../utils/helpers.js')
const { normalizeSessionMode } =
  require('../utils/normalize.js')
const {
  sanitizeActivityPayload, sanitize,
  sanitizeSharedMemoryGenre,
} = require('../utils/sanitize.js')
const { MAX_INSIGHT_SUMMARY_LENGTH } =
  require('../config/constants.js')

/**
 * Normalizes a milestone type key.
 * @param {string} value - The raw milestone type.
 * @returns {string} The normalized milestone type.
 */
function normalizeMilestoneType(value) {
  const raw = String(value || "").trim().toLowerCase()
  if (!raw) return ""
  return raw.slice(0, 64)
}

/**
 * Normalizes a milestone row returned from storage.
 * @param {object} [row={}] - The raw milestone row.
 * @returns {object} The normalized milestone record.
 */
function normalizeMilestoneRow(row = {}) {
  const users = uniqueStrings(Array.isArray(row.users) ? row.users : [])
  const pairKey = String(row.pairKey || "")
  const relationshipId = String(row.relationshipId || pairKey)
  return {
    id: String(row._id || row.id || ""),
    relationshipId,
    pairKey,
    users,
    type: normalizeMilestoneType(row.type),
    achievedAt: row.achievedAt ? new Date(row.achievedAt) : new Date(),
    payload: sanitizeActivityPayload(row.payload || {}),
  }
}

/**
 * Normalizes an insight row returned from storage.
 * @param {object} [row={}] - The raw insight row.
 * @returns {object} The normalized insight record.
 */
function normalizeInsightRow(row = {}) {
  const year = Math.max(2000, Math.min(2200, Math.floor(Number(row.year) || new Date().getFullYear())))
  return {
    id: String(row._id || row.id || ""),
    relationshipId: String(row.relationshipId || row.pairKey || ""),
    pairKey: String(row.pairKey || ""),
    users: uniqueStrings(Array.isArray(row.users) ? row.users : []),
    year,
    summaryText: sanitize(String(row.summaryText || "")).slice(0, MAX_INSIGHT_SUMMARY_LENGTH),
    favoriteGenre: sanitizeSharedMemoryGenre(row.favoriteGenre || ""),
    watchPattern: sanitize(String(row.watchPattern || "")).slice(0, 120),
    moodTrend: sanitize(String(row.moodTrend || "")).slice(0, 120),
    generatedAt: row.generatedAt ? new Date(row.generatedAt) : new Date(),
  }
}

/**
 * Builds the in-memory composite key for a milestone.
 * @param {string} pairKey - The relationship pair key.
 * @param {string} type - The milestone type.
 * @returns {string} The composite store key.
 */
function milestoneStoreKey(pairKey, type) {
  return `${String(pairKey || "")}__${normalizeMilestoneType(type)}`
}

/**
 * Buckets a date into a friendly time-of-day slot.
 * @param {Date|string|number} value - The date-like value to inspect.
 * @returns {string} The derived time-slot label.
 */
function timeSlotFromDate(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 'unknown'
  const hour = date.getHours()
  if (hour >= 22 || hour < 5) return 'late_night'
  if (hour >= 18) return 'evening'
  if (hour >= 12) return 'afternoon'
  return 'morning'
}

/**
 * Returns the most common labels from a counter map.
 * @param {Map<string, number>} counterMap - The label frequency map.
 * @param {number} [limit=5] - The number of labels to return.
 * @returns {string[]} The top labels ordered by count then name.
 */
function topLabelsFromCounter(counterMap, limit = 5) {
  return [...counterMap.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0]) // Stable alphabetical tie-breaker keeps summaries deterministic.
    })
    .slice(0, Math.max(1, limit))
    .map(([label]) => label)
}

/**
 * Summarizes the dominant mood trend across a set of sessions.
 * @param {object[]} [rows=[]] - Session-like rows with mood tags.
 * @returns {string} The summarized mood label.
 */
function summarizeMoodTrend(rows = []) {
  const moodCounter = new Map()
  // Count sanitized mood tags so noisy user input does not skew the summary.
  rows.forEach((row) => {
    const mood = sanitize(String(row.moodTag || '')).toLowerCase()
    if (!mood) return
    moodCounter.set(mood, (moodCounter.get(mood) || 0) + 1)
  })
  const topMood = topLabelsFromCounter(moodCounter, 1)[0] || 'steady'
  return topMood.replace(/_/g, ' ')
}

/**
 * Summarizes when and how a pair most often watches together.
 * @param {object[]} [rows=[]] - Session rows used to derive the pattern.
 * @returns {string} A combined time-slot and session-mode summary.
 */
function summarizeWatchPattern(rows = []) {
  const slotCounter = new Map()
  const modeCounter = new Map()
  // Build counters for both time-of-day and session-mode preferences.
  rows.forEach((session) => {
    const slot = timeSlotFromDate(session.startedAt || session.endedAt || session.createdAt)
    if (slot && slot !== 'unknown') {
      slotCounter.set(slot, (slotCounter.get(slot) || 0) + 1)
    }
    const mode = normalizeSessionMode(session.sessionMode || 'watch')
    modeCounter.set(mode, (modeCounter.get(mode) || 0) + 1)
  })

  const topSlot = topLabelsFromCounter(slotCounter, 1)[0] || 'mixed-hours'
  const topMode = topLabelsFromCounter(modeCounter, 1)[0] || 'watch'
  return `${topSlot} / ${topMode}`
}

/**
 * Creates or updates a milestone record for a relationship.
 * @param {object} [payload={}] - The milestone payload.
 * @returns {Promise<object|null>} The normalized milestone or null when invalid.
 */
async function upsertMilestone(payload = {}) {
  const normalized = normalizeMilestoneRow(payload)
  if (!normalized.pairKey || !normalized.type) return null

  // Use an upsert so milestone writes are idempotent across re-computation passes.
  if (getMongoConnected()) {
    await MilestoneModel.updateOne(
      { pairKey: normalized.pairKey, type: normalized.type },
      {
        $set: {
          relationshipId: normalized.relationshipId,
          users: normalized.users,
          achievedAt: normalized.achievedAt,
          payload: normalized.payload,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    )
    const row = await MilestoneModel.findOne({ pairKey: normalized.pairKey, type: normalized.type }).lean()
    return normalizeMilestoneRow(row)
  }

  // Memory mode stores milestones in a map keyed by pair and type.
  const key = milestoneStoreKey(normalized.pairKey, normalized.type)
  const existing = memoryStore.milestones.get(key)
  const next = {
    ...(existing || {}),
    ...normalized,
    id: existing?.id || normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: existing?.createdAt || new Date(),
  }
  memoryStore.milestones.set(key, getProfileStoreCopy(next))
  return normalizeMilestoneRow(next)
}

/**
 * Lists milestones for one user or for one specific pair.
 * @param {string} uid - The requesting user's UID.
 * @param {string} [partnerUid=''] - Optional partner UID for pair scoping.
 * @returns {Promise<object[]>} Matching milestones ordered newest-first.
 */
async function listMilestonesForUser(uid, partnerUid = "") {
  const selfUid = String(uid || "").trim()
  const partner = String(partnerUid || "").trim()
  if (!selfUid) return []

  // Pair-scoped queries are used for relationship timelines and detail pages.
  if (partner) {
    const pairKey = pairKeyFromUsers(selfUid, partner)
    if (!pairKey) return []
    if (getMongoConnected()) {
      const rows = await MilestoneModel.find({ pairKey }).sort({ achievedAt: -1 }).limit(120).lean()
      return rows.map((row) => normalizeMilestoneRow(row))
    }
    // The fallback map is filtered by pair key and sorted newest-first.
    return [...memoryStore.milestones.values()]
      .filter((row) => String(row.pairKey || "") === pairKey)
      .sort((a, b) => new Date(b.achievedAt || b.createdAt || Date.now()).getTime() - new Date(a.achievedAt || a.createdAt || Date.now()).getTime())
      .map((row) => normalizeMilestoneRow(row))
  }

  // User-scoped listing scans all milestones that mention the user.
  if (getMongoConnected()) {
    const rows = await MilestoneModel.find({ users: selfUid }).sort({ achievedAt: -1 }).limit(200).lean()
    return rows.map((row) => normalizeMilestoneRow(row))
  }

  return [...memoryStore.milestones.values()]
    .filter((row) => Array.isArray(row.users) && row.users.includes(selfUid))
    .sort((a, b) => new Date(b.achievedAt || b.createdAt || Date.now()).getTime() - new Date(a.achievedAt || a.createdAt || Date.now()).getTime())
    .map((row) => normalizeMilestoneRow(row))
}

/**
 * Creates or updates a yearly relationship insight.
 * Updated insight rows reflect the latest generated summary for the pair/year.
 * @param {object} [payload={}] - The insight payload.
 * @returns {Promise<object|null>} The normalized insight row or null when invalid.
 */
async function upsertInsight(payload = {}) {
  const normalized = normalizeInsightRow(payload)
  if (!normalized.pairKey || !normalized.year) return null

  // Upsert by pair and year so yearly insights can be regenerated safely.
  if (getMongoConnected()) {
    await InsightModel.updateOne(
      { pairKey: normalized.pairKey, year: normalized.year },
      {
        $set: {
          relationshipId: normalized.relationshipId,
          users: normalized.users,
          summaryText: normalized.summaryText,
          favoriteGenre: normalized.favoriteGenre,
          watchPattern: normalized.watchPattern,
          moodTrend: normalized.moodTrend,
          generatedAt: normalized.generatedAt,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    )
    const row = await InsightModel.findOne({ pairKey: normalized.pairKey, year: normalized.year }).lean()
    return normalizeInsightRow(row)
  }

  // Memory mode dedupes by pair/year inside the fallback insights array.
  const index = memoryStore.insights.findIndex(
    (item) => String(item.pairKey || "") === normalized.pairKey && Number(item.year) === normalized.year
  )
  const row = {
    ...normalized,
    id: normalized.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
  if (index === -1) {
    pushBounded(memoryStore.insights, row, 5000)
  } else {
    memoryStore.insights[index] = { ...memoryStore.insights[index], ...row }
  }
  return normalizeInsightRow(row)
}

/**
 * Loads a single yearly insight by pair key and year.
 * @param {string} pairKey - The relationship pair key.
 * @param {number} year - The target calendar year.
 * @returns {Promise<object|null>} The matching yearly insight, if any.
 */
async function getInsightForPairYear(pairKey, year) {
  const key = String(pairKey || "").trim()
  const targetYear = Math.max(2000, Math.min(2200, Math.floor(Number(year) || new Date().getFullYear())))
  if (!key) return null

  // MongoDB looks up the pair/year composite directly.
  if (getMongoConnected()) {
    const row = await InsightModel.findOne({ pairKey: key, year: targetYear }).lean()
    return row ? normalizeInsightRow(row) : null
  }

  // The fallback array uses the same pair/year matching rule.
  const row = memoryStore.insights.find((item) => String(item.pairKey || "") === key && Number(item.year) === targetYear)
  return row ? normalizeInsightRow(row) : null
}

/**
 * Recomputes the yearly relationship insight from session history.
 * This pulls session data for the target year, derives genre and pattern
 * summaries, builds the summary text, and then upserts the insight row.
 * @param {object} relationshipRow - The relationship context for the pair.
 * @param {number} [year=new Date().getFullYear()] - The target year to regenerate.
 * @returns {Promise<object|null>} The regenerated insight or null when no sessions exist.
 */
async function regenerateRelationshipInsight(relationshipRow, year = new Date().getFullYear()) {
  const pairKey = String(relationshipRow?.pairKey || '')
  if (!pairKey) return null
  const users = uniqueStrings(Array.isArray(relationshipRow?.users) ? relationshipRow.users : [])
  const targetYear = Math.max(2000, Math.min(2200, Math.floor(Number(year) || new Date().getFullYear())))
  const sessions = await listWatchSessionsForRelationship(pairKey, { year: targetYear, limit: 1200 })
  if (sessions.length === 0) return null

  // Aggregate favorite genres and total shared duration from the raw sessions.
  const genreCounter = new Map()
  let totalDuration = 0
  sessions.forEach((session) => {
    const genre = sanitizeSharedMemoryGenre(session.genre || '')
    if (genre) genreCounter.set(genre, (genreCounter.get(genre) || 0) + 1)
    totalDuration += Math.max(0, Number(session.duration) || 0)
  })

  const favoriteGenre = topLabelsFromCounter(genreCounter, 1)[0] || 'mixed'
  const watchPattern = summarizeWatchPattern(sessions)
  const moodTrend = summarizeMoodTrend(sessions)
  const sessionHours = Math.round((totalDuration / 3600) * 10) / 10
  // The summary text is regenerated from canonical stats so it stays deterministic.
  const summaryText = sanitize(
    `In ${targetYear}, this relationship logged ${sessions.length} shared sessions (${sessionHours}h). `
    + `Top genre: ${favoriteGenre}. Pattern: ${watchPattern}. Mood trend: ${moodTrend}.`
  ).slice(0, MAX_INSIGHT_SUMMARY_LENGTH)

  return upsertInsight({
    relationshipId: pairKey,
    pairKey,
    users,
    year: targetYear,
    summaryText,
    favoriteGenre,
    watchPattern,
    moodTrend,
    generatedAt: new Date(),
  })
}

/**
 * Lists yearly insights for one user with optional year filtering.
 * @param {string} uid - The user whose insights should be listed.
 * @param {object} [options={}] - Optional year and limit filters.
 * @returns {Promise<object[]>} Matching yearly insights ordered newest-first.
 */
async function listInsightsForUser(uid, { year = null, limit = 40 } = {}) {
  const selfUid = String(uid || "").trim()
  if (!selfUid) return []
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40))
  const normalizedYear = Number.isFinite(Number(year)) ? Math.floor(Number(year)) : null

  // Query MongoDB directly when the persistent insight collection is available.
  if (getMongoConnected()) {
    const query = { users: selfUid }
    if (normalizedYear && normalizedYear >= 2000 && normalizedYear <= 2200) {
      query.year = normalizedYear
    }
    const rows = await InsightModel.find(query)
      .sort({ year: -1, generatedAt: -1 })
      .limit(safeLimit)
      .lean()
    return rows.map((row) => normalizeInsightRow(row))
  }

  // Memory mode rebuilds the same year filter and ordering over the fallback insight list.
  return memoryStore.insights
    .filter((item) => Array.isArray(item.users) && item.users.includes(selfUid))
    .filter((item) => !normalizedYear || Number(item.year) === normalizedYear)
    .sort((a, b) => {
      if (Number(b.year || 0) !== Number(a.year || 0)) {
        return Number(b.year || 0) - Number(a.year || 0)
      }
      return new Date(b.generatedAt || b.createdAt || Date.now()).getTime()
        - new Date(a.generatedAt || a.createdAt || Date.now()).getTime()
    })
    .slice(0, safeLimit)
    .map((item) => normalizeInsightRow(item))
}

module.exports = {
  normalizeMilestoneType,
  normalizeMilestoneRow,
  normalizeInsightRow,
  milestoneStoreKey,
  timeSlotFromDate,
  topLabelsFromCounter,
  summarizeMoodTrend,
  summarizeWatchPattern,
  upsertMilestone,
  listMilestonesForUser,
  upsertInsight,
  getInsightForPairYear,
  regenerateRelationshipInsight,
  listInsightsForUser,
}
