'use strict'

const {
  UserProfileModel, RoomModel, RelationshipModel,
  InviteModel, ActivityEventModel, SharedMemoryModel,
  NotificationModel, WatchSessionModel, MilestoneModel,
  InsightModel, getMongoConnected,
} = require('../models/db.js')
const { memoryStore } =
  require('../models/memoryStore.js')

async function getProjectOverview(uid) {
  const selfUid = String(uid || '').trim()
  const now = Date.now()
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000

  if (getMongoConnected()) {
    const [
      users,
      rooms,
      activeRooms,
      relationships,
      invitesSent,
      activities,
      sharedMemories,
      notifications,
      watchSessions,
      milestones,
      insights,
      recentActivity,
      recentRooms,
    ] = await Promise.all([
      UserProfileModel.countDocuments({}),
      RoomModel.countDocuments({}),
      RoomModel.countDocuments({ isActive: true }),
      RelationshipModel.countDocuments({ status: 'accepted' }),
      selfUid ? InviteModel.countDocuments({ fromUid: selfUid }) : Promise.resolve(0),
      selfUid ? ActivityEventModel.countDocuments({ uid: selfUid }) : Promise.resolve(0),
      selfUid ? SharedMemoryModel.countDocuments({ $or: [{ user1Id: selfUid }, { user2Id: selfUid }] }) : Promise.resolve(0),
      selfUid ? NotificationModel.countDocuments({ recipientUid: selfUid, isRead: false }) : Promise.resolve(0),
      selfUid ? WatchSessionModel.countDocuments({ participants: selfUid }) : WatchSessionModel.countDocuments({}),
      selfUid ? MilestoneModel.countDocuments({ users: selfUid }) : MilestoneModel.countDocuments({}),
      selfUid ? InsightModel.countDocuments({ users: selfUid }) : InsightModel.countDocuments({}),
      selfUid ? ActivityEventModel.find({ uid: selfUid }).sort({ occurredAt: -1 }).limit(12).lean() : Promise.resolve([]),
      RoomModel.find({}).sort({ createdAt: -1 }).limit(12).lean(),
    ])

    const weekActivities = selfUid
      ? await ActivityEventModel.countDocuments({ uid: selfUid, occurredAt: { $gte: new Date(weekAgo) } })
      : 0

    return {
      counts: {
        users,
        rooms,
        activeRooms,
        relationships,
        invitesSent,
        activities,
        activitiesThisWeek: weekActivities,
        sharedMemories,
        notifications,
        watchSessions,
        milestones,
        insights,
      },
      recentActivity: recentActivity.map((item) => ({
        type: item.type,
        occurredAt: item.occurredAt,
        roomCode: item.roomCode || '',
        targetUid: item.targetUid || '',
      })),
      recentRooms: recentRooms.map((item) => ({
        roomCode: item.roomCode,
        roomType: item.roomType,
        sessionMode: item.sessionMode || 'watch',
        isActive: !!item.isActive,
        createdAt: item.createdAt,
      })),
      permissionsTemplate: { play: true, pause: true, seek: true, skip: true },
      syncStatePolicy: 'ephemeral_in_memory',
    }
  }

  const recentActivity = memoryStore.activityEvents
    .filter((item) => !selfUid || item.uid === selfUid)
    .slice(-12)
    .reverse()
    .map((item) => ({
      type: item.type,
      occurredAt: item.occurredAt,
      roomCode: item.roomCode || '',
      targetUid: item.targetUid || '',
    }))

  const weekActivities = memoryStore.activityEvents.filter((item) => (!selfUid || item.uid === selfUid) && new Date(item.occurredAt).getTime() >= weekAgo).length
  const invitesSent = memoryStore.invites.filter((item) => !selfUid || item.fromUid === selfUid).length
  const sharedMemories = memoryStore.sharedMemories.filter((item) => !selfUid || item.user1Id === selfUid || item.user2Id === selfUid).length
  const notifications = memoryStore.notifications.filter((item) => !selfUid || (item.recipientUid === selfUid && !item.isRead)).length
  const watchSessions = selfUid
    ? memoryStore.watchSessions.filter((item) => Array.isArray(item.participants) && item.participants.includes(selfUid)).length
    : memoryStore.watchSessions.length
  const milestones = selfUid
    ? [...memoryStore.milestones.values()].filter((item) => Array.isArray(item.users) && item.users.includes(selfUid)).length
    : memoryStore.milestones.size
  const insights = selfUid
    ? memoryStore.insights.filter((item) => Array.isArray(item.users) && item.users.includes(selfUid)).length
    : memoryStore.insights.length
  const recentRooms = [...memoryStore.rooms.values()]
    .slice(-12)
    .reverse()
    .map((item) => ({
      roomCode: item.roomCode,
      roomType: item.roomType,
      sessionMode: item.sessionMode || 'watch',
      isActive: !!item.isActive,
      createdAt: item.createdAt,
    }))

  return {
    counts: {
      users: memoryStore.profiles.size,
      rooms: memoryStore.rooms.size,
      activeRooms: [...memoryStore.rooms.values()].filter((room) => room.isActive).length,
      relationships: [...memoryStore.relationships.values()].filter((row) => row.status === 'accepted').length,
      invitesSent,
      activities: selfUid ? memoryStore.activityEvents.filter((item) => item.uid === selfUid).length : memoryStore.activityEvents.length,
      activitiesThisWeek: weekActivities,
      sharedMemories,
      notifications,
      watchSessions,
      milestones,
      insights,
    },
    recentActivity,
    recentRooms,
    permissionsTemplate: { play: true, pause: true, seek: true, skip: true },
    syncStatePolicy: 'ephemeral_in_memory',
  }
}

module.exports = { getProjectOverview }
