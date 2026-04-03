/**
 * Manages pair-based relationship records and couple-space state.
 * Relationships capture the durable status between two sorted UIDs, while the
 * couple space stores pair-scoped shared data such as the watchlist.
 */
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
const {
  sanitize, sanitizeContentUrl,
} =
  require('../utils/sanitize.js')
const {
  ALLOWED_RELATIONSHIP_TYPES,
  MAX_WATCHLIST_ITEMS,
  MAX_WATCHLIST_TITLE_LENGTH,
  MAX_WATCHLIST_URL_LENGTH,
  MAX_WATCHLIST_NOTES_LENGTH,
} = require('../config/constants.js')

/**
 * Normalizes a relationship type against the allowed enum.
 * The fallback is also validated so callers cannot accidentally store an
 * unsupported relationship type.
 * @param {string} value - The raw relationship type.
 * @param {string} [fallback='friends'] - The fallback type when the value is invalid.
 * @returns {string} The normalized relationship type.
 */
function normalizeRelationshipType(value, fallback = 'friends') {
  const raw = String(value || '').trim().toLowerCase()
  if (ALLOWED_RELATIONSHIP_TYPES.includes(raw)) return raw
  return ALLOWED_RELATIONSHIP_TYPES.includes(fallback) ? fallback : 'friends'
}

/**
 * Returns a sorted two-user array suitable for pair-based keys.
 * Sorting is critical so every pair resolves to a consistent key regardless
 * of which user initiated the request.
 * @param {string} uidA - The first user UID.
 * @param {string} uidB - The second user UID.
 * @returns {string[]|null} The sorted UID pair or null when invalid.
 */
function sortedPairUsers(uidA, uidB) {
  if (!uidA || !uidB || uidA === uidB) return null
  return [uidA, uidB].sort()
}

/**
 * Builds the durable `pairKey` used by relationship and couple-space records.
 * The key is the two sorted UIDs joined with `__`, which guarantees a stable
 * lookup value regardless of request direction.
 * @param {string} uidA - The first user UID.
 * @param {string} uidB - The second user UID.
 * @returns {string|null} The normalized pair key.
 */
function pairKeyFromUsers(uidA, uidB) {
  const users = sortedPairUsers(uidA, uidB)
  return users ? users.join("__") : null
}

/**
 * Normalizes a watchlist item stored inside a couple space.
 * Titles, URLs, and notes are sanitized and length-limited, while flags and
 * timestamps are coerced into a predictable shape for both storage paths.
 * @param {object} [item={}] - The raw watchlist item.
 * @returns {object} The normalized watchlist item.
 */
function normalizeWatchlistItem(item = {}) {
  return {
    id: String(item.id || ""),
    title: sanitize(String(item.title || "")).slice(0, MAX_WATCHLIST_TITLE_LENGTH),
    url: sanitizeContentUrl(item.url || "").slice(0, MAX_WATCHLIST_URL_LENGTH),
    notes: sanitize(String(item.notes || "")).slice(0, MAX_WATCHLIST_NOTES_LENGTH),
    done: !!item.done,
    addedBy: String(item.addedBy || ""),
    createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
  }
}

/**
 * Maps a stored couple-space row into the API response shape.
 * The mapper derives the partner UID from the current user and sorts the
 * watchlist newest-first for the shared dashboard experience.
 * @param {object} space - The stored couple-space record.
 * @param {string} currentUid - The viewing user's UID.
 * @returns {object} The mapped couple-space payload.
 */
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

/**
 * Loads or optionally creates the couple-space record for a pair of users.
 * Couple spaces are keyed by the same sorted pair key as relationships and can
 * be lazily created the first time the pair needs shared watchlist state.
 * @param {string} uidA - The first participant UID.
 * @param {string} uidB - The second participant UID.
 * @param {boolean} [createIfMissing=false] - Whether to create an empty space.
 * @returns {Promise<object|null>} The stored couple-space row.
 */
