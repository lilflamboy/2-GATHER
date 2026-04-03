'use strict'

const { getProfileByUid } =
  require('./profile.service.js')
const { areUsersFriends } =
  require('./friends.service.js')

async function getValidatedCoupleUsers(selfUid, partnerUid) {
  const [me, partner] = await Promise.all([
    getProfileByUid(selfUid),
    getProfileByUid(partnerUid),
  ])

  if (!me || !partner) {
    const error = new Error("User not found")
    error.status = 404
    throw error
  }
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
