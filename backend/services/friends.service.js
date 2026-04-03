'use strict'

const { RelationshipModel, getMongoConnected } =
  require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')
const { getProfileByUid, saveProfile } =
  require('./profile.service.js')
const { getRelationshipRow, setRelationshipState } =
  require('./relationship.service.js')
const { uniqueStrings, getProfileStoreCopy } =
  require('../utils/helpers.js')

function createEmptyFriendGraph() {
  return {
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    blocked: [],
  }
}

function buildFriendGraphFromRows(selfUid, rows = []) {
  const graph = createEmptyFriendGraph()
  rows.forEach((row) => {
    const users = uniqueStrings(row?.users || [])
    const partnerUid = users.find((uid) => uid !== selfUid)
    if (!partnerUid) return

    if (row.status === "accepted") {
      graph.friends.push(partnerUid)
      return
    }
    if (row.status === "blocked") {
      graph.blocked.push(partnerUid)
      return
    }
    if (row.status !== "pending") return

    const requesterUid = String(row.requesterUid || row.requestedBy || "")
    if (requesterUid === selfUid) {
      graph.outgoingRequests.push(partnerUid)
    } else {
      graph.incomingRequests.push(partnerUid)
    }
  })

  graph.friends = uniqueStrings(graph.friends)
  graph.incomingRequests = uniqueStrings(graph.incomingRequests)
  graph.outgoingRequests = uniqueStrings(graph.outgoingRequests)
  graph.blocked = uniqueStrings(graph.blocked)
  return graph
}

async function listRelationshipRowsForUser(uid) {
  const selfUid = String(uid || "").trim()
  if (!selfUid) return []
  if (getMongoConnected()) {
    return RelationshipModel.find({ users: selfUid }).sort({ updatedAt: -1 }).lean()
  }
  return [...memoryStore.relationships.values()]
    .filter((row) => Array.isArray(row.users) && row.users.includes(selfUid))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || Date.now()).getTime() - new Date(a.updatedAt || a.createdAt || Date.now()).getTime())
    .map((row) => getProfileStoreCopy(row))
}

async function listFriendGraph(uid) {
  const selfUid = String(uid || "").trim()
  if (!selfUid) return createEmptyFriendGraph()

  if (getMongoConnected()) {
    const rows = await listRelationshipRowsForUser(selfUid)
    const graph = buildFriendGraphFromRows(selfUid, rows)
    if (graph.friends.length || graph.incomingRequests.length || graph.outgoingRequests.length || graph.blocked.length) {
      return graph
    }
    // Backward-compat fallback for legacy profiles while friendships are warming up.
    const profile = await getProfileByUid(selfUid)
    if (profile) {
      return {
        friends: uniqueStrings(profile.friends),
        incomingRequests: uniqueStrings(profile.incomingRequests),
        outgoingRequests: uniqueStrings(profile.outgoingRequests),
        blocked: [],
      }
    }
    return graph
  }

  const profile = await getProfileByUid(selfUid)
  if (!profile) return createEmptyFriendGraph()
  return {
    friends: uniqueStrings(profile.friends),
    incomingRequests: uniqueStrings(profile.incomingRequests),
    outgoingRequests: uniqueStrings(profile.outgoingRequests),
    blocked: [],
  }
}

async function areUsersFriends(uidA, uidB) {
  const graph = await listFriendGraph(uidA)
  return graph.friends.includes(uidB)
}

function relationshipWithGraph(graph, targetUid) {
  if (graph.friends.includes(targetUid)) return "friend"
  if (graph.outgoingRequests.includes(targetUid)) return "requested"
  if (graph.incomingRequests.includes(targetUid)) return "incoming"
  if (graph.blocked.includes(targetUid)) return "blocked"
  return "none"
}

async function sendFriendRequest(fromUid, toUid) {
  if (!fromUid || !toUid || fromUid === toUid) {
    const error = new Error("Invalid target user")
    error.status = 400
    throw error
  }

  const from = await getProfileByUid(fromUid)
  const to = await getProfileByUid(toUid)
  if (!from || !to) {
    const error = new Error("User not found")
    error.status = 404
    throw error
  }
  if (getMongoConnected()) {
    const existing = await getRelationshipRow(fromUid, toUid)
    if (existing?.status === "blocked") {
      const error = new Error("Friend request is blocked for this user")
      error.status = 403
      throw error
    }
    if (existing?.status === "accepted") {
      return { status: "already_friends", from, to }
    }
    if (existing?.status === "pending") {
      const requesterUid = String(existing.requesterUid || existing.requestedBy || "")
      if (requesterUid === fromUid) {
        return { status: "already_requested", from, to }
      }
      return { status: "needs_accept", from, to }
    }
    await setRelationshipState(fromUid, toUid, "pending", fromUid)
    return { status: "requested", from, to }
  }

  if (from.friends.includes(toUid)) {
    await setRelationshipState(fromUid, toUid, "accepted", fromUid)
    return { status: "already_friends", from, to }
  }
  if (from.outgoingRequests.includes(toUid)) {
    await setRelationshipState(fromUid, toUid, "pending", fromUid)
    return { status: "already_requested", from, to }
  }
  if (from.incomingRequests.includes(toUid)) {
    await setRelationshipState(fromUid, toUid, "pending", toUid)
    return { status: "needs_accept", from, to }
  }

  from.outgoingRequests.push(toUid)
  to.incomingRequests.push(fromUid)

  const nextFrom = await saveProfile(from)
  const nextTo = await saveProfile(to)
  await setRelationshipState(fromUid, toUid, "pending", fromUid)
  return { status: "requested", from: nextFrom, to: nextTo }
}

async function respondFriendRequest(targetUid, requesterUid, action) {
  if (!["accept", "reject"].includes(action)) {
    const error = new Error("Invalid action")
    error.status = 400
    throw error
  }

  const target = await getProfileByUid(targetUid)
  const requester = await getProfileByUid(requesterUid)
  if (!target || !requester) {
    const error = new Error("User not found")
    error.status = 404
    throw error
  }

  if (getMongoConnected()) {
    const existing = await getRelationshipRow(targetUid, requesterUid)
    const requesterId = String(existing?.requesterUid || existing?.requestedBy || "")
    if (!existing || existing.status !== "pending" || requesterId !== requesterUid) {
      const error = new Error("Friend request not found")
      error.status = 400
      throw error
    }
    await setRelationshipState(targetUid, requesterUid, action === "accept" ? "accepted" : "rejected", targetUid)
    return { target, requester }
  }

  if (!target.incomingRequests.includes(requesterUid)) {
    const error = new Error("Friend request not found")
    error.status = 400
    throw error
  }

  target.incomingRequests = target.incomingRequests.filter((uid) => uid !== requesterUid)
  requester.outgoingRequests = requester.outgoingRequests.filter((uid) => uid !== targetUid)

  if (action === "accept") {
    if (!target.friends.includes(requesterUid)) target.friends.push(requesterUid)
    if (!requester.friends.includes(targetUid)) requester.friends.push(targetUid)
  }

  const nextTarget = await saveProfile(target)
  const nextRequester = await saveProfile(requester)
  await setRelationshipState(targetUid, requesterUid, action === "accept" ? "accepted" : "rejected", targetUid)
  return { target: nextTarget, requester: nextRequester }
}

module.exports = {
  createEmptyFriendGraph,
  buildFriendGraphFromRows,
  listRelationshipRowsForUser,
  listFriendGraph,
  areUsersFriends,
  relationshipWithGraph,
  sendFriendRequest,
  respondFriendRequest,
}
