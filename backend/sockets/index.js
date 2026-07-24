/**
 * Socket bootstrap for the 2-GATHER backend. This file centralizes connection
 * lifecycle setup, shared dependency wiring, and delegation into focused socket
 * handler modules so auth, room state, and disconnect cleanup stay consistent.
 * The `roomRuntime` and `roomService` objects are passed in as dependency bags
 * to keep this file decoupled from lower-level modules and to avoid import tangles.
 */

'use strict'

const { registerChatSocketHandlers } =
  require('./chat.socket.js')
const { registerWebRTCSocketHandlers } =
  require('./webrtc.socket.js')
const { registerRoomSocketHandlers } =
  require('./room.socket.js')
const { registerVideoSocketHandlers } =
  require('./video.socket.js')
const {
  markOnline, markOffline, touchLastSeen,
} = require('../utils/presence.js')
const {
  isSocketEventRateLimited,
  clearSocketEventRateLimits,
} = require('../utils/rateLimit.js')
const {
  sanitize, sanitizeActivityPayload,
} = require('../utils/sanitize.js')
const {
  resolveVideoState,
} = require('../utils/helpers.js')
const { log, error } =
  require('../utils/logger.js')

/**
 * Registers 2-GATHER's Socket.IO connection lifecycle and delegates feature
 * handlers into room, video, chat, and WebRTC modules. By the time the
 * `connection` handler runs, the upstream socket auth middleware has already
 * verified the client's Firebase token and hydrated `socket.user` with the
 * trusted identity fields used below.
 * @param {import('socket.io').Server} io - Shared Socket.IO server instance.
 * @param {object} deps - Dependency bundle for socket features.
 * @param {object} deps.roomRuntime - In-memory room helpers and runtime constants.
 * @param {object} deps.roomService - Persistence and side-effect helpers used by socket handlers.
 * @returns {void}
 */
