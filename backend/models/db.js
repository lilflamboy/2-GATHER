'use strict'

const { MONGODB_URI } = require('../config/constants.js')

let mongoose = null
try {
  mongoose = require('mongoose')
} catch {
  console.warn('[lumiere] [db] mongoose not installed. Running with in-memory fallback.')
}

let mongoConnected = false

let UserProfileModel = null
let MemoryEventModel = null
let CoupleSpaceModel = null
let RelationshipModel = null
let RoomModel = null
let RoomParticipantModel = null
let InviteModel = null
let ActivityEventModel = null
let VideoSessionModel = null
let ChatArchiveModel = null
let SharedMemoryModel = null
let NotificationModel = null
let WatchSessionModel = null
let SessionReactionModel = null
let MilestoneModel = null
let InsightModel = null

const getMongoConnected = () => mongoConnected

function assignModels() {
  ;({ UserProfileModel } = require('./user.model.js'))
  ;({ RoomModel, RoomParticipantModel } = require('./room.model.js'))
  ;({ RelationshipModel, CoupleSpaceModel } = require('./relationship.model.js'))
  ;({ InviteModel, NotificationModel } = require('./invite.model.js'))
  ;({
    VideoSessionModel,
    WatchSessionModel,
    SessionReactionModel,
    ActivityEventModel,
  } = require('./session.model.js'))
  ;({ SharedMemoryModel, MemoryEventModel } = require('./memory.model.js'))
  ;({
    ChatArchiveModel,
    InsightModel,
    MilestoneModel,
  } = require('./insight.model.js'))
}

assignModels()

async function initMongo() {
  assignModels()

  if (!mongoose) return
  if (!MONGODB_URI) {
    console.warn('[lumiere] [db] MONGODB_URI missing. Using in-memory fallback for social features.')
    return
  }

  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 6000,
    })
    mongoConnected = true
    console.log('[lumiere] [db] MongoDB connected')
  } catch (err) {
    mongoConnected = false
    console.error('[lumiere] [db] MongoDB connection failed. Using in-memory fallback:', err.message)
  }
}

module.exports = {
  initMongo,
  getMongoConnected,
  UserProfileModel,
  MemoryEventModel,
  CoupleSpaceModel,
  RelationshipModel,
  RoomModel,
  RoomParticipantModel,
  InviteModel,
  ActivityEventModel,
  VideoSessionModel,
  ChatArchiveModel,
  SharedMemoryModel,
  NotificationModel,
  WatchSessionModel,
  SessionReactionModel,
  MilestoneModel,
  InsightModel,
}
