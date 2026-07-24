/**
 * In-memory fallback collections for the 2-GATHER backend. This store is used
 * when MongoDB is unavailable so the app can still run basic social and room
 * flows, but every entry is volatile and will be lost on restart. It mirrors
 * the Mongo-backed domains for profiles, relationships, rooms, notifications,
 * sessions, memories, insights, and temporary uploads.
 */

'use strict'

const memoryStore = {
  // User profiles keyed by Firebase uid. Entries are created on sign-in and
  // replaced whenever a profile is saved through the profile service.
  profiles: new Map(),
  // Raw memory-event rows appended as watch overlap is recorded and read back
  // for the memories timeline; entries stay until the process exits.
  memoryEvents: [],
  // Couple-space records keyed by pairKey (`uidA__uidB` sorted pair) and
  // updated whenever watchlist items or shared space metadata changes.
  coupleSpaces: new Map(),
  // Relationship rows keyed by pairKey (`uidA__uidB` sorted pair), added when
  // friend requests are created and updated as relationship state changes.
  relationships: new Map(),
  // Room metadata keyed by uppercase roomCode, added on room creation and
  // removed when a room expires or is deleted from live state.
  rooms: new Map(),
  // Per-user room participation keyed by `ROOMCODE__uid`, updated on join/leave
  // so room history and access checks can still function without MongoDB.
  roomParticipants: new Map(),
  // Invite records stored as append-only rows for room-invite history when the
  // persistent Invite collection is unavailable.
  invites: [],
  // Notification rows appended on delivery and mutated in place when marked
  // read; these mirror the Notification collection shape.
  notifications: [],
  // Activity log entries appended for audit/activity feeds while the process is
  // alive; they are not durable without MongoDB.
  activityEvents: [],
  // Live video-session metadata keyed by roomCode and updated as playback
  // metadata changes inside an active room.
  videoSessions: new Map(),
  // Archived chat messages appended after send_message events so room history
  // can still render recent messages without MongoDB.
  chatMessages: [],
  // User-created shared memory notes appended as they are created in the
  // dashboard or room flows.
  sharedMemories: [],
  // Completed watch-session records appended when rooms are finalized and used
  // later for analytics, history, and insights.
  watchSessions: [],
  // Per-reaction events appended as chat or session reactions are recorded.
  sessionReactions: [],
  // Achievement rows keyed by pairKey/type-style identifiers, updated when a
  // relationship earns or refreshes a milestone.
  milestones: new Map(),
  // Yearly/generated insight rows appended for dashboard summaries.
  insights: [],
  // Temporary uploaded documents keyed by document id and pruned when expired
  // or after the process restarts.
  uploadedDocuments: new Map(),
}

module.exports = { memoryStore }