function registerSocketHandlers(io, {
  roomRuntime,
  roomService,
}) {
  const {
    rooms,
    emitToUidSocketsInRoom,
    removeSocketFromRoomUser,
    getRoomUserSocketIds,
    schedulePendingRoomUserDisconnect,
    clearSyncWait,
    handleSyncWait,
    deleteIfEmpty,
    pickNextRoomHostUid,
    getUserList,
    buildReadingInitialStatePayload,
    clampTime,
    addRoomHistory,
    recordOverlapForLeavingUser,
  } = roomRuntime
  const {
    archiveChatMessage,
    touchRoomActivity,
    recordSessionReaction,
    logActivity,
    getMongoConnected,
    UserProfileModel,
    memoryStore,
    markRoomParticipantLeft,
    updateRoomPlaybackState,
    updateRoomCreator,
  } = roomService
  // Room handlers also need structured logging, so wrap the service bag with logger helpers here once.
  const socketRoomService = { ...roomService, log, error }

  // Every accepted socket follows one shared lifecycle so auth, feature registration, and cleanup happen together.
  io.on("connection", (socket) => {
    // `socket.user` is trusted here because the upstream auth middleware already verified and normalized it.
    const { uid, name, username, photoURL } = socket.user;
    markOnline(uid, socket.id);
    touchLastSeen(uid, { mongoConnected: getMongoConnected(), UserProfileModel, memoryStore });

    log(`[connect] uid=${uid} socket=${socket.id}`);

    /**
     * Returns whether an incoming socket event should be dropped because this
     * socket exceeded its per-event sliding-window rate limit.
     * @param {string} eventType - Logical socket event name being handled.
     * @returns {boolean} True when the event should be ignored.
     */
    function shouldDropSocketEvent(eventType) {
      // Socket rate limiting is per-socket and per-event so rapid chat spam does
      // not block unrelated events like reconnect or playback sync.
      return isSocketEventRateLimited(socket.id, eventType);
    }

    // Register room lifecycle and reading/document handlers with the authenticated socket context.
    registerRoomSocketHandlers({
      io,
      socket,
      context: { uid, name, username, photoURL, shouldDropSocketEvent },
      roomRuntime,
      roomService: socketRoomService,
    })

    // Register shared playback handlers for watch, music, and co-reading modes.
    registerVideoSocketHandlers({
      io,
      socket,
      context: { uid, name, username, shouldDropSocketEvent },
      roomRuntime,
      roomService,
    })

    // Register room chat and message-reaction handlers.
    registerChatSocketHandlers({
      io, socket, rooms, uid, name, username, photoURL,
      shouldDropSocketEvent, archiveChatMessage,
      touchRoomActivity, recordSessionReaction,
      resolveVideoState, addRoomHistory,
      sanitize, sanitizeActivityPayload,
    })

    // Register WebRTC signaling handlers used for call offers, answers, and ICE candidates.
    registerWebRTCSocketHandlers({
      io, socket, rooms, uid, name,
      shouldDropSocketEvent, emitToUidSocketsInRoom,
    })

    /**
     * `disconnect`
     * Socket.IO emits this event with a reason when the transport closes. The
     * handler clears per-socket rate limits, updates presence, pauses playback
     * when needed, and schedules grace-period cleanup before finally removing
     * the user from room state.
     */
    socket.on("disconnect", (reason) => {
      log(`[disconnect] uid=${uid} reason=${reason}`);
      clearSocketEventRateLimits(socket.id);

      // Only persist last-seen when no other live tab/socket for the same user remains online.
      const stillOnline = markOffline(uid, socket.id);
      if (!stillOnline) {
        touchLastSeen(uid, { mongoConnected: getMongoConnected(), UserProfileModel, memoryStore });
      }

      const roomCode = socket.currentRoom;
      if (!roomCode) return;

      const room = rooms.get(roomCode);
      if (!room) return;

      const { roomUser, activeSocketCount } = removeSocketFromRoomUser(room, uid, socket.id);
      if (!roomUser) return;
      if (activeSocketCount > 0) return;

      room.memberTimes.delete(uid);
      if (room.syncWait.pausedUids.has(uid) || room.syncWait.waitingForUid === uid) {
        handleSyncWait(roomCode);
      }

      // Emit a temporary offline signal immediately, then let the grace timer decide whether this becomes a full leave.
      addRoomHistory(room, { type: "user_offline", uid, payload: { reason } });
      logActivity({
        uid,
        roomCode,
        type: "room_user_offline",
        payload: { reason: String(reason || "") },
      }).catch(() => {});

      if (
        room.sessionMode !== "music"
        && room.sessionMode !== "reading"
        && room.users.size > 1
        && room.videoState?.isPlaying
      ) {
        // If someone drops mid-session, pause the authoritative room state too;
        // otherwise one client can be paused locally while the server still thinks playback is running.
        clearSyncWait(roomCode);
        const resolvedState = resolveVideoState(room.videoState);
        room.videoState = {
          ...resolvedState,
          isPlaying: false,
          lastUpdate: Date.now() / 1000,
          scheduledStartAt: 0,
        };
        room.playbackStatus = "paused";
        room.baseTime = clampTime(room.videoState.currentTime);
        updateRoomPlaybackState(roomCode, {
          playbackStatus: "paused",
          baseTime: room.baseTime,
        }).catch(() => {});
        io.to(roomCode).emit("sync_state", {
          videoState: room.videoState,
          triggeredBy: `Paused while @${username || name || "friend"} reconnects`,
          serverTime: Date.now() / 1000,
        });
      }

      io.to(roomCode).emit("user_offline", { uid, name, username });

      const graceMs = 15000;
      // Delay full removal so short reconnects do not create ghost leaves or unnecessary host transfers.
      schedulePendingRoomUserDisconnect(roomCode, uid, graceMs, async () => {
        const liveRoom = rooms.get(roomCode);
        if (!liveRoom) return;

        const liveUser = liveRoom.users.get(uid);
        if (!liveUser) return;
        if (getRoomUserSocketIds(liveUser).length > 0) return;

        try {
          await recordOverlapForLeavingUser(liveRoom, uid, roomCode);
        } catch (err) {
          error("[memory] overlap save failed:", err.message);
        }

        if (liveRoom.createdBy === uid && liveRoom.sessionMode !== "music") {
          liveRoom.videoState = {
            ...liveRoom.videoState,
            isPlaying: false,
            lastUpdate: Date.now() / 1000,
            scheduledStartAt: 0,
          };
          liveRoom.playbackStatus = "paused";
          liveRoom.baseTime = clampTime(liveRoom.videoState.currentTime);
          updateRoomPlaybackState(roomCode, {
            playbackStatus: "paused",
            baseTime: liveRoom.baseTime,
          }).catch(() => {});
          io.to(roomCode).emit("sync_state", {
            videoState: liveRoom.videoState,
            triggeredBy: "Host went offline",
            serverTime: Date.now() / 1000,
          });
        }

        liveRoom.users.delete(uid);
        liveRoom.memberTimes.delete(uid);
        liveRoom.joinedAtByUid.delete(uid);
        addRoomHistory(liveRoom, { type: "user_left", uid, payload: { reason } });
        markRoomParticipantLeft(roomCode, uid).catch(() => {});
        logActivity({
          uid,
          roomCode,
          type: "room_user_left",
          payload: { graceMs },
        }).catch(() => {});

        io.to(roomCode).emit("peer_left_call", { uid });

        if (liveRoom.users.size === 0) {
          deleteIfEmpty(roomCode);
          return;
        }

        // If the old host is truly gone, pass ownership to the longest-present remaining member.
        if (liveRoom.createdBy === uid) {
          const nextHostUid = pickNextRoomHostUid(liveRoom);
          if (nextHostUid) {
            liveRoom.createdBy = nextHostUid;
            updateRoomCreator(roomCode, nextHostUid).catch(() => {});
            const nextHostUser = liveRoom.users.get(nextHostUid);
            io.to(roomCode).emit("host_transferred", {
              roomCode,
              previousHostId: uid,
              hostId: nextHostUid,
              hostUser: nextHostUser
                ? {
                  uid: nextHostUser.uid,
                  name: nextHostUser.name,
                  username: nextHostUser.username,
                  photoURL: nextHostUser.photoURL,
                }
                : null,
            });
            if (liveRoom.sessionMode === "reading") {
              io.to(roomCode).emit("initial_state", buildReadingInitialStatePayload(liveRoom));
            }
          }
        }

        io.to(roomCode).emit("user_count_update", {
          count: liveRoom.users.size,
          users: getUserList(liveRoom),
        });
        io.to(roomCode).emit("user_left", { uid, name });
      });
    });
  });
}

module.exports = { registerSocketHandlers }
