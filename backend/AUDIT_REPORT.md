## CRITICAL
No critical issues found.

## HIGH
FILE: backend/routes/uploads.routes.js
LINE: 47
SEVERITY: HIGH
TYPE: Security
ISSUE: The document download endpoint serves any uploaded file by ID without `requireHttpAuth` or an owner/room-membership check, even though uploads are stored with `ownerUid`.
FIX: Require authentication on download and verify the requester is the owner or an authorized participant before returning the file bytes.

FILE: backend/routes/watchlist.routes.js
LINE: 59
SEVERITY: HIGH
TYPE: Security
ISSUE: Watchlist item URLs are accepted as raw strings without scheme validation and are later rendered as clickable links in the dashboard, which allows `javascript:` or other dangerous URLs to be stored and opened.
FIX: Validate watchlist URLs as `http`/`https` only on write and reject or clear any non-web schemes before saving or rendering them.

FILE: backend/routes/friends.routes.js
LINE: 156
SEVERITY: HIGH
TYPE: Security
ISSUE: `/api/friends/invite-room` never verifies that the sender is actually in the room or that the room exists, so any authenticated friend can send invites for arbitrary room codes.
FIX: Load the room and confirm the requester is an active participant or host before creating the invite and notification.

FILE: backend/sockets/webrtc.socket.js
LINE: 36
SEVERITY: HIGH
TYPE: Security
ISSUE: `call_joined` and `call_left` broadcast call-presence events without checking that the socket belongs to the target room, so a client can spoof join/leave events into rooms it never joined.
FIX: Resolve the room and verify `room.users.has(uid)` before emitting any call-presence event.

FILE: backend/sockets/room.socket.js
LINE: 103, 212
SEVERITY: HIGH
TYPE: Security
ISSUE: `create_room` and `join_room` attach the same socket to a new room without leaving or cleaning up the previous room first, which can leak cross-room events and leave ghost members behind.
FIX: Enforce a single active room per socket by removing the socket from its previous room state and `socket.leave(...)` before any new room join succeeds.

FILE: backend/models/db.js
LINE: 52
SEVERITY: HIGH
TYPE: Data Loss
ISSUE: When MongoDB is unavailable the app silently falls back to in-memory writes for profiles, relationships, rooms, notifications, and sessions, so successful API calls can lose data on the next restart.
FIX: Fail closed for persistent features when Mongo is down or add a durable queue/store instead of treating volatile memory as a transparent persistence fallback.

FILE: backend/sockets/roomUtils.js
LINE: 388
SEVERITY: HIGH
TYPE: Data Loss
ISSUE: Room codes are only checked against live in-memory rooms, but persistent room records are keyed by unique `roomCode`, so a historical code collision can overwrite old room metadata and cause session dedupe to drop new sessions.
FIX: Reserve room codes globally at persistence time with collision retries or use a separate immutable room ID for all durable records.

## MEDIUM
FILE: backend/routes/memories.routes.js
LINE: 152
SEVERITY: MEDIUM
TYPE: Bug
ISSUE: `addMemoryEvent` is called with an object even though the service expects positional arguments, so the shared-memory path never records the corresponding memory event.
FIX: Call `addMemoryEvent(uidA, uidB, seconds, roomCode)` with the expected argument order or refactor the service to accept the object shape consistently.

FILE: backend/routes/friends.routes.js
LINE: 50
SEVERITY: MEDIUM
TYPE: Security
ISSUE: Friend presence is exposed with `isOnline(profile.uid)` without checking the target user’s `showOnlineStatus` preference, and the same pattern is repeated across other routes.
FIX: Centralize presence serialization so online state is only returned when the target user has opted in or the caller is otherwise authorized to see it.

FILE: backend/config/constants.js
LINE: 7, 59
SEVERITY: MEDIUM
TYPE: Bug
ISSUE: The API advertises a 20MB document upload limit while JSON parsing is capped at 14MB, so valid base64 uploads near the configured max fail before route validation runs.
FIX: Raise the body limit to account for base64 overhead or switch document uploads to multipart/streaming instead of JSON.

FILE: backend/services/profile.service.js
LINE: 231
SEVERITY: MEDIUM
TYPE: Performance
ISSUE: User search uses an unanchored regex across `username`, `displayName`, and `email` and then sorts by `updatedAt`, which will degrade into collection scans as profile volume grows.
FIX: Replace the regex search with indexed prefix fields, text search, or a dedicated search index that can satisfy both filtering and ordering efficiently.

FILE: backend/sockets/video.socket.js
LINE: 549
SEVERITY: MEDIUM
TYPE: Missing Validation
ISSUE: `time_update` trusts the client-supplied `username` field and rebroadcasts it to the room, so a member can spoof another display name in sync-wait and presence UI.
FIX: Ignore the payload username and always derive the broadcast label from the authenticated room user record already stored on the server.

## LOW
FILE: backend/middleware/errorHandler.js
LINE: 5
SEVERITY: LOW
TYPE: Security
ISSUE: The global error handler returns raw `err.message` values to clients, which can leak internal database or server details for unexpected failures.
FIX: Return generic messages for uncaught 5xx errors and only expose curated validation messages for known safe 4xx cases.

FILE: backend/routes/memories.routes.js
LINE: 143
SEVERITY: LOW
TYPE: Logic Error
ISSUE: Shared-memory notifications are always created and emitted even though the profile model stores a `memoryNudges` preference that suggests users can disable them.
FIX: Load the recipient profile and skip notification/socket delivery when `memoryNudges` is false, or remove the toggle if the feature is intentionally unconditional.

FILE: frontend/src/hooks/useAuthSession.js
LINE: 116
SEVERITY: LOW
TYPE: Logic Error
ISSUE: Sign-out clears session storage but never clears the in-memory `savedCode` state, so the previous room code can remain visible in the UI until a refresh or later state change.
FIX: Reset `savedCode` alongside the other room-scoped state during the sign-out branch.

FILE: frontend/src/hooks/useWebRTC.js
LINE: 42
SEVERITY: LOW
TYPE: Bug
ISSUE: The initiator emits a WebRTC offer before `setLocalDescription` finishes, which can create intermittent negotiation races on slower browsers or devices.
FIX: Await `setLocalDescription` before emitting the offer so the peer connection state is consistent when the remote side receives SDP.

## SUMMARY
- Total issues found: 16
- Critical: 0
- High: 7
- Medium: 5
- Low: 4
- Most affected file: backend/sockets/room.socket.js
- Biggest risk area: Realtime room/socket authorization and short-lived document sharing have the weakest access-control and state-isolation guarantees in the current codebase.
