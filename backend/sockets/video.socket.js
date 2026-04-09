/**
 * Playback and media-state socket handlers for watch, music, and co-reading
 * rooms. The server acts as the single source of truth for shared state while
 * clients report local actions and heartbeat samples.
 */

'use strict'

/**
 * Registers playback-related socket handlers for one connected client.
 * @param {object} deps - Runtime dependencies injected from the socket bootstrap.
 * @param {import('socket.io').Server} deps.io - Shared Socket.IO server used for room broadcasts.
 * @param {import('socket.io').Socket} deps.socket - Current connected client socket.
 * @param {object} deps.context - Authenticated user context for this socket.
 * @param {object} deps.roomRuntime - In-memory room helpers and runtime constants.
 * @param {object} deps.roomService - Persistence and side-effect helpers for playback events.
 * @returns {void}
 */
function registerVideoSocketHandlers({
  io,
  socket,
  context,
  roomRuntime,
  roomService,
}) {
  const {
    uid, name, username,
    shouldDropSocketEvent,
  } = context
  const {
    rooms,
    AUDIO_SCHEDULE_LEAD_MS,
    AUDIO_TOGGLE_DEBOUNCE_MS,
    clampTime,
    validateMusicControlRequest,
    acquireAudioMutationLock,
    resolveRoomAudioPosition,
    addRoomHistory,
    buildRoomMusicStatePayload,
    broadcastRoomAudioSync,
    clearSyncWait,
    resolveSessionEngine,
    getScheduledVideoStartAt,
    normalizeMetadataForSessionEngine,
    resolveMusicMediaType,
    normalizeRoomDocumentPayload,
    deriveDocumentFileNameFromUrl,
    getRoomDocumentPayload,
    buildReadingInitialStatePayload,
    handleSyncWait,
  } = roomRuntime
  const {
    touchRoomActivity,
    logActivity,
    updateRoomPlaybackState,
    recordSessionReaction,
    saveVideoSessionMetadata,
    updateRoomContentState,
  } = roomService

  /**
   * `request_play`
   * Accepts `{ roomCode, currentTime, fileSignature }`, validates room control,
   * transitions the canonical playback state into playing, and broadcasts the
   * authoritative play state to the room.
   */
  socket.on("request_play", ({ roomCode, currentTime, fileSignature } = {}, ack) => {
    if (shouldDropSocketEvent("request_play")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
      return;
    }
    // Study mode: only the room creator (teacher) can
    // control playback. Drop the event silently if a
    // student tries to trigger it.
    if (
      room.sessionMode === "study" &&
      uid !== room.createdBy
    ) {
      return;
    }
    if (room.sessionMode === "music") {
      // Local audio cannot be synchronized safely unless everyone loaded the
      // same file, so music control checks the shared file signature first.
      const validation = validateMusicControlRequest(room, fileSignature);
      if (!validation.ok) {
        socket.emit("error", { message: validation.error });
        if (typeof ack === "function") ack({ ok: false, error: validation.error });
        return;
      }
      if (!acquireAudioMutationLock(room)) {
        if (typeof ack === "function") ack({ ok: false, error: "Another playback change is already in progress" });
        return;
      }
      const nowMs = Date.now();
      if (room.audioState.status === "playing" && (nowMs - Number(room.lastAudioActionAt || 0)) < AUDIO_TOGGLE_DEBOUNCE_MS) {
        if (typeof ack === "function") ack({ ok: true, ignored: true });
        return;
      }

      // Music playback is scheduled slightly in the future so every client can
      // line up their local clock before the shared "play" moment arrives.
      const time = clampTime(currentTime ?? resolveRoomAudioPosition(room, nowMs));
      room.audioState = {
        status: "playing",
        startTime: time,
        serverTime: nowMs + AUDIO_SCHEDULE_LEAD_MS,
        updatedAt: nowMs,
        playbackRate: 1,
        updatedBy: uid,
      };
      room.lastAudioActionAt = nowMs;
      room.playbackStatus = "playing";
      room.baseTime = time;
      room.startedAt = room.startedAt || new Date();
      addRoomHistory(room, {
        type: "music_play",
        uid,
        payload: {
          currentTime: time,
          mediaType: room.mediaType,
          hasUrl: !!room.mediaMeta?.url,
          hasSignature: !!room.mediaMeta?.fileSignature,
        },
      });
      touchRoomActivity(roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "room_music_play",
        payload: { currentTime: Number(time.toFixed(3)), sessionEngineId: "MusicEngine" },
      }).catch(() => {});
      broadcastRoomAudioSync(room, { action: "play", triggeredBy: name });
      if (typeof ack === "function") ack({ ok: true, audioState: buildRoomMusicStatePayload(room).audioState });
      return;
    }
    const engine = resolveSessionEngine(room.sessionMode);
    if (!engine.allowPlayback) return;

    clearSyncWait(roomCode);
    // Non-music modes share one authoritative video state; a new play request
    // resets any temporary wait-mode and broadcasts a fresh playback baseline.
    const time = clampTime(currentTime ?? room.videoState.currentTime);
    const nowSec = Date.now() / 1000;
    const scheduledStartAt = getScheduledVideoStartAt(room, true, nowSec);
    room.videoState = {
      currentTime: time,
      isPlaying: true,
      playbackRate: room.videoState.playbackRate,
      lastUpdate: nowSec,
      scheduledStartAt,
    };
    room.playbackStatus = "playing";
    room.baseTime = time;
    room.startedAt = room.startedAt || new Date();
    addRoomHistory(room, { type: "play", uid, payload: { currentTime: time } });
    touchRoomActivity(roomCode).catch(() => {});
    logActivity({
      uid,
      roomCode,
      type: "room_play",
      payload: { currentTime: Number(time.toFixed(2)), sessionEngineId: engine.id },
    }).catch(() => {});
    updateRoomPlaybackState(roomCode, {
      playbackStatus: "playing",
      baseTime: time,
      startedAt: room.startedAt,
    }).catch(() => {});

    io.to(roomCode).emit("sync_state", { videoState: room.videoState, triggeredBy: name, serverTime: Date.now() / 1000 });
    if (typeof ack === "function") ack({ ok: true });
  });

  /**
   * `request_pause`
   * Accepts `{ roomCode, currentTime, fileSignature }`, validates room control,
   * snapshots the current canonical position, and broadcasts the paused state.
   */
  socket.on("request_pause", ({ roomCode, currentTime, fileSignature } = {}, ack) => {
    if (shouldDropSocketEvent("request_pause")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
      return;
    }
    // Study mode: only the room creator (teacher) can
    // control playback. Drop the event silently if a
    // student tries to trigger it.
    if (
      room.sessionMode === "study" &&
      uid !== room.createdBy
    ) {
      return;
    }
    if (room.sessionMode === "music") {
      const validation = validateMusicControlRequest(room, fileSignature);
      if (!validation.ok) {
        socket.emit("error", { message: validation.error });
        if (typeof ack === "function") ack({ ok: false, error: validation.error });
        return;
      }
      if (!acquireAudioMutationLock(room)) {
        if (typeof ack === "function") ack({ ok: false, error: "Another playback change is already in progress" });
        return;
      }
      const nowMs = Date.now();
      if ((nowMs - Number(room.lastAudioActionAt || 0)) < AUDIO_TOGGLE_DEBOUNCE_MS && room.audioState.status === "paused") {
        if (typeof ack === "function") ack({ ok: true, ignored: true });
        return;
      }

      // Pause snapshots the exact resolved server-side position so later resume
      // starts from the same timeline point on every participant's device.
      const pausedTime = clampTime(
        currentTime ?? (room.audioState.status === "playing" ? resolveRoomAudioPosition(room, nowMs) : room.audioState.startTime)
      );
      room.audioState = {
        status: "paused",
        startTime: pausedTime,
        serverTime: nowMs,
        updatedAt: nowMs,
        playbackRate: 1,
        updatedBy: uid,
      };
      room.lastAudioActionAt = nowMs;
      room.playbackStatus = "paused";
      room.baseTime = pausedTime;
      addRoomHistory(room, { type: "music_pause", uid, payload: { currentTime: pausedTime } });
      touchRoomActivity(roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "room_music_pause",
        payload: { currentTime: Number(pausedTime.toFixed(3)), sessionEngineId: "MusicEngine" },
      }).catch(() => {});
      broadcastRoomAudioSync(room, { action: "pause", triggeredBy: name });
      if (typeof ack === "function") ack({ ok: true, audioState: buildRoomMusicStatePayload(room).audioState });
      return;
    }
    const engine = resolveSessionEngine(room.sessionMode);
    if (!engine.allowPlayback) return;

    clearSyncWait(roomCode);
    // For video modes, pause simply turns the current resolved time into the
    // new baseTime so future heartbeats/seeks start from a stable point.
    const time = clampTime(currentTime ?? room.videoState.currentTime);
    const nowSec = Date.now() / 1000;
    room.videoState = {
      currentTime: time,
      isPlaying: false,
      playbackRate: room.videoState.playbackRate,
      lastUpdate: nowSec,
      scheduledStartAt: 0,
    };
    room.playbackStatus = "paused";
    room.baseTime = time;
    addRoomHistory(room, { type: "pause", uid, payload: { currentTime: time } });
    touchRoomActivity(roomCode).catch(() => {});
    logActivity({
      uid,
      roomCode,
      type: "room_pause",
      payload: { currentTime: Number(time.toFixed(2)), sessionEngineId: engine.id },
    }).catch(() => {});
    updateRoomPlaybackState(roomCode, {
      playbackStatus: "paused",
      baseTime: time,
    }).catch(() => {});

    io.to(roomCode).emit("sync_state", { videoState: room.videoState, triggeredBy: name, serverTime: Date.now() / 1000 });
    if (typeof ack === "function") ack({ ok: true });
  });

  /**
   * `request_seek`
   * Accepts `{ roomCode, currentTime, isPlaying, playbackRate, fileSignature }`,
   * clamps the requested time, optionally updates playing/paused state, and
   * broadcasts the new canonical playback position to the room.
   */
  socket.on("request_seek", ({ roomCode, currentTime, isPlaying, playbackRate, fileSignature } = {}, ack) => {
    if (shouldDropSocketEvent("request_seek")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
      return;
    }
    // Study mode: only the room creator (teacher) can
    // control playback. Drop the event silently if a
    // student tries to trigger it.
    if (
      room.sessionMode === "study" &&
      uid !== room.createdBy
    ) {
      return;
    }
    if (room.sessionMode === "music") {
      const validation = validateMusicControlRequest(room, fileSignature);
      if (!validation.ok) {
        socket.emit("error", { message: validation.error });
        if (typeof ack === "function") ack({ ok: false, error: validation.error });
        return;
      }
      if (!acquireAudioMutationLock(room)) {
        if (typeof ack === "function") ack({ ok: false, error: "Another playback change is already in progress" });
        return;
      }
      const nowMs = Date.now();
      // Music seek can also carry the desired playing/paused state so the host
      // can hard-sync everyone to one exact timestamp and status in one event.
      const time = clampTime(currentTime ?? resolveRoomAudioPosition(room, nowMs));
      const nextStatus = typeof isPlaying === "boolean" ? (isPlaying ? "playing" : "paused") : room.audioState.status;
      room.audioState = {
        status: nextStatus,
        startTime: time,
        serverTime: nextStatus === "playing" ? nowMs : nowMs,
        updatedAt: nowMs,
        playbackRate: (typeof playbackRate === "number" && playbackRate > 0 && playbackRate <= 4) ? playbackRate : 1,
        updatedBy: uid,
      };
      room.lastAudioActionAt = nowMs;
      room.playbackStatus = nextStatus;
      room.baseTime = time;
      room.startedAt = room.startedAt || new Date();
      addRoomHistory(room, {
        type: "music_seek",
        uid,
        payload: { currentTime: time, status: nextStatus },
      });
      touchRoomActivity(roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "room_music_seek",
        payload: { currentTime: Number(time.toFixed(3)), status: nextStatus, sessionEngineId: "MusicEngine" },
      }).catch(() => {});
      broadcastRoomAudioSync(room, {
        action: "seek",
        triggeredBy: name,
        hardSync: true,
      });
      if (typeof ack === "function") ack({ ok: true, audioState: buildRoomMusicStatePayload(room).audioState });
      return;
    }
    const engine = resolveSessionEngine(room.sessionMode);
    if (!engine.allowPlayback) return;

    clearSyncWait(roomCode);
    const time = clampTime(currentTime ?? room.videoState.currentTime);
    const rate = (typeof playbackRate === "number" && playbackRate > 0 && playbackRate <= 4)
      ? playbackRate
      : room.videoState.playbackRate;
    const nextIsPlaying = typeof isPlaying === "boolean" ? isPlaying : room.videoState.isPlaying;
    const nowSec = Date.now() / 1000;
    // YouTube-style sources may need a scheduled future start even after a seek,
    // so the recomputed state carries both the target time and a start marker.
    const scheduledStartAt = getScheduledVideoStartAt(room, nextIsPlaying, nowSec);

    room.videoState = {
      currentTime: time,
      isPlaying: nextIsPlaying,
      playbackRate: rate,
      lastUpdate: nowSec,
      scheduledStartAt,
    };
    room.playbackStatus = room.videoState.isPlaying ? "playing" : "paused";
    room.baseTime = time;
    room.startedAt = room.startedAt || new Date();
    addRoomHistory(room, {
      type: "seek",
      uid,
      payload: {
        currentTime: time,
        isPlaying: !!room.videoState.isPlaying,
        playbackRate: room.videoState.playbackRate,
        sessionEngineId: engine.id,
      },
    });
    touchRoomActivity(roomCode).catch(() => {});
    updateRoomPlaybackState(roomCode, {
      playbackStatus: room.videoState.isPlaying ? "playing" : "paused",
      baseTime: time,
      startedAt: room.startedAt,
    }).catch(() => {});

    io.to(roomCode).emit("sync_state", { videoState: room.videoState, triggeredBy: name, serverTime: Date.now() / 1000 });
    if (typeof ack === "function") ack({ ok: true });
  });

  /**
   * `bookmark_seek`
   * Accepts `{ roomCode, seekTime }`, records a bookmark-style session reaction,
   * moves the room to that timeline point, and broadcasts a hard sync update.
   */
  socket.on("bookmark_seek", ({ roomCode, seekTime } = {}) => {
    if (shouldDropSocketEvent("bookmark_seek")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    // Study mode: only the room creator (teacher) can
    // control playback. Drop the event silently if a
    // student tries to trigger it.
    if (
      room.sessionMode === "study" &&
      uid !== room.createdBy
    ) {
      return;
    }

    const time = clampTime(seekTime);
    // Bookmark seek is a user-friendly wrapper around hard sync: it records the
    // moment as a reaction and immediately moves the room timeline there.
    if (room.sessionMode === "music") {
      room.audioState = {
        status: room.audioState?.status === "playing" ? "playing" : "paused",
        startTime: time,
        serverTime: Date.now(),
        updatedAt: Date.now(),
        playbackRate: 1,
        updatedBy: uid,
      };
      room.lastAudioActionAt = Date.now();
      room.baseTime = time;
      addRoomHistory(room, { type: "bookmark_seek", uid, payload: { currentTime: time, mode: "music" } });
      touchRoomActivity(roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode,
        type: "bookmark_seek",
        payload: { currentTime: Number(time.toFixed(2)), mode: "music" },
      }).catch(() => {});
      recordSessionReaction({
        roomCode,
        userUid: uid,
        timestamp: time,
        reactionType: "bookmark",
        emoji: "bookmark",
      }).catch(() => {});

      broadcastRoomAudioSync(room, {
        action: "seek",
        triggeredBy: `${name}'s bookmark`,
        hardSync: true,
      });
      return;
    }

    // Video-mode bookmark seeks reuse the authoritative room timeline rather than client-local state.
    room.videoState = {
      ...room.videoState,
      currentTime: time,
      lastUpdate: Date.now() / 1000,
      scheduledStartAt: roomRuntime.getScheduledVideoStartAt(room, room.videoState.isPlaying, Date.now() / 1000),
    };
    room.baseTime = time;
    addRoomHistory(room, { type: "bookmark_seek", uid, payload: { currentTime: time } });
    touchRoomActivity(roomCode).catch(() => {});
    logActivity({
      uid,
      roomCode,
      type: "bookmark_seek",
      payload: { currentTime: Number(time.toFixed(2)) },
    }).catch(() => {});
    updateRoomPlaybackState(roomCode, {
      playbackStatus: room.videoState.isPlaying ? "playing" : "paused",
      baseTime: time,
    }).catch(() => {});
    recordSessionReaction({
      roomCode,
      userUid: uid,
      timestamp: time,
      reactionType: "bookmark",
      emoji: "bookmark",
    }).catch(() => {});

    io.to(roomCode).emit("sync_state", {
      videoState: room.videoState,
      triggeredBy: `${name}'s bookmark`,
      serverTime: Date.now() / 1000,
    });
  });

  /**
   * `video_metadata`
   * Accepts `{ roomCode, videoName, duration, sourceType, fileFingerprint, contentUrl }`,
   * normalizes the current source metadata, updates room content state, and
   * broadcasts the accepted source information to peers.
   */
  socket.on("video_metadata", ({ roomCode, videoName, duration, sourceType, fileFingerprint, contentUrl } = {}) => {
    if (shouldDropSocketEvent("video_metadata")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    // Study mode: only the room creator (teacher) can
    // control playback. Drop the event silently if a
    // student tries to trigger it.
    if (
      room.sessionMode === "study" &&
      uid !== room.createdBy
    ) {
      return;
    }
    if (room.sessionMode === "reading" && room.createdBy && room.createdBy !== uid) {
      socket.emit("error", { message: "Only the host can change the document in co-reading" });
      return;
    }

    const normalized = normalizeMetadataForSessionEngine(room.sessionMode, {
      videoName,
      duration,
      sourceType,
      fileFingerprint,
      contentUrl,
    });
    const metadata = {
      ...normalized,
      updatedBy: uid,
      updatedAt: Date.now(),
    };

    // Metadata changes update the room's current source-of-truth media identity;
    // later play/pause/seek events assume this source has already been agreed on.
    room.videoMetadata = metadata;
    room.contentType = metadata.sourceType;
    room.contentUrl = metadata.contentUrl;
    if (room.sessionMode === "music") {
      room.mediaType = resolveMusicMediaType(metadata.sourceType, metadata.contentUrl);
      room.mediaMeta = {
        fileSignature: String(metadata.fileFingerprint || ""),
        url: String(metadata.contentUrl || ""),
      };
      room.audioState = {
        status: "paused",
        startTime: 0,
        serverTime: Date.now(),
        updatedAt: Date.now(),
        playbackRate: 1,
        updatedBy: uid,
      };
    }
    if (room.sessionMode === "reading" && metadata.sourceType === "pdf" && metadata.contentUrl) {
      // In reading mode, selecting a PDF source also resets the room document
      // payload so page sync and source sync stay tightly coupled.
      room.document = {
        ...normalizeRoomDocumentPayload({
          fileUrl: metadata.contentUrl,
          fileName: metadata.videoName || deriveDocumentFileNameFromUrl(metadata.contentUrl) || "shared-document.pdf",
          fileSize: 0,
          mimeType: "application/pdf",
          totalPages: room.readingState?.totalPages || 0,
        }),
        uploadedBy: uid,
        updatedAt: Date.now(),
      };
      room.readingState = {
        page: 1,
        totalPages: room.readingState?.totalPages || 0,
        updatedAt: Date.now(),
        updatedBy: uid,
      };
    }
    addRoomHistory(room, {
      type: "video_metadata",
      uid,
      payload: {
        sessionEngineId: resolveSessionEngine(room.sessionMode).id,
        sourceType: metadata.sourceType,
        duration: metadata.duration,
        hasContentUrl: !!metadata.contentUrl,
      },
    });

    saveVideoSessionMetadata({
      roomCode,
      videoName: metadata.videoName,
      duration: metadata.duration,
      sourceType: metadata.sourceType,
      fileFingerprint: metadata.fileFingerprint,
      contentUrl: metadata.contentUrl,
      updatedBy: uid,
    }).catch(() => {});
    updateRoomContentState(roomCode, {
      contentUrl: metadata.contentUrl,
      contentType: metadata.sourceType,
    }).catch(() => {});

    touchRoomActivity(roomCode).catch(() => {});
    logActivity({
      uid,
      roomCode,
      type: "video_metadata_updated",
      payload: {
        sessionEngineId: resolveSessionEngine(room.sessionMode).id,
        sourceType: metadata.sourceType,
        duration: metadata.duration,
        hasContentUrl: !!metadata.contentUrl,
      },
    }).catch(() => {});

    socket.to(roomCode).emit("video_metadata_updated", {
      roomCode,
      metadata: {
        videoName: metadata.videoName,
        duration: metadata.duration,
        sourceType: metadata.sourceType,
        contentUrl: metadata.contentUrl,
        fileFingerprint: metadata.fileFingerprint,
      },
      updatedBy: uid,
    });
    if (room.sessionMode === "music") {
      broadcastRoomAudioSync(room, {
        action: "source_changed",
        triggeredBy: `${name} changed the track`,
        hardSync: true,
      });
    }
    if (room.sessionMode === "reading" && room.document?.fileUrl) {
      io.to(room.roomCode).emit("document_ready", {
        document: getRoomDocumentPayload(room),
        fileUrl: room.document.fileUrl,
        signature: room.document.signature,
        page: room.readingState?.page || 1,
        totalPages: room.readingState?.totalPages || 0,
        updatedBy: uid,
        username,
      });
      io.to(room.roomCode).emit("initial_state", buildReadingInitialStatePayload(room));
    }
  });

  /**
   * `time_update`
   * Accepts `{ roomCode, time, bufferAhead, readyState, isBuffering }`, ignores
   * any client-supplied username after the security fix, stores the caller's
   * heartbeat sample, emits a lightweight peer time update, and re-evaluates
   * the server-side sync-wait heuristic.
   */
  socket.on("time_update", ({ roomCode, username: _ignoredUsername, time, bufferAhead, readyState, isBuffering } = {}) => {
    if (shouldDropSocketEvent("time_update")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    const roomUser = room.users.get(uid);
    const safeUsername = roomUser?.username || roomUser?.name || username || name || 'friend';

    const rawBufferAhead = Number(bufferAhead);
    const rawReadyState = Number(readyState);
    // These per-user samples drive the server-side wait-mode heuristic that
    // pauses faster members when someone is buffering too far behind.
    room.memberTimes.set(uid, {
      username: safeUsername,
      time: clampTime(time),
      updatedAt: Date.now(),
      bufferAhead: Number.isFinite(rawBufferAhead) ? Math.max(0, Math.min(120, rawBufferAhead)) : null,
      readyState: Number.isFinite(rawReadyState) ? Math.max(0, Math.min(4, Math.floor(rawReadyState))) : null,
      isBuffering: isBuffering === true,
    });

    socket.to(roomCode).emit("member_time_update", {
      uid,
      username: safeUsername,
      time: clampTime(time),
    });

    handleSyncWait(roomCode);
  });
}

module.exports = { registerVideoSocketHandlers }
