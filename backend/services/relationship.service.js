'use strict'

const {
  RelationshipModel, CoupleSpaceModel,
  getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const {
  uniqueStrings, getProfileStoreCopy,
} = require('../utils/helpers.js')
const { sanitize } =
  require('../utils/sanitize.js')
const {
  ALLOWED_RELATIONSHIP_TYPES,
  MAX_WATCHLIST_ITEMS,
  MAX_WATCHLIST_TITLE_LENGTH,
  MAX_WATCHLIST_URL_LENGTH,
  MAX_WATCHLIST_NOTES_LENGTH,
} = require('../config/constants.js')

function normalizeRelationshipType(value, fallback = 'friends') {
  const raw = String(value || '').trim().toLowerCase()
  if (ALLOWED_RELATIONSHIP_TYPES.includes(raw)) return raw
  return ALLOWED_RELATIONSHIP_TYPES.includes(fallback) ? fallback : 'friends'
}

function sortedPairUsers(uidA, uidB) {
  if (!uidA || !uidB || uidA === uidB) return null
  return [uidA, uidB].sort()
}

function pairKeyFromUsers(uidA, uidB) {
  const users = sortedPairUsers(uidA, uidB)
  return users ? users.join("__") : null
}

function normalizeWatchlistItem(item = {}) {
  return {
    id: String(item.id || ""),
    title: sanitize(String(item.title || "")).slice(0, MAX_WATCHLIST_TITLE_LENGTH),
    url: String(item.url || "").trim().slice(0, MAX_WATCHLIST_URL_LENGTH),
    notes: sanitize(String(item.notes || "")).slice(0, MAX_WATCHLIST_NOTES_LENGTH),
    done: !!item.done,
    addedBy: String(item.addedBy || ""),
    createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
  }
}

function mapCoupleSpace(space, currentUid) {
  const users = Array.isArray(space?.users) ? [...space.users] : []
  const watchlist = Array.isArray(space?.watchlist) ? space.watchlist.map(normalizeWatchlistItem) : []
  watchlist.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return {
    pairKey: String(space?.pairKey || ""),
    users,
    partnerUid: users.find((uid) => uid !== currentUid) || "",
    watchlist,
    updatedAt: space?.updatedAt ? new Date(space.updatedAt) : new Date(),
  }
}

async function getCoupleSpaceByUsers(uidA, uidB, createIfMissing = false) {
  const users = sortedPairUsers(uidA, uidB)
  if (!users) return null
  const pairKey = users.join("__")

  if (getMongoConnected()) {
    let space = await CoupleSpaceModel.findOne({ pairKey }).lean()
    if (!space && createIfMissing) {
      await CoupleSpaceModel.create({ pairKey, users, watchlist: [], updatedAt: new Date() })
      space = await CoupleSpaceModel.findOne({ pairKey }).lean()
    }
    return space
  }

  const existing = memoryStore.coupleSpaces.get(pairKey)
  if (existing) return getProfileStoreCopy(existing)
  if (!createIfMissing) return null

  const fresh = {
    pairKey,
    users,
    watchlist: [],
    updatedAt: new Date(),
    createdAt: new Date(),
  }
  memoryStore.coupleSpaces.set(pairKey, getProfileStoreCopy(fresh))
  return getProfileStoreCopy(fresh)
}

async function saveCoupleSpace(space) {
  const normalized = {
    pairKey: String(space.pairKey || ""),
    users: uniqueStrings(space.users).sort(),
    watchlist: (Array.isArray(space.watchlist) ? space.watchlist : [])
      .slice(0, MAX_WATCHLIST_ITEMS)
      .map((item) => normalizeWatchlistItem(item)),
    updatedAt: new Date(),
  }

  if (!normalized.pairKey) {
    normalized.pairKey = pairKeyFromUsers(normalized.users[0], normalized.users[1]) || ""
  }

  if (getMongoConnected()) {
    await CoupleSpaceModel.updateOne(
      { pairKey: normalized.pairKey },
      { $set: normalized, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    )
    return CoupleSpaceModel.findOne({ pairKey: normalized.pairKey }).lean()
  }

  const existing = memoryStore.coupleSpaces.get(normalized.pairKey)
  const next = {
    ...(existing || {}),
    ...normalized,
    createdAt: existing?.createdAt || new Date(),
  }
  memoryStore.coupleSpaces.set(normalized.pairKey, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

async function getRelationshipRow(uidA, uidB) {
  const users = sortedPairUsers(uidA, uidB)
  if (!users) return null
  const key = users.join("__")
  if (getMongoConnected()) {
    return RelationshipModel.findOne({ pairKey: key }).lean()
  }
  const cached = memoryStore.relationships.get(key)
  return cached ? getProfileStoreCopy(cached) : null
}

async function setRelationshipState(uidA, uidB, status, actorUid) {
  const users = sortedPairUsers(uidA, uidB)
  if (!users) return null
  const now = new Date()
  const existing = await getRelationshipRow(users[0], users[1])
  const effectiveStatus = ["pending", "accepted", "rejected", "blocked"].includes(status) ? status : "pending"
  const actor = String(actorUid || "")
  const fallbackRequester = users.includes(actor) ? actor : String(existing?.requesterUid || existing?.requestedBy || "")
  const requesterUid = effectiveStatus === "pending"
    ? fallbackRequester
    : String(existing?.requesterUid || existing?.requestedBy || fallbackRequester)
  const recipientUid = requesterUid
    ? (users.find((uid) => uid !== requesterUid) || "")
    : String(existing?.recipientUid || "")
  const payload = {
    pairKey: users.join("__"),
    users,
    requesterUid,
    recipientUid,
    status: effectiveStatus,
    relationshipType: String(existing?.relationshipType || "friends"),
    requestedBy: requesterUid,
    lastActionBy: actor,
    lastActionAt: now,
    updatedAt: now,
  }

  if (getMongoConnected()) {
    await RelationshipModel.updateOne(
      { pairKey: payload.pairKey },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    )
    return RelationshipModel.findOne({ pairKey: payload.pairKey }).lean()
  }

  const cached = memoryStore.relationships.get(payload.pairKey)
  const next = {
    ...(cached || {}),
    ...payload,
    createdAt: cached?.createdAt || now,
  }
  memoryStore.relationships.set(payload.pairKey, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

async function setRelationshipType(uidA, uidB, relationshipType, actorUid = "") {
  const users = sortedPairUsers(uidA, uidB)
  if (!users) return null
  const pairKey = users.join("__")
  const nextType = String(relationshipType || "friends").trim().toLowerCase() || "friends"
  const now = new Date()

  if (getMongoConnected()) {
    await RelationshipModel.updateOne(
      { pairKey },
      {
        $set: {
          relationshipType: nextType,
          lastActionBy: String(actorUid || ""),
          lastActionAt: now,
          updatedAt: now,
        },
      }
    )
    return RelationshipModel.findOne({ pairKey }).lean()
  }

  const existing = memoryStore.relationships.get(pairKey)
  if (!existing) return null
  const next = {
    ...existing,
    relationshipType: nextType,
    lastActionBy: String(actorUid || ""),
    lastActionAt: now,
    updatedAt: now,
  }
  memoryStore.relationships.set(pairKey, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

async function getRelationshipByPairKey(pairKey) {
  const key = String(pairKey || "").trim()
  if (!key) return null
  if (getMongoConnected()) {
    return RelationshipModel.findOne({ pairKey: key }).lean()
  }
  const cached = memoryStore.relationships.get(key)
  return cached ? getProfileStoreCopy(cached) : null
}

module.exports = {
  normalizeRelationshipType,
  sortedPairUsers,
  pairKeyFromUsers,
  normalizeWatchlistItem,
  mapCoupleSpace,
  getCoupleSpaceByUsers,
  saveCoupleSpace,
  getRelationshipRow,
  setRelationshipState,
  setRelationshipType,
  getRelationshipByPairKey,
}
