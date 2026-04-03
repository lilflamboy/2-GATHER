'use strict'

function registerChatSocketHandlers({
  io,
  socket,
  rooms,
  uid,
  name,
  username,
  photoURL,
  shouldDropSocketEvent,
  archiveChatMessage,
  touchRoomActivity,
  recordSessionReaction,
  resolveVideoState,
  addRoomHistory,
  sanitize,
  sanitizeActivityPayload,
}) {
  socket.on("send_message", ({ roomCode, text, type, meta } = {}) => {
    if (shouldDropSocketEvent("send_message")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;

    const sanitized = sanitize(text);
    if (!sanitized) return;

    const senderUsername = room.users.get(uid)?.username || name;
    // Chat messages are normalized into one room-local shape that supports both
    // plain text and structured system/bookmark payloads.
    const msg = {
      id: `${uid}-${Date.now()}`,
      uid,
      senderName: name,
      senderUsername,
      photoURL,
      text: sanitized,
      type: type || "text",
      meta: meta == null ? null : sanitizeActivityPayload(meta),
      timestamp: Date.now(),
      reactions: {},
    };

    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    addRoomHistory(room, {
      type: "chat_message",
      uid,
      payload: {
        messageId: msg.id,
        kind: msg.type,
      },
    });
    archiveChatMessage(roomCode, msg).catch(() => {});
    touchRoomActivity(roomCode).catch(() => {});

    io.to(roomCode).emit("new_message", msg);
  });

  socket.on("react_message", ({ roomCode, messageId, emoji } = {}) => {
    if (shouldDropSocketEvent("react_message")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    if (!emoji || typeof emoji !== "string") return;

    const msg = room.messages.find((entry) => entry.id === messageId);
    if (!msg) return;

    const reactions = msg.reactions || {};
    let hadSame = false;
    // Reactions are stored as emoji -> [uids], but each user can only have one
    // active reaction per message, so toggling one removes any previous choice.
    Object.keys(reactions).forEach((key) => {
      const list = Array.isArray(reactions[key]) ? reactions[key] : [];
      const idx = list.indexOf(uid);
      if (idx !== -1) {
        if (key === emoji) hadSame = true;
        list.splice(idx, 1);
      }
      if (list.length === 0) {
        delete reactions[key];
      } else {
        reactions[key] = list;
      }
    });

    if (!hadSame) {
      if (!reactions[emoji]) reactions[emoji] = [];
      reactions[emoji].push(uid);
      const resolvedState = resolveVideoState(room.videoState);
      addRoomHistory(room, {
        type: "reaction",
        uid,
        payload: {
          messageId,
          emoji,
          currentTime: resolvedState.currentTime,
        },
      });
      touchRoomActivity(roomCode).catch(() => {});
      recordSessionReaction({
        roomCode,
        userUid: uid,
        messageId,
        timestamp: resolvedState.currentTime,
        reactionType: "reaction",
        emoji,
      }).catch(() => {});
    }

    msg.reactions = reactions;

    io.to(roomCode).emit("message_reaction_update", {
      messageId,
      reactions,
    });
  });
}

module.exports = { registerChatSocketHandlers }
