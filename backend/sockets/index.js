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
  const socketRoomService = { ...roomService, log, error }

  io.on("connection", (socket) => {
    const { uid, name, username, photoURL } = socket.user;
    markOnline(uid, socket.id);
    touchLastSeen(uid, { mongoConnected: getMongoConnected(), UserProfileModel, memoryStore });

    log(`[connect] uid=${uid} socket=${socket.id}`);

    function shouldDropSocketEvent(eventType) {
      // Socket rate limiting is per-socket and per-event so rapid chat spam does
      // not block unrelated events like reconnect or playback sync.
      return isSocketEventRateLimited(socket.id, eventType);
    }

    registerRoomSocketHandlers({
      io,
      socket,
      context: { uid, name, username, photoURL, shouldDropSocketEvent },
      roomRuntime,
      roomService: socketRoomService,
    })

    registerVideoSocketHandlers({
      io,
      socket,
      context: { uid, name, username, shouldDropSocketEvent },
      roomRuntime,
      roomService,
    })

    registerChatSocketHandlers({
      io, socket, rooms, uid, name, username, photoURL,
      shouldDropSocketEvent, archiveChatMessage,
      touchRoomActivity, recordSessionReaction,
      resolveVideoState, addRoomHistory,
      sanitize, sanitizeActivityPayload,
    })

    registerWebRTCSocketHandlers({
      io, socket, rooms, uid, name,
      shouldDropSocketEvent, emitToUidSocketsInRoom,
    })

    socket.on("disconnect", (reason) => {
      log(`[disconnect] uid=${uid} reason=${reason}`);
      clearSocketEventRateLimits(socket.id);

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

      addRoomHistory(room, { type: "user_offline", uid, payload: { reason } });
      logActivity({
        uid,
        roomCode,
        type: "room_user_offline",
        payload: { reason: String(reason || "") },
      }).catch(() => {});

      io.to(roomCode).emit("user_offline", { uid, name, username });

      const graceMs = 15000;
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
