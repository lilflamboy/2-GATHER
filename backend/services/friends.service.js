/**
 * Builds and mutates the friendship graph used by the social features.
 * MongoDB derives this graph from relationship rows, while memory mode falls
 * back to the arrays stored directly on the profile objects.
 */
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

/**
 * Creates the empty friend-graph shape returned by the service.
 * The graph tracks confirmed friends, incoming requests, outgoing requests,
 * and blocked users as four distinct adjacency lists.
 * @returns {object} An empty friend-graph object.
 */
function createEmptyFriendGraph() {
  return {
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    blocked: [],
  }
}

/**
 * Converts relationship rows into the friend graph for one user.
 * `accepted` rows become friend edges, `blocked` rows populate the blocked
 * list, and `pending` rows are split into incoming vs outgoing by requester UID.
 * @param {string} selfUid - The graph owner.
 * @param {object[]} [rows=[]] - Relationship rows involving that user.
 * @returns {object} The derived friend graph.
 */
function buildFriendGraphFromRows(selfUid, rows = []) {
  const graph = createEmptyFriendGraph()
  // Interpret every relationship row from the perspective of the requesting user.
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

/**
 * Lists every relationship row that involves the given user.
 * MongoDB uses a membership query on `users`, while memory mode performs the
 * equivalent filter against cached relationship rows.
 * @param {string} uid - The user whose relationship rows should be loaded.
 * @returns {Promise<object[]>} Matching relationship rows.
 */
async function listRelationshipRowsForUser(uid) {
  const selfUid = String(uid || "").trim()
  if (!selfUid) return []
  // The persistent path sorts newest first so the freshest states win naturally.
  if (getMongoConnected()) {
    return RelationshipModel.find({ users: selfUid }).sort({ updatedAt: -1 }).lean()
  }
  // Memory mode mirrors the same filter and sort order over the fallback map.
  return [...memoryStore.relationships.values()]
    .filter((row) => Array.isArray(row.users) && row.users.includes(selfUid))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || Date.now()).getTime() - new Date(a.updatedAt || a.createdAt || Date.now()).getTime())
    .map((row) => getProfileStoreCopy(row))
}

/**
 * Resolves the complete friendship graph for a user.
 * MongoDB prefers normalized relationship rows but falls back to legacy profile
 * arrays for backward compatibility while old data warms into the new model.
 * @param {string} uid - The user whose graph should be returned.
 * @returns {Promise<object>} The friend graph for that user.
 */
async function listFriendGraph(uid) {
  const selfUid = String(uid || "").trim()
  if (!selfUid) return createEmptyFriendGraph()

  // Derive the graph from relationship rows when the normalized MongoDB model is active.
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

  // The in-memory fallback still uses profile arrays as the source of truth.
  const profile = await getProfileByUid(selfUid)
  if (!profile) return createEmptyFriendGraph()
  return {
    friends: uniqueStrings(profile.friends),
    incomingRequests: uniqueStrings(profile.incomingRequests),
    outgoingRequests: uniqueStrings(profile.outgoingRequests),
    blocked: [],
  }
}

/**
 * Checks whether two users are already friends.
 * The lookup reuses the existing friend graph helper so both storage paths stay
 * consistent.
 * @param {string} uidA - The first user UID.
 * @param {string} uidB - The second user UID.
 * @returns {Promise<boolean>} True when the users are already friends.
 */
async function areUsersFriends(uidA, uidB) {
  const graph = await listFriendGraph(uidA)
  return graph.friends.includes(uidB)
}

/**
 * Reads the relationship state for a target user from an existing graph.
 * The possible return values are `friend`, `requested`, `incoming`, `blocked`,
 * and `none`.
 * @param {object} graph - The precomputed friend graph.
 * @param {string} targetUid - The UID to inspect within the graph.
 * @returns {string} The relationship state relative to the target user.
 */
function relationshipWithGraph(graph, targetUid) {
  if (graph.friends.includes(targetUid)) return "friend"
  if (graph.outgoingRequests.includes(targetUid)) return "requested"
  if (graph.incomingRequests.includes(targetUid)) return "incoming"
  if (graph.blocked.includes(targetUid)) return "blocked"
  return "none"
}

/**
 * Sends a friend request or returns the existing relationship state.
 * The state machine handles invalid targets, blocked pairs, existing friendships,
 * duplicate pending requests, reverse pending requests, and brand-new requests.
 * @param {string} fromUid - The requesting user's UID.
 * @param {string} toUid - The target user's UID.
 * @returns {Promise<object>} A status object describing the resulting state.
 */
async function sendFriendRequest(fromUid, toUid) {
  if (!fromUid || !toUid || fromUid === toUid) {
    const error = new Error("Invalid target user")
    error.status = 400
    throw error
  }

  // Load both users first so the service can fail consistently across both storage paths.
  const from = await getProfileByUid(fromUid)
  const to = await getProfileByUid(toUid)
  if (!from || !to) {
    const error = new Error("User not found")
    error.status = 404
    throw error
  }
  // MongoDB uses the normalized relationship row as the source of truth.
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

  // Memory mode keeps backward-compatible request arrays on the profiles themselves.
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

/**
 * Accepts or rejects an incoming friend request.
 * Accepting moves both users into each other's `friends` arrays, while rejecting
 * simply clears the pending request and updates the normalized relationship row.
 * @param {string} targetUid - The user responding to the request.
 * @param {string} requesterUid - The original requester UID.
 * @param {string} action - Either `accept` or `reject`.
 * @returns {Promise<object>} The affected requester and target profiles.
 */
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

  // MongoDB validates that the relationship row is still pending from the requester.
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

  // The memory fallback mutates the legacy profile arrays before saving them back.
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
