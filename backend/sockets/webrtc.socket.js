/**
 * WebRTC signaling handlers for 2-GATHER room calls. The server forwards offers,
 * answers, and ICE candidates so peers can find each other, but the actual
 * media stream still flows directly between clients.
 */

'use strict'

/**
 * Registers WebRTC signaling handlers for one connected socket.
 * @param {object} deps - Runtime dependencies injected from the socket bootstrap.
 * @param {import('socket.io').Server} deps.io - Shared Socket.IO server instance.
 * @param {import('socket.io').Socket} deps.socket - Current connected client socket.
 * @param {Map<string, any>} deps.rooms - In-memory room registry keyed by room code.
 * @param {string} deps.uid - Authenticated uid owning this socket.
 * @param {string} deps.name - Display name used in call presence payloads.
 * @param {(eventType: string) => boolean} deps.shouldDropSocketEvent - Per-event rate-limit guard.
 * @param {(room: object, targetUid: string, eventName: string, payload: object) => number} deps.emitToUidSocketsInRoom - Emits to every socket owned by one target uid in the same room.
 * @returns {void}
 */
function registerWebRTCSocketHandlers({
  io,
  socket,
  rooms,
  uid,
  name,
  shouldDropSocketEvent,
  emitToUidSocketsInRoom,
}) {
  /**
   * `webrtc_offer`
   * Accepts `{ roomCode, offer, targetUid }`, verifies the caller is in the
   * room, and forwards the SDP offer to the target user's active sockets.
   */
  socket.on("webrtc_offer", ({ roomCode, offer, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_offer")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_offer", { offer, fromUid: uid, fromName: name });
  });

  /**
   * `webrtc_answer`
   * Accepts `{ roomCode, answer, targetUid }`, verifies room membership, and
   * forwards the SDP answer to the original caller's active sockets.
   */
  socket.on("webrtc_answer", ({ roomCode, answer, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_answer")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_answer", { answer, fromUid: uid });
  });

  /**
   * `webrtc_ice_candidate`
   * Accepts `{ roomCode, candidate, targetUid }` and forwards one ICE candidate
   * to the target peer because multiple candidates are exchanged per call.
   */
  socket.on("webrtc_ice_candidate", ({ roomCode, candidate, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_ice_candidate")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_ice_candidate", { candidate, fromUid: uid });
  });

  /**
   * `call_joined`
   * Accepts `{ roomCode }`, verifies the caller is really in the room after the
   * security fix, and broadcasts call presence to every other member.
   */
  socket.on("call_joined", ({ roomCode } = {}) => {
    if (shouldDropSocketEvent("call_joined")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    socket.to(roomCode).emit("peer_joined_call", { uid, name });
  });

  /**
   * `call_left`
   * Accepts `{ roomCode }`, verifies the caller is really in the room after the
   * security fix, and broadcasts call departure to every other member.
   */
  socket.on("call_left", ({ roomCode } = {}) => {
    if (shouldDropSocketEvent("call_left")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    socket.to(roomCode).emit("peer_left_call", { uid });
  });
}

module.exports = { registerWebRTCSocketHandlers }
