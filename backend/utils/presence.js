/**
 * Presence-tracking helpers for realtime users. Presence is tracked as a Map
 * from uid to a Set of socket ids so one user can be online from multiple tabs
 * or devices at once. Privacy is layered on top through isOnlineVisible(),
 * which respects the user's showOnlineStatus setting when serializing presence.
 */

"use strict";

const { getProfileStoreCopy } = require("./helpers.js");

// Track all live sockets per user so one tab closing does not mark a user fully offline.
const onlineSocketsByUid = new Map();

/**
 * Marks a user as online for a specific socket connection.
 * @param {string} uid - Firebase uid that owns the socket.
 * @param {string} socketId - Socket.IO connection id to add.
 * @returns {void} This function mutates the in-memory presence map.
 */
function markOnline(uid, socketId) {
  const set = onlineSocketsByUid.get(uid) || new Set();
  set.add(socketId);
  onlineSocketsByUid.set(uid, set);
}

/**
 * Removes one socket from a user's presence set.
 * @param {string} uid - Firebase uid that owns the socket.
 * @param {string} socketId - Socket.IO connection id to remove.
 * @returns {boolean} True if the user still has another live socket, else false.
 */
function markOffline(uid, socketId) {
  const set = onlineSocketsByUid.get(uid);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    onlineSocketsByUid.delete(uid);
    return false;
  }
  return true;
}

/**
 * Checks whether a user currently has any live socket connections.
 * @param {string} uid - Firebase uid to check.
 * @returns {boolean} True when at least one socket is still connected.
 */
function isOnline(uid) {
  return onlineSocketsByUid.has(uid);
}

/**
 * Checks whether a user's online state should be visible to a specific viewer.
 * @param {object} profile - Profile whose presence is being serialized.
 * @param {string} viewerUid - Firebase uid of the requesting viewer.
 * @returns {boolean} True when presence should be exposed to that viewer.
 */
function isOnlineVisible(profile, viewerUid = "") {
  if (!profile?.uid) return false;
  // Users can always see their own true presence, even if they hide it from others.
  if (String(profile.uid) === String(viewerUid || "")) {
    return isOnline(profile.uid);
  }
  if (profile.settings?.showOnlineStatus === false) {
    return false;
  }
  return isOnline(profile.uid);
}

/**
 * Returns every live socket id for a user.
 * @param {string} uid - Firebase uid whose sockets should be targeted.
 * @returns {string[]} All currently connected socket ids for that user.
 */
function socketIdsForUser(uid) {
  const set = onlineSocketsByUid.get(uid);
  return set ? [...set] : [];
}

/**
 * Persists a user's last-seen timestamp through either MongoDB or the fallback memory store.
 * @param {string} uid - Firebase uid whose last-seen time should be updated.
 * @param {object} deps - Storage dependencies for the selected persistence path.
 * @param {boolean} deps.mongoConnected - Whether MongoDB is currently active.
 * @param {object} deps.UserProfileModel - Mongoose model used for profile writes.
 * @param {object} deps.memoryStore - In-memory fallback store used without MongoDB.
 * @returns {Promise<void>} Resolves after the last-seen write attempt completes.
 */
async function touchLastSeen(uid, { mongoConnected, UserProfileModel, memoryStore }) {
  if (!uid) return;
  // Use the durable profile record when MongoDB is available.
  if (mongoConnected) {
    await UserProfileModel.updateOne({ uid }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    return;
  }
  // Otherwise update the fallback copy so presence-based UIs still see recent activity.
  const profile = memoryStore.profiles.get(uid);
  if (!profile) return;
  profile.lastSeenAt = new Date();
  profile.updatedAt = new Date();
  memoryStore.profiles.set(uid, getProfileStoreCopy(profile));
}

module.exports = {
  onlineSocketsByUid,
  markOnline,
  markOffline,
  isOnline,
  isOnlineVisible,
  socketIdsForUser,
  touchLastSeen,
};
