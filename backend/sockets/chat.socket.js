/**
 * Chat socket handlers for room messages and message reactions. All runtime
 * dependencies are injected from the connection bootstrap so this module stays
 * focused on chat behavior instead of importing global room state directly.
 */

'use strict'

/**
 * Registers chat-specific realtime handlers for one connected socket.
 * @param {object} deps - Runtime dependencies injected from the socket bootstrap.
 * @param {import('socket.io').Server} deps.io - Shared Socket.IO server used for room broadcasts.
 * @param {import('socket.io').Socket} deps.socket - Current connected client socket.
 * @param {Map<string, any>} deps.rooms - In-memory room registry keyed by room code.
 * @param {string} deps.uid - Authenticated uid for this socket.
 * @param {string} deps.name - Display name resolved during socket auth.
 * @param {string} deps.username - Username resolved during socket auth.
 * @param {string} deps.photoURL - Sanitized avatar URL attached to emitted chat messages.
 * @param {(eventType: string) => boolean} deps.shouldDropSocketEvent - Per-event rate-limit guard.
 * @param {(roomCode: string, message: object) => Promise<any>} deps.archiveChatMessage - Persists accepted chat rows.
 * @param {(roomCode: string) => Promise<any>} deps.touchRoomActivity - Refreshes the room activity timestamp.
 * @param {(payload: object) => Promise<any>} deps.recordSessionReaction - Persists reaction analytics rows.
 * @param {(state: object) => object} deps.resolveVideoState - Resolves the current playback position for highlights.
 * @param {(room: object, entry: object) => void} deps.addRoomHistory - Appends one room-history event.
 * @param {(value: string) => string} deps.sanitize - Base sanitizer for message text.
 * @param {(payload: any) => any} deps.sanitizeActivityPayload - Deep sanitizer for structured message metadata.
 * @returns {void}
 */
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
  /**
   * `send_message`
   * Accepts `{ roomCode, text, type, meta }`, sanitizes the text payload,
   * stores it in the room's rolling 200-message buffer, archives it, and
   * broadcasts the normalized message object to the whole room.
   */
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
    // Keep room-local chat bounded so reconnect payloads stay reasonably small.
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

  /**
   * `react_message`
   * Accepts `{ roomCode, messageId, emoji }`, toggles the caller's one active
   * emoji reaction on that message, records a session reaction when needed, and
   * broadcasts the updated reaction map for that message.
   */
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
      // Applying a new emoji records a session reaction so highlights and analytics can reuse the same event.
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
