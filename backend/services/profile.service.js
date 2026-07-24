/**
 * Manages user profiles for the 2-GATHER backend.
 * Every operation follows the same dual-path pattern: use MongoDB when
 * `getMongoConnected()` is true, otherwise read and write the mirrored
 * in-memory store so the app can continue operating in degraded mode.
 */
'use strict'

const { UserProfileModel, getMongoConnected } =
  require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { normalizeUsername } =
  require('../utils/normalize.js')
const {
  sanitize, sanitizeBio,
  sanitizePhotoURL, sanitizeSharedMemoryGenre,
} = require('../utils/sanitize.js')
const {
  uniqueStrings, getProfileStoreCopy,
} = require('../utils/helpers.js')
const { USERNAME_REGEX, DEFAULT_SETTINGS } =
  require('../config/constants.js')

/**
 * Builds the default profile shape for a newly seen Firebase identity.
 * Defaults are chosen so the rest of the app can safely assume every profile
 * has string, array, settings, analytics, and timestamp fields present.
 * @param {object} identity - The Firebase identity payload for the user.
 * @returns {object} A complete base profile ready to be normalized and saved.
 */
function buildBaseProfile(identity) {
  // First-time sign-in creates a complete profile shape so the rest of the app
  // can treat missing fields as a data issue instead of a state-shape issue.
  return {
    uid: identity.uid,
    username: "",
    displayName: identity.name || "Anonymous",
    photoURL: identity.photoURL || "",
    email: identity.email || "",
    phoneNumber: identity.phoneNumber || "",
    bio: "",
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    settings: { ...DEFAULT_SETTINGS },
    totalWatchTime: 0,
    totalSessions: 0,
    streakCount: 0,
    lastSessionAt: null,
    preferences: {
      favoriteGenres: [],
      activeTimeSlots: [],
    },
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

/**
 * Normalizes a profile into the canonical persisted shape.
 * Strings are sanitized, arrays are deduplicated, counters are clamped,
 * and date-like values are converted into Date instances.
 * @param {object} profile - The raw or partially normalized profile object.
 * @returns {object} The normalized profile payload.
 */
function normalizeProfile(profile) {
  // Clamp analytics counters so bad inputs cannot create negative or fractional totals.
  const totalWatchTime = Math.max(0, Math.floor(Number(profile.totalWatchTime) || 0))
  const totalSessions = Math.max(0, Math.floor(Number(profile.totalSessions) || 0))
  const streakCount = Math.max(0, Math.floor(Number(profile.streakCount) || 0))
  // Preferences are derived arrays, so sanitize and dedupe them before saving.
  const favoriteGenres = uniqueStrings(
    (Array.isArray(profile.preferences?.favoriteGenres) ? profile.preferences.favoriteGenres : [])
      .map((item) => sanitizeSharedMemoryGenre(item))
      .filter(Boolean)
  ).slice(0, 8)
  const activeTimeSlots = uniqueStrings(
    (Array.isArray(profile.preferences?.activeTimeSlots) ? profile.preferences.activeTimeSlots : [])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
  ).slice(0, 8)
  return {
    ...profile,
    username: normalizeUsername(profile.username || ""),
    displayName: sanitize(String(profile.displayName || "")).slice(0, 60) || "Anonymous",
    photoURL: sanitizePhotoURL(profile.photoURL),
    email: String(profile.email || "").slice(0, 160),
    phoneNumber: String(profile.phoneNumber || "").slice(0, 40),
    bio: sanitizeBio(profile.bio || ""),
    friends: uniqueStrings(profile.friends),
    incomingRequests: uniqueStrings(profile.incomingRequests),
    outgoingRequests: uniqueStrings(profile.outgoingRequests),
    settings: {
      inviteNotifications: profile.settings?.inviteNotifications ?? DEFAULT_SETTINGS.inviteNotifications,
      memoryNudges: profile.settings?.memoryNudges ?? DEFAULT_SETTINGS.memoryNudges,
      showOnlineStatus: profile.settings?.showOnlineStatus ?? DEFAULT_SETTINGS.showOnlineStatus,
    },
    totalWatchTime,
    totalSessions,
    streakCount,
    lastSessionAt: profile.lastSessionAt ? new Date(profile.lastSessionAt) : null,
    preferences: {
      favoriteGenres,
      activeTimeSlots,
    },
    lastSeenAt: profile.lastSeenAt ? new Date(profile.lastSeenAt) : new Date(),
    updatedAt: new Date(),
  }
}

/**
 * Projects a profile into the safe public subset exposed to other users.
 * Only lightweight identity fields are returned so private contact details,
 * analytics, requests, and settings never leak through public responses.
 * @param {object} profile - The full stored profile.
 * @returns {object} The publicly exposable profile fields.
 */
function publicProfile(profile) {
  return {
    uid: profile.uid,
    username: profile.username || "",
    displayName: profile.displayName || "Anonymous",
    photoURL: profile.photoURL || "",
    bio: profile.bio || "",
  }
}

/**
 * Describes the current relationship status between a profile and a target UID.
 * The possible return values are `friend`, `requested`, `incoming`, and `none`,
 * matching the friend graph states shown in the client UI.
 * @param {object} profile - The profile whose graph fields are being checked.
 * @param {string} targetUid - The UID to compare against the profile.
 * @returns {string} The relationship state relative to the target user.
 */
function relationshipWith(profile, targetUid) {
  if (profile.friends.includes(targetUid)) return "friend"
  if (profile.outgoingRequests.includes(targetUid)) return "requested"
  if (profile.incomingRequests.includes(targetUid)) return "incoming"
  return "none"
}

/**
 * Loads a profile by UID from MongoDB or the in-memory fallback store.
 * The storage path is selected at runtime based on `getMongoConnected()`.
 * @param {string} uid - The UID of the profile to load.
 * @returns {Promise<object|null>} The stored profile or null when missing.
 */
async function getProfileByUid(uid) {
  if (!uid) return null
  // Prefer the durable profile collection whenever MongoDB is connected.
  if (getMongoConnected()) {
    return UserProfileModel.findOne({ uid }).lean()
  }
  // Return a defensive copy so callers cannot mutate the live memory store object.
  const cached = memoryStore.profiles.get(uid)
  return cached ? getProfileStoreCopy(cached) : null
}

/**
 * Upserts a profile into the active persistence backend.
 * Updates preserve the original `createdAt` value while always refreshing the
 * normalized fields and the `updatedAt` timestamp.
 * @param {object} profile - The profile data to save.
 * @returns {Promise<object>} The stored normalized profile.
 */
async function saveProfile(profile) {
  const normalized = normalizeProfile(profile)

  // Use MongoDB upsert semantics when the primary datastore is available.
  if (getMongoConnected()) {
    await UserProfileModel.updateOne(
      { uid: normalized.uid },
      { $set: normalized, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    )
    return UserProfileModel.findOne({ uid: normalized.uid }).lean()
  }

  // Mirror the same upsert behavior in memory while preserving the original creation time.
  const existing = memoryStore.profiles.get(normalized.uid)
  const next = {
    ...(existing || {}),
    ...normalized,
    createdAt: existing?.createdAt || normalized.createdAt || new Date(),
    updatedAt: new Date(),
  }
  memoryStore.profiles.set(normalized.uid, getProfileStoreCopy(next))
  return getProfileStoreCopy(next)
}

/**
 * Ensures a profile exists and synchronizes trusted identity fields from Firebase.
 * New users get a base profile, while returning users have display and contact
 * details refreshed when newer identity data is available.
 * @param {object} identity - The Firebase-authenticated identity payload.
 * @returns {Promise<object>} The saved profile record.
 */
async function ensureProfile(identity) {
  let profile = await getProfileByUid(identity.uid)
  if (!profile) {
    profile = buildBaseProfile(identity)
  }

  // Refresh profile fields from Firebase identity data on every authenticated request.
  const incomingDisplayName = sanitize(String(identity.name || "")).slice(0, 60)
  if (incomingDisplayName && profile.displayName !== incomingDisplayName) {
    profile.displayName = incomingDisplayName
  }
  if (identity.photoURL && !profile.photoURL) {
    profile.photoURL = identity.photoURL
  }
  if (identity.email && !profile.email) {
    profile.email = identity.email
  }
  if (identity.phoneNumber && !profile.phoneNumber) {
    profile.phoneNumber = identity.phoneNumber
  }

  return saveProfile(profile)
}

/**
 * Loads a set of profiles by UID.
 * MongoDB uses a single `$in` query, while memory mode maps directly across the
 * profile map and returns deep copies for any existing entries.
 * @param {string[]} uids - The candidate profile UIDs.
 * @returns {Promise<object[]>} The matching profiles.
 */
async function listProfilesByUids(uids) {
  const ids = uniqueStrings(uids)
  if (ids.length === 0) return []

  // Fetch the entire UID set in one MongoDB query when persistent storage is available.
  if (getMongoConnected()) {
    return UserProfileModel.find({ uid: { $in: ids } }).lean()
  }

  // Rebuild the same list from the in-memory map while skipping missing profiles.
  return ids
    .map((uid) => memoryStore.profiles.get(uid))
    .filter(Boolean)
    .map((profile) => getProfileStoreCopy(profile))
}

/**
 * Checks whether a normalized username is available to claim.
 * The optional `uidToIgnore` parameter lets the current owner re-check a sparse
 * username value without colliding with their own document.
 * @param {string} username - The desired username.
 * @param {string} [uidToIgnore=''] - A UID that should be ignored during lookup.
 * @returns {Promise<boolean>} True when the username can be used.
 */
async function isUsernameAvailable(username, uidToIgnore = "") {
  const normalized = normalizeUsername(username)
  if (!USERNAME_REGEX.test(normalized)) return false

  // Sparse username lookups only care about documents that already claimed a value.
  if (getMongoConnected()) {
    const existing = await UserProfileModel.findOne({ username: normalized }).lean()
    return !existing || existing.uid === uidToIgnore
  }

  // The in-memory fallback performs the same uniqueness check over cached profiles.
  const profile = [...memoryStore.profiles.values()].find((entry) => entry.username === normalized)
  return !profile || profile.uid === uidToIgnore
}

/**
 * Claims a username for a profile if it is valid and still available.
 * The function enforces the one-time claim rule and re-checks availability just
 * before saving to reduce the chance of claim races between concurrent requests.
 * @param {string} uid - The profile owner claiming the username.
 * @param {string} username - The desired username value.
 * @returns {Promise<object>} The updated profile after the claim succeeds.
 */
async function claimUsername(uid, username) {
  const normalized = normalizeUsername(username)
  if (!USERNAME_REGEX.test(normalized)) {
    const error = new Error("Username must be 3-20 chars: letters, numbers, underscore")
    error.status = 400
    throw error
  }

  const profile = await getProfileByUid(uid)
  if (!profile) {
    const error = new Error("Profile not found")
    error.status = 404
    throw error
  }

  if (profile.username && profile.username !== normalized) {
    const error = new Error("Username is already set for this account")
    error.status = 409
    throw error
  }
  if (profile.username === normalized) {
    return profile
  }

  const available = await isUsernameAvailable(normalized, uid)
  if (!available) {
    const error = new Error("Username already taken")
    error.status = 409
    throw error
  }

  profile.username = normalized
  return saveProfile(profile)
}

/**
 * Searches profiles by username, display name, or email.
 * MongoDB uses an escaped case-insensitive regex, which is simple but has a
 * known performance ceiling once profile volume grows significantly.
 * @param {string} query - The user-entered search query.
 * @param {string} selfUid - The searching user's UID to exclude from results.
 * @param {number} [limit=12] - The maximum number of profiles to return.
 * @returns {Promise<object[]>} Matching profile rows.
 */
async function searchProfiles(query, selfUid, limit = 12) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 12))
  const q = String(query || "").trim()
  if (q.length < 2) return []

  // MongoDB uses an escaped regex so user input cannot alter the regex program itself.
  if (getMongoConnected()) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    return UserProfileModel.find(
      {
        uid: { $ne: selfUid },
        $or: [
          { username: rx },
          { displayName: rx },
          { email: rx },
        ],
      }
    )
      .sort({ updatedAt: -1 })
      .limit(safeLimit)
      .lean()
  }

  // Memory mode uses a lowercase haystack comparison to mirror the permissive search behavior.
  return [...memoryStore.profiles.values()]
    .filter((profile) => profile.uid !== selfUid)
    .filter((profile) => {
      const haystack = `${profile.username || ""} ${profile.displayName || ""} ${profile.email || ""}`.toLowerCase()
      return haystack.includes(q.toLowerCase())
    })
    .slice(0, safeLimit)
    .map((profile) => getProfileStoreCopy(profile))
}

module.exports = {
  buildBaseProfile,
  normalizeProfile,
  publicProfile,
  relationshipWith,
  getProfileStoreCopy,
  getProfileByUid,
  saveProfile,
  ensureProfile,
  listProfilesByUids,
  isUsernameAvailable,
  claimUsername,
  searchProfiles,
}
