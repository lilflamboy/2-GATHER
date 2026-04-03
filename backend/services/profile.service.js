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

function normalizeProfile(profile) {
  const totalWatchTime = Math.max(0, Math.floor(Number(profile.totalWatchTime) || 0))
  const totalSessions = Math.max(0, Math.floor(Number(profile.totalSessions) || 0))
  const streakCount = Math.max(0, Math.floor(Number(profile.streakCount) || 0))
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

function publicProfile(profile) {
  return {
    uid: profile.uid,
    username: profile.username || "",
    displayName: profile.displayName || "Anonymous",
    photoURL: profile.photoURL || "",
    bio: profile.bio || "",
  }
}

function relationshipWith(profile, targetUid) {
  if (profile.friends.includes(targetUid)) return "friend"
  if (profile.outgoingRequests.includes(targetUid)) return "requested"
  if (profile.incomingRequests.includes(targetUid)) return "incoming"
  return "none"
}

async function getProfileByUid(uid) {
  if (!uid) return null
  if (getMongoConnected()) {
    return UserProfileModel.findOne({ uid }).lean()
  }
  const cached = memoryStore.profiles.get(uid)
  return cached ? getProfileStoreCopy(cached) : null
}

async function saveProfile(profile) {
  const normalized = normalizeProfile(profile)

  if (getMongoConnected()) {
    await UserProfileModel.updateOne(
      { uid: normalized.uid },
      { $set: normalized, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    )
    return UserProfileModel.findOne({ uid: normalized.uid }).lean()
  }

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

async function ensureProfile(identity) {
  let profile = await getProfileByUid(identity.uid)
  if (!profile) {
    profile = buildBaseProfile(identity)
  }

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

async function listProfilesByUids(uids) {
  const ids = uniqueStrings(uids)
  if (ids.length === 0) return []

  if (getMongoConnected()) {
    return UserProfileModel.find({ uid: { $in: ids } }).lean()
  }

  return ids
    .map((uid) => memoryStore.profiles.get(uid))
    .filter(Boolean)
    .map((profile) => getProfileStoreCopy(profile))
}

async function isUsernameAvailable(username, uidToIgnore = "") {
  const normalized = normalizeUsername(username)
  if (!USERNAME_REGEX.test(normalized)) return false

  if (getMongoConnected()) {
    const existing = await UserProfileModel.findOne({ username: normalized }).lean()
    return !existing || existing.uid === uidToIgnore
  }

  const profile = [...memoryStore.profiles.values()].find((entry) => entry.username === normalized)
  return !profile || profile.uid === uidToIgnore
}

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

async function searchProfiles(query, selfUid, limit = 12) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 12))
  const q = String(query || "").trim()
  if (q.length < 2) return []

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