async function getCoupleSpaceByUsers(uidA, uidB, createIfMissing = false) {
  const users = sortedPairUsers(uidA, uidB)
  if (!users) return null
  const pairKey = users.join("__")

  // MongoDB stores the durable couple-space document keyed by pairKey.
  if (getMongoConnected()) {
    let space = await CoupleSpaceModel.findOne({ pairKey }).lean()
    if (!space && createIfMissing) {
      await CoupleSpaceModel.create({ pairKey, users, watchlist: [], updatedAt: new Date() })
      space = await CoupleSpaceModel.findOne({ pairKey }).lean()
    }
    return space
  }

  // Memory mode mirrors the same lazy-creation behavior in the fallback map.
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

/**
 * Saves a couple-space record using upsert semantics.
 * The watchlist is normalized, capped to the configured maximum, and the
 * original `createdAt` is preserved across later updates.
 * @param {object} space - The couple-space payload to save.
 * @returns {Promise<object>} The persisted or cached couple-space row.
 */
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

  // Persist the normalized couple-space row when MongoDB is available.
  if (getMongoConnected()) {
    await CoupleSpaceModel.updateOne(
      { pairKey: normalized.pairKey },
      { $set: normalized, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    )
    return CoupleSpaceModel.findOne({ pairKey: normalized.pairKey }).lean()
  }

  // Mirror the upsert into the in-memory couple-space map.
  const existing = memoryStore.coupleSpaces.get(normalized.pairKey)
  const next = {
    ...(existing || {}),
    ...normalized,
    createdAt: existing?.createdAt || new Date(),
  }
  memoryStore.coupleSpaces.set(normalized.pairKey, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

/**
 * Fetches the relationship row for a pair of users.
 * The lookup always uses the sorted pair key so both directions resolve to the
 * same durable relationship record.
 * @param {string} uidA - The first user UID.
 * @param {string} uidB - The second user UID.
 * @returns {Promise<object|null>} The relationship row or null when missing.
 */
async function getRelationshipRow(uidA, uidB) {
  const users = sortedPairUsers(uidA, uidB)
  if (!users) return null
  const key = users.join("__")
  // MongoDB uses the pairKey as the single source of truth.
  if (getMongoConnected()) {
    return RelationshipModel.findOne({ pairKey: key }).lean()
  }
  const cached = memoryStore.relationships.get(key)
  return cached ? getProfileStoreCopy(cached) : null
}

/**
 * Updates the current state of a relationship row.
 * This tracks the effective status, requester/recipient direction, and audit
 * fields like `lastActionBy` and `lastActionAt` for later reasoning.
 * @param {string} uidA - One user in the relationship pair.
 * @param {string} uidB - The other user in the relationship pair.
 * @param {string} status - The next relationship status.
 * @param {string} actorUid - The UID performing the transition.
 * @returns {Promise<object|null>} The updated relationship row.
 */
async function setRelationshipState(uidA, uidB, status, actorUid) {
  const users = sortedPairUsers(uidA, uidB)
  if (!users) return null
  const now = new Date()
  const existing = await getRelationshipRow(users[0], users[1])
  // Normalize the target status before deriving requester and recipient fields.
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

  // Upsert the relationship row in MongoDB when persistent storage is available.
  if (getMongoConnected()) {
    await RelationshipModel.updateOne(
      { pairKey: payload.pairKey },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true }
    )
    return RelationshipModel.findOne({ pairKey: payload.pairKey }).lean()
  }

  // Otherwise update the fallback relationship map using the same canonical payload.
  const cached = memoryStore.relationships.get(payload.pairKey)
  const next = {
    ...(cached || {}),
    ...payload,
    createdAt: cached?.createdAt || now,
  }
  memoryStore.relationships.set(payload.pairKey, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

/**
 * Updates the relationship type for an existing pair.
 * This is separate from status changes so the app can refine whether a pair is
 * a friendship, couple, family link, or other allowed relationship flavor.
 * @param {string} uidA - The first user UID.
 * @param {string} uidB - The second user UID.
 * @param {string} relationshipType - The new relationship type.
 * @param {string} [actorUid=''] - The UID performing the update.
 * @returns {Promise<object|null>} The updated relationship row.
 */
async function setRelationshipType(uidA, uidB, relationshipType, actorUid = "") {
  const users = sortedPairUsers(uidA, uidB)
  if (!users) return null
  const pairKey = users.join("__")
  const nextType = String(relationshipType || "friends").trim().toLowerCase() || "friends"
  const now = new Date()

  // Persist the type change in MongoDB when available.
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

  // Mirror the same metadata update in the in-memory fallback row.
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

/**
 * Loads a relationship row directly by pair key.
 * This helper is useful once callers already have the normalized composite key.
 * @param {string} pairKey - The normalized pair key.
 * @returns {Promise<object|null>} The matching relationship row.
 */
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
