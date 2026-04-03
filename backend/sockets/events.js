/**
 * Canonical Socket.IO event names shared across Lumiere's realtime features.
 * Centralizing these strings reduces typo bugs between emitters and listeners
 * and gives new events one obvious place to be added in the future.
 */

'use strict'

// Events are grouped by feature area so related client/server messages stay easy to discover and maintain.
const SOCKET_EVENTS = {
  // Connection and generic transport events emitted by Socket.IO itself or the server during lifecycle changes.
  CONNECT: 'connect', // Client sees this after a socket transport successfully connects.
  CONNECT_ERROR: 'connect_error', // Client sees this when auth or connection setup fails.
  CONNECTION: 'connection', // Server sees this when a new authenticated socket connects.
  DISCONNECT: 'disconnect', // Socket.IO emits this on disconnect with a reason string.
  ERROR: 'error', // Server emits generic realtime failures back to one client.

  // Chat events for message creation and emoji reactions inside a room.
  SEND_MESSAGE: 'send_message', // Client emits a new chat message payload.
  NEW_MESSAGE: 'new_message', // Server broadcasts one accepted message to the room.
  REACT_MESSAGE: 'react_message', // Client emits an emoji toggle for one message.
  MESSAGE_REACTION_UPDATE: 'message_reaction_update', // Server broadcasts the new reaction map for one message.

  // Room lifecycle and membership events for create/join/leave flows.
  CREATE_ROOM: 'create_room', // Client emits to create a brand-new room.
  JOIN_ROOM: 'join_room', // Client emits to join an existing room code.
  ROOM_JOINED: 'room_joined', // Server emits the initial joined-room snapshot to the caller.
  ROOM_EXPIRED: 'room_expired', // Server emits when an inactive room is deleted.
  USER_JOINED: 'user_joined', // Server broadcasts that a member joined or rejoined.
  USER_LEFT: 'user_left', // Server broadcasts that a member fully left after cleanup.
  USER_OFFLINE: 'user_offline', // Server broadcasts a temporary offline state during disconnect grace time.
  USER_COUNT_UPDATE: 'user_count_update', // Server broadcasts the authoritative current member list.
  HOST_TRANSFERRED: 'host_transferred', // Server broadcasts when host ownership moves to another member.
  INITIAL_STATE: 'initial_state', // Server emits the canonical room/reading state snapshot after joins or source changes.

  // Video and sync events used to keep room playback aligned across devices.
  REQUEST_PLAY: 'request_play', // Client emits a play request for the shared timeline.
  REQUEST_PAUSE: 'request_pause', // Client emits a pause request for the shared timeline.
  REQUEST_SEEK: 'request_seek', // Client emits a seek request with target time and optional playback state.
  BOOKMARK_SEEK: 'bookmark_seek', // Client emits when jumping everyone to a saved bookmark moment.
  VIDEO_METADATA: 'video_metadata', // Client emits media metadata for the currently loaded source.
  VIDEO_METADATA_UPDATED: 'video_metadata_updated', // Server broadcasts the accepted source metadata to peers.
  SYNC_STATE: 'sync_state', // Server broadcasts the authoritative video state.
  TIME_UPDATE: 'time_update', // Client emits periodic heartbeat samples for sync heuristics.
  MEMBER_TIME_UPDATE: 'member_time_update', // Server broadcasts lightweight peer time samples for UI indicators.
  FORCE_SYNC_WAIT: 'force_sync_wait', // Server tells faster members to pause while someone buffers.
  RESUME_SYNC_WAIT: 'resume_sync_wait', // Server tells paused members they can resume after wait-mode.
  SYNC_WAITING: 'sync_waiting', // Server broadcasts who the room is currently waiting for.
  SYNC_WAITING_RESOLVED: 'sync_waiting_resolved', // Server broadcasts that wait-mode has cleared.

  // Reading/document events for co-reading rooms and shared PDFs.
  UPLOAD_DOCUMENT: 'upload_document', // Client emits a PDF/document payload to become the shared room source.
  DOCUMENT_READY: 'document_ready', // Server broadcasts that a document is now ready for everyone.
  REQUEST_PAGE_CHANGE: 'request_page_change', // Client emits an ack-based page-change request.
  READING_PAGE_UPDATE: 'reading_page_update', // Client or server emits a page update notification.
  SYNC_PAGE: 'sync_page', // Server broadcasts the authoritative shared page number and metadata.

  // Audio/music events used for shared local-track or music-room sync.
  AUDIO_SYNC: 'audio_sync', // Server broadcasts the authoritative music/audio state to the room.

  // Social/product events emitted outside the core playback loop.
  COUPLE_SPACE_UPDATED: 'couple_space_updated', // Server emits when shared couple-space data changes.
  FRIEND_ADDED: 'friend_added', // Server emits when a friendship becomes accepted.
  FRIEND_INVITE: 'friend_invite', // Server emits a realtime room-invite notification.
  FRIEND_REQUEST_RECEIVED: 'friend_request_received', // Server emits when a new friend request arrives.
  FRIEND_REQUEST_UPDATED: 'friend_request_updated', // Server emits when a friend request is accepted or rejected.
  RELATIONSHIP_TAG_UPDATED: 'relationship_tag_updated', // Server emits when a relationship label changes.
  SHARED_MEMORY_ADDED: 'shared_memory_added', // Server emits when a shared memory/note is created.

  // WebRTC signaling events used only to exchange peer-connection metadata, not media streams.
  WEBRTC_OFFER: 'webrtc_offer', // Client emits an SDP offer to begin peer negotiation.
  WEBRTC_ANSWER: 'webrtc_answer', // Client emits an SDP answer back to the caller.
  WEBRTC_ICE_CANDIDATE: 'webrtc_ice_candidate', // Client emits one ICE candidate discovered during negotiation.
  CALL_JOINED: 'call_joined', // Client emits after joining the room call UI.
  CALL_LEFT: 'call_left', // Client emits after leaving the room call UI.
  PEER_JOINED_CALL: 'peer_joined_call', // Server broadcasts that a peer joined the call.
  PEER_LEFT_CALL: 'peer_left_call', // Server broadcasts that a peer left the call.
}

module.exports = { SOCKET_EVENTS }
