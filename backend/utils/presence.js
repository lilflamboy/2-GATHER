"use strict";

const { getProfileStoreCopy } = require("./helpers.js");

const onlineSocketsByUid = new Map();

function markOnline(uid, socketId) {
  const set = onlineSocketsByUid.get(uid) || new Set();
  set.add(socketId);
  onlineSocketsByUid.set(uid, set);
}

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

function isOnline(uid) {
  return onlineSocketsByUid.has(uid);
}

function socketIdsForUser(uid) {
  const set = onlineSocketsByUid.get(uid);
  return set ? [...set] : [];
}

async function touchLastSeen(uid, { mongoConnected, UserProfileModel, memoryStore }) {
  if (!uid) return;
  if (mongoConnected) {
    await UserProfileModel.updateOne({ uid }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    return;
  }
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
  socketIdsForUser,
  touchLastSeen,
};
