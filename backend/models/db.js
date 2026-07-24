/**
 * MongoDB bootstrap and model registry for the 2-GATHER backend. This file owns
 * the mongoose connection lifecycle, exposes a live connection-state getter,
 * and re-exports every model so the rest of the codebase can depend on one
 * stable import path even when MongoDB is unavailable.
 */

'use strict'

const { MONGODB_URI } = require('../config/constants.js')

// Mongoose is required lazily so the app can still boot in environments where
// the dependency or database is intentionally unavailable.
let mongoose = null
try {
  mongoose = require('mongoose')
} catch {
  console.warn('[2-gather] [db] mongoose not installed. Running with in-memory fallback.')
}

// This flag changes after startup, so it must stay mutable. Callers read it
// through getMongoConnected() because exporting a primitive directly would
// freeze the initial value at import time.
let mongoConnected = false

// Profile/account model handles.
let UserProfileModel = null
// Memory and shared-memory model handles.
let MemoryEventModel = null
let SharedMemoryModel = null
// Relationship and couple-space model handles.
let CoupleSpaceModel = null
let RelationshipModel = null
// Room metadata and per-user room membership model handles.
let RoomModel = null
let RoomParticipantModel = null
// Invite and notification model handles.
let InviteModel = null
let NotificationModel = null
// Activity and session model handles.
let ActivityEventModel = null
let VideoSessionModel = null
let WatchSessionModel = null
let SessionReactionModel = null
// Insights, milestones, and archived chat model handles.
let ChatArchiveModel = null
let MilestoneModel = null
let InsightModel = null

/**
 * Returns the current MongoDB connection state.
 * @returns {boolean} True when mongoose has an active connection.
 */
const getMongoConnected = () => mongoConnected

/**
 * Loads every model module and refreshes the exported handles in this registry.
 * @returns {void} This function only updates module-scoped model references.
 */
function assignModels() {
  // User profile domain models.
  ;({ UserProfileModel } = require('./user.model.js'))
  // Room metadata and participant history models.
  ;({ RoomModel, RoomParticipantModel } = require('./room.model.js'))
  // Relationship graph and couple-space models.
  ;({ RelationshipModel, CoupleSpaceModel } = require('./relationship.model.js'))
  // Invite and notification delivery models.
  ;({ InviteModel, NotificationModel } = require('./invite.model.js'))
  // Live session, completed session, reaction, and activity-log models.
  ;({
    VideoSessionModel,
    WatchSessionModel,
    SessionReactionModel,
    ActivityEventModel,
  } = require('./session.model.js'))
  // Memory-event and shared-memory note models.
  ;({ SharedMemoryModel, MemoryEventModel } = require('./memory.model.js'))
  // Archived chat, milestone, and yearly insight models.
  ;({
    ChatArchiveModel,
    InsightModel,
    MilestoneModel,
  } = require('./insight.model.js'))
}

// Populate the exported handles immediately so callers can safely import this
// module before initMongo() runs.
assignModels()

/**
 * Attempts to connect mongoose and keep the app on persistent storage when
 * available. On success the connection flag flips to true; on failure or when
 * MongoDB is missing, the backend logs the reason and continues on the
 * in-memory fallback instead of crashing startup.
 * @returns {Promise<void>} Resolves after the connection attempt completes.
 */
async function initMongo() {
  // Re-read model modules in case startup order loaded them before mongoose was
  // available or before this registry was first initialized.
  assignModels()

  // If mongoose itself is unavailable, the app must stay in fallback mode.
  if (!mongoose) return
  // If no URI is configured, skip connection attempts and stay in memory mode.
  if (!MONGODB_URI) {
    console.warn('[2-gather] [db] MONGODB_URI missing. Using in-memory fallback for social features.')
    return
  }

  try {
    // A short selection timeout keeps startup responsive when the database is
    // unreachable instead of hanging the whole backend for a long period.
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 6000,
    })
    mongoConnected = true
    console.log('[2-gather] [db] MongoDB connected')
  } catch (err) {
    // The backend intentionally degrades to the volatile memory store so local
    // development or partial outages do not stop the whole server from booting.
    mongoConnected = false
    console.error('[2-gather] [db] MongoDB connection failed. Using in-memory fallback:', err.message)
  }
}

// Re-export every model from one place so services can depend on this module
// instead of importing model files individually and duplicating connection logic.
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
