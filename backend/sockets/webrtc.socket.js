'use strict'

function registerWebRTCSocketHandlers({
  io,
  socket,
  rooms,
  uid,
  name,
  shouldDropSocketEvent,
  emitToUidSocketsInRoom,
}) {
  socket.on("webrtc_offer", ({ roomCode, offer, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_offer")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_offer", { offer, fromUid: uid, fromName: name });
  });

  socket.on("webrtc_answer", ({ roomCode, answer, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_answer")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_answer", { answer, fromUid: uid });
  });

  socket.on("webrtc_ice_candidate", ({ roomCode, candidate, targetUid } = {}) => {
    if (shouldDropSocketEvent("webrtc_ice_candidate")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    emitToUidSocketsInRoom(room, targetUid, "webrtc_ice_candidate", { candidate, fromUid: uid });
  });

  socket.on("call_joined", ({ roomCode } = {}) => {
    if (shouldDropSocketEvent("call_joined")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    socket.to(roomCode).emit("peer_joined_call", { uid, name });
  });

  socket.on("call_left", ({ roomCode } = {}) => {
    if (shouldDropSocketEvent("call_left")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    socket.to(roomCode).emit("peer_left_call", { uid });
  });
}

module.exports = { registerWebRTCSocketHandlers }
