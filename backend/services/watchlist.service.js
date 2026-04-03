/**
 * Provides guardrails around shared watchlist access.
 * Watchlist items live on the couple-space relationship record, and this
 * service validates that both participants exist and are allowed to share one.
 */
'use strict'

const { getProfileByUid } =
  require('./profile.service.js')
const { areUsersFriends } =
  require('./friends.service.js')

/**
 * Resolves and validates the two users allowed to access a shared watchlist.
 * Couple-space watchlists are only available to existing friends, so this
 * helper loads both profiles and enforces that relationship precondition.
 * @param {string} selfUid - The requesting user's UID.
 * @param {string} partnerUid - The partner user whose watchlist is shared.
 * @returns {Promise<object>} The resolved requester and partner profiles.
 */
async function getValidatedCoupleUsers(selfUid, partnerUid) {
  // Load both profiles up front so routes can fail fast on missing users.
  const [me, partner] = await Promise.all([
    getProfileByUid(selfUid),
    getProfileByUid(partnerUid),
  ])

  if (!me || !partner) {
    const error = new Error("User not found")
    error.status = 404
    throw error
  }
  // Couple spaces are intentionally restricted to mutually connected users.
  const isFriend = await areUsersFriends(selfUid, partnerUid)
  if (!isFriend) {
    const error = new Error("Couple space is only for friends")
    error.status = 403
    throw error
  }
  return { me, partner }
}

module.exports = {
  getValidatedCoupleUsers,
}
