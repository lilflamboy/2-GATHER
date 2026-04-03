'use strict'

const memoryStore = {
  profiles: new Map(),
  memoryEvents: [],
  coupleSpaces: new Map(),
  relationships: new Map(),
  rooms: new Map(),
  roomParticipants: new Map(),
  invites: [],
  notifications: [],
  activityEvents: [],
  videoSessions: new Map(),
  chatMessages: [],
  sharedMemories: [],
  watchSessions: [],
  sessionReactions: [],
  milestones: new Map(),
  insights: [],
  uploadedDocuments: new Map(),
}

module.exports = { memoryStore }
