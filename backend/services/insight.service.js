'use strict'

const {
  InsightModel, MilestoneModel,
  getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { pairKeyFromUsers } =
  require('./relationship.service.js')
const {
  uniqueStrings, getProfileStoreCopy, pushBounded,
} = require('../utils/helpers.js')
const {
  sanitizeActivityPayload, sanitize,
  sanitizeSharedMemoryGenre,
} = require('../utils/sanitize.js')
const { MAX_INSIGHT_SUMMARY_LENGTH } =
  require('../config/constants.js')

function normalizeMilestoneType(value) {
  const raw = String(value || "").trim().toLowerCase()
  if (!raw) return ""
  return raw.slice(0, 64)
}

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

function milestoneStoreKey(pairKey, type) {
  return `${String(pairKey || "")}__${normalizeMilestoneType(type)}`
}

async function upsertMilestone(payload = {}) {
  const normalized = normalizeMilestoneRow(payload)
  if (!normalized.pairKey || !normalized.type) return null

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

async function listMilestonesForUser(uid, partnerUid = "") {
  const selfUid = String(uid || "").trim()
  const partner = String(partnerUid || "").trim()
  if (!selfUid) return []

  if (partner) {
    const pairKey = pairKeyFromUsers(selfUid, partner)
    if (!pairKey) return []
    if (getMongoConnected()) {
      const rows = await MilestoneModel.find({ pairKey }).sort({ achievedAt: -1 }).limit(120).lean()
      return rows.map((row) => normalizeMilestoneRow(row))
    }
    return [...memoryStore.milestones.values()]
      .filter((row) => String(row.pairKey || "") === pairKey)
      .sort((a, b) => new Date(b.achievedAt || b.createdAt || Date.now()).getTime() - new Date(a.achievedAt || a.createdAt || Date.now()).getTime())
      .map((row) => normalizeMilestoneRow(row))
  }

  if (getMongoConnected()) {
    const rows = await MilestoneModel.find({ users: selfUid }).sort({ achievedAt: -1 }).limit(200).lean()
    return rows.map((row) => normalizeMilestoneRow(row))
  }

  return [...memoryStore.milestones.values()]
    .filter((row) => Array.isArray(row.users) && row.users.includes(selfUid))
    .sort((a, b) => new Date(b.achievedAt || b.createdAt || Date.now()).getTime() - new Date(a.achievedAt || a.createdAt || Date.now()).getTime())
    .map((row) => normalizeMilestoneRow(row))
}

async function upsertInsight(payload = {}) {
  const normalized = normalizeInsightRow(payload)
  if (!normalized.pairKey || !normalized.year) return null

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

async function getInsightForPairYear(pairKey, year) {
  const key = String(pairKey || "").trim()
  const targetYear = Math.max(2000, Math.min(2200, Math.floor(Number(year) || new Date().getFullYear())))
  if (!key) return null

  if (getMongoConnected()) {
    const row = await InsightModel.findOne({ pairKey: key, year: targetYear }).lean()
    return row ? normalizeInsightRow(row) : null
  }

  const row = memoryStore.insights.find((item) => String(item.pairKey || "") === key && Number(item.year) === targetYear)
  return row ? normalizeInsightRow(row) : null
}

async function listInsightsForUser(uid, { year = null, limit = 40 } = {}) {
  const selfUid = String(uid || "").trim()
  if (!selfUid) return []
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40))
  const normalizedYear = Number.isFinite(Number(year)) ? Math.floor(Number(year)) : null

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
  upsertMilestone,
  listMilestonesForUser,
  upsertInsight,
  getInsightForPairYear,
  listInsightsForUser,
}
