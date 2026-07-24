# FLAMBOYS- STUDIO-SCREEN MongoDB Architecture

FLAMBOYS- STUDIO-SCREEN stores relationship intelligence and memory analytics in MongoDB.
It does not store copyrighted media files or stream payloads.

## Core collections

## `UserProfile` (`users`)

Identity and user-level analytics:

- `uid` (Firebase UID, unique)
- `username`, `displayName`, `photoURL`, `email`, `phoneNumber`, `bio`
- friendship arrays and settings
- `totalWatchTime`, `totalSessions`, `streakCount`, `lastSessionAt`
- `preferences.favoriteGenres`, `preferences.activeTimeSlots`

## `Relationship` (`relationships`)

Pair-level social graph and analytics:

- `pairKey` (sorted pair, unique)
- `users` (2 user IDs), `requesterUid`, `recipientUid`, `status`
- `relationshipType` (`couple`, `friends`, `family`)
- `totalWatchTime`, `totalSessions`, `longestSession`, `streak`
- `firstWatchedAt`, `lastWatchedAt`, `topGenres`, `activeTimeSlots`
- `lastSessionMode`

## `Room` (`rooms`)

Room metadata and state:

- `roomCode` (unique), `roomType`, `sessionMode`, `createdBy`
- `moodTag` (optional emotion context for the session)
- `isActive`, `maxParticipants`, `expiresAt`, `closedAt`, `lastActivityAt`
- `contentUrl`, `contentType`
- `playbackStatus`, `baseTime`, `startedAt`

## `RoomParticipant` (`roomParticipants`)

Join/leave trail for access control and session reconstruction:

- `roomCode`, `userId` (unique composite)
- `joinedAt`, `leftAt`, `isActive`, `role`

## `WatchSession` (`watchSessions`)

Long-term memory layer for shared sessions:

- `roomCode`, `roomId` (dedupe key when available)
- `roomType`, `sessionMode`
- `participants`
- `relationshipId`, `relationshipType`
- `contentUrl`, `contentTitle`, `contentType`, `genre`
- `moodTag`
- `duration`, `startedAt`, `endedAt`
- `reactionsCount`
- `highlights[]` (`timestamp`, `reactionType`, `userUid`, `emoji`)

## `SessionReaction` (`sessionReactions`)

High-volume emotional interaction events:

- `sessionId` (linked after room finalization), `roomCode`
- `userUid`, `messageId`
- `timestamp`, `reactionType`, `emoji`, `createdAt`

## `Milestone` (`milestones`)

Gamified relationship achievements:

- `pairKey`, `relationshipId`, `users`
- `type` (for example `first_movie`, `10_sessions`, `100_hours`)
- `achievedAt`, `payload`

## `Insight` (`insights`)

Yearly relationship summary snapshots:

- `pairKey`, `relationshipId`, `users`
- `year`
- `summaryText`, `favoriteGenre`, `watchPattern`, `moodTrend`
- `generatedAt`

## Other persistent collections

- `Invite`
- `Notification`
- `ActivityEvent`
- `MemoryEvent`
- `SharedMemory`
- `ChatArchive`
- `VideoSession`
- `CoupleSpace`

## Intentionally not stored

- movie files
- OTT stream payloads
- raw copyrighted media blobs

Only references/metadata are persisted (`contentUrl`, titles, timestamps, analytics).

## Real-time vs persistent boundary

In-memory (ephemeral):

- live sync clock
- transient socket presence
- active WebRTC signaling state
- temporary co-reading document uploads served from expiring `/api/uploads/document/:id` URLs

MongoDB (persistent):

- people and relationships
- room/session history
- reactions/highlights
- milestones and insight summaries
