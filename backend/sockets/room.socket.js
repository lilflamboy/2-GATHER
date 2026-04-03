'use strict'

function registerRoomSocketHandlers({
  io,
  socket,
  context,
  roomRuntime,
  roomService,
}) {
  const {
    uid, name, username, photoURL,
    shouldDropSocketEvent,
  } = context
  const {
    rooms,
    MAX_ROOM_USERS,
    READING_PAGE_LOCK_MS,
    generateCode,
    normalizeRoomType,
    normalizeSessionMode,
    normalizeMetadataForSessionEngine,
    sanitizeRoomMoodTag,
    makeRoom,
    scheduleExpiry,
    upsertRoomUser,
    addRoomHistory,
    getUserList,
    getRoomReadingStatePayload,
    getRoomDocumentPayload,
    buildReadingInitialStatePayload,
    clearPendingRoomUserDisconnect,
    resolveSessionEngine,
    normalizeRoomDocumentPayload,
    normalizeReadingTotalPages,
    clampReadingPage,
  } = roomRuntime
  const {
    upsertRoomMetadata,
    upsertRoomParticipant,
    touchRoomActivity,
    logActivity,
    updateRoomContentState,
    saveVideoSessionMetadata,
  } = roomService

  socket.on("create_room", async ({ roomType, sessionMode, maxParticipants, moodTag, contentUrl, contentType } = {}, ack) => {
    if (shouldDropSocketEvent("create_room")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    try {
      const roomCode = generateCode();
      const normalizedRoomType = normalizeRoomType(roomType);
      const normalizedSessionMode = normalizeSessionMode(sessionMode);
      // Normalize source metadata once up front so room creation and later sync
      // logic agree on the exact media/session mode values.
      const normalizedInitialMetadata = normalizeMetadataForSessionEngine(normalizedSessionMode, {
        sourceType: contentType || "unknown",
        contentUrl: contentUrl || "",
      });
      const normalizedMaxParticipants = Math.max(
        2,
        Math.min(10, Number(maxParticipants) || (normalizedRoomType === "duo" ? 2 : MAX_ROOM_USERS))
      );
      const room = makeRoom(roomCode, {
        roomType: normalizedRoomType,
        sessionMode: normalizedSessionMode,
        moodTag: sanitizeRoomMoodTag(moodTag || ""),
        createdBy: uid,
        maxParticipants: normalizedMaxParticipants,
        contentUrl: normalizedInitialMetadata.contentUrl,
        contentType: normalizedInitialMetadata.sourceType,
      });
      if (room.contentUrl) {
        room.videoMetadata = {
          videoName: "",
          duration: 0,
          sourceType: room.contentType,
          fileFingerprint: "",
          contentUrl: room.contentUrl,
          updatedBy: uid,
          updatedAt: Date.now(),
        };
      }
      scheduleExpiry(room);

      upsertRoomUser(room, { uid, name, username, photoURL }, socket.id);
      room.joinedAtByUid.set(uid, Date.now());
      rooms.set(roomCode, room);
      addRoomHistory(room, {
        type: "room_created",
        uid,
        payload: {
          roomType: room.roomType,
          sessionMode: room.sessionMode,
          sessionEngineId: room.sessionEngineId,
          moodTag: room.moodTag || "",
          hasContentUrl: !!room.contentUrl,
          contentType: room.contentType,
        },
      });

      socket.join(roomCode);
      socket.currentRoom = roomCode;

      // Persistence is best-effort here: the live room should still exist even
      // if one analytics/history write fails.
      await Promise.allSettled([
        upsertRoomMetadata({
          roomCode,
          roomType: room.roomType,
          sessionMode: room.sessionMode,
          moodTag: room.moodTag || "",
          createdBy: uid,
          maxParticipants: room.maxParticipants,
          isActive: true,
          expiresAt: room.expiresAt,
          contentUrl: room.contentUrl,
          contentType: room.contentType,
          playbackStatus: room.playbackStatus,
          baseTime: room.baseTime,
          startedAt: room.startedAt,
        }),
        upsertRoomParticipant(roomCode, uid, {
          joinedAt: new Date(),
          isActive: true,
          role: "member",
        }),
        logActivity({
          uid,
          roomCode,
          type: "room_created",
          payload: {
            roomType: room.roomType,
            sessionMode: room.sessionMode,
            sessionEngineId: room.sessionEngineId,
            moodTag: room.moodTag || "",
            maxParticipants: room.maxParticipants,
            hasContentUrl: !!room.contentUrl,
            contentType: room.contentType,
          },
        }),
      ]);

      const musicState = roomRuntime.buildRoomMusicStatePayload(room);
      socket.emit("room_joined", {
        roomCode,
        userCount: 1,
        users: getUserList(room),
        videoState: room.videoState,
        audioState: musicState.audioState,
        mediaType: musicState.mediaType,
        mediaMeta: musicState.mediaMeta,
        readingPage: room.readingState?.page || 1,
        readingState: getRoomReadingStatePayload(room),
        document: getRoomDocumentPayload(room),
        roomType: room.roomType,
        sessionMode: room.sessionMode,
        sessionEngineId: room.sessionEngineId,
        moodTag: room.moodTag || "",
        maxParticipants: room.maxParticipants,
        videoMetadata: room.videoMetadata,
        contentUrl: room.contentUrl || "",
        contentType: room.contentType || "unknown",
        createdBy: room.createdBy || "",
        messages: [],
      });
      socket.emit("initial_state", buildReadingInitialStatePayload(room));
      if (typeof ack === "function") ack({ ok: true, roomCode });

      io.to(roomCode).emit("user_count_update", { count: 1, users: getUserList(room) });
      roomService.log(`[create_room] ${roomCode} uid=${uid}`);
    } catch (err) {
      roomService.error("[create_room]", err);
      socket.emit("error", { message: "Failed to create room" });
      if (typeof ack === "function") ack({ ok: false, error: "Failed to create room" });
    }
  });

  socket.on("join_room", ({ roomCode } = {}, ack) => {
    if (shouldDropSocketEvent("join_room")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }
    try {
      if (typeof roomCode !== "string") {
        socket.emit("error", { message: "Invalid room code" });
        if (typeof ack === "function") ack({ ok: false, error: "Invalid room code" });
        return;
      }

      const code = roomCode.trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        socket.emit("error", { message: "Room not found or expired" });
        if (typeof ack === "function") ack({ ok: false, error: "Room not found or expired" });
        return;
      }
      if (room.users.size >= room.maxParticipants && !room.users.has(uid)) {
        socket.emit("error", { message: `Room is full (max ${room.maxParticipants})` });
        if (typeof ack === "function") ack({ ok: false, error: `Room is full (max ${room.maxParticipants})` });
        return;
      }

      clearPendingRoomUserDisconnect(code, uid);
      const joinState = upsertRoomUser(room, { uid, name, username, photoURL }, socket.id);
      const { isRejoin, hadActiveSocketsBefore } = joinState;
      if (!room.joinedAtByUid.has(uid)) {
        room.joinedAtByUid.set(uid, Date.now());
      }

      socket.join(code);
      socket.currentRoom = code;

      const musicState = roomRuntime.buildRoomMusicStatePayload(room);
      socket.emit("room_joined", {
        roomCode: code,
        userCount: room.users.size,
        users: getUserList(room),
        videoState: { ...room.videoState },
        audioState: musicState.audioState,
        mediaType: musicState.mediaType,
        mediaMeta: musicState.mediaMeta,
        readingPage: room.readingState?.page || 1,
        readingState: getRoomReadingStatePayload(room),
        document: getRoomDocumentPayload(room),
        messages: room.messages.slice(-100),
        roomType: room.roomType,
        sessionMode: room.sessionMode || "watch",
        sessionEngineId: room.sessionEngineId || resolveSessionEngine(room.sessionMode).id,
        moodTag: room.moodTag || "",
        maxParticipants: room.maxParticipants,
        videoMetadata: room.videoMetadata || null,
        contentUrl: room.contentUrl || "",
        contentType: room.contentType || "unknown",
        createdBy: room.createdBy || "",
        isRejoin,
      });
      socket.emit("initial_state", buildReadingInitialStatePayload(room));
      if (typeof ack === "function") ack({ ok: true, roomCode: code });

      if (!isRejoin) {
        socket.to(code).emit("user_joined", { uid, name, username, photoURL });
        addRoomHistory(room, { type: "user_joined", uid, payload: { username } });
      } else if (!hadActiveSocketsBefore) {
        socket.to(code).emit("user_joined", { uid, name, username, photoURL });
        addRoomHistory(room, { type: "user_rejoined", uid, payload: { username } });
      } else {
        addRoomHistory(room, { type: "user_rejoined", uid, payload: { username } });
      }

      // Rejoins update presence immediately and backfill persistence in the
      // background so reconnects feel instant to the user.
      Promise.allSettled([
        upsertRoomParticipant(code, uid, {
          joinedAt: new Date(),
          isActive: true,
          role: "member",
          leftAt: null,
        }),
        touchRoomActivity(code),
        logActivity({
          uid,
          roomCode: code,
          type: isRejoin ? "room_rejoined" : "room_joined",
          payload: {
            roomType: room.roomType,
            sessionMode: room.sessionMode || "watch",
            sessionEngineId: room.sessionEngineId || resolveSessionEngine(room.sessionMode).id,
            moodTag: room.moodTag || "",
            hasContentUrl: !!room.contentUrl,
            contentType: room.contentType || "unknown",
          },
        }),
      ]).catch(() => {});

      io.to(code).emit("user_count_update", {
        count: room.users.size,
        users: getUserList(room),
      });

      roomService.log(`[join_room] ${code} uid=${uid} rejoin=${isRejoin}`);
    } catch (err) {
      roomService.error("[join_room]", err);
      socket.emit("error", { message: "Failed to join room" });
      if (typeof ack === "function") ack({ ok: false, error: "Failed to join room" });
    }
  });

  socket.on("upload_document", ({ roomCode, fileUrl, fileName, fileSize, mimeType, totalPages } = {}, ack) => {
    if (shouldDropSocketEvent("upload_document")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }

    try {
      const room = rooms.get(String(roomCode || "").trim().toUpperCase());
      if (!room || !room.users.has(uid)) {
        if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
        return;
      }
      if (room.sessionMode !== "reading") {
        if (typeof ack === "function") ack({ ok: false, error: "Document sync is only available in co-reading rooms" });
        return;
      }
      if (room.createdBy && room.createdBy !== uid) {
        if (typeof ack === "function") ack({ ok: false, error: "Only the host can upload a PDF" });
        return;
      }

      const document = normalizeRoomDocumentPayload({
        fileUrl,
        fileName,
        fileSize,
        mimeType,
        totalPages,
      });

      // In reading rooms the host's uploaded document becomes the canonical
      // room source, so page state and metadata are reset together here.
      room.document = {
        ...document,
        uploadedBy: uid,
        updatedAt: Date.now(),
      };
      room.readingState = {
        page: 1,
        totalPages: document.totalPages,
        updatedAt: Date.now(),
        updatedBy: uid,
      };
      room.readingMutationLockUntil = 0;
      room.contentUrl = document.fileUrl;
      room.contentType = "pdf";
      room.videoMetadata = {
        videoName: document.fileName,
        duration: 0,
        sourceType: "pdf",
        fileFingerprint: document.signature,
        contentUrl: document.fileUrl,
        updatedBy: uid,
        updatedAt: Date.now(),
      };

      addRoomHistory(room, {
        type: "document_uploaded",
        uid,
        payload: {
          fileName: document.fileName,
          fileSize: document.fileSize,
          signature: document.signature,
          totalPages: document.totalPages,
        },
      });

      touchRoomActivity(room.roomCode).catch(() => {});
      updateRoomContentState(room.roomCode, {
        contentUrl: document.fileUrl,
        contentType: "pdf",
      }).catch(() => {});
      saveVideoSessionMetadata({
        roomCode: room.roomCode,
        videoName: document.fileName,
        duration: 0,
        sourceType: "pdf",
        fileFingerprint: document.signature,
        contentUrl: document.fileUrl,
        updatedBy: uid,
      }).catch(() => {});
      logActivity({
        uid,
        roomCode: room.roomCode,
        type: "document_uploaded",
        payload: {
          fileName: document.fileName,
          fileSize: document.fileSize,
          signature: document.signature,
          totalPages: document.totalPages,
        },
      }).catch(() => {});

      const readingState = getRoomReadingStatePayload(room);
      const documentPayload = getRoomDocumentPayload(room);
      io.to(room.roomCode).emit("document_ready", {
        document: documentPayload,
        fileUrl: documentPayload?.fileUrl || "",
        signature: documentPayload?.signature || "",
        page: readingState.page,
        totalPages: readingState.totalPages,
        updatedBy: uid,
        username,
      });
      io.to(room.roomCode).emit("sync_page", {
        page: readingState.page,
        totalPages: readingState.totalPages,
        updatedBy: uid,
        username,
        serverTime: Date.now(),
      });
      io.to(room.roomCode).emit("initial_state", buildReadingInitialStatePayload(room));

      if (typeof ack === "function") {
        ack({
          ok: true,
          document: documentPayload,
          readingState,
        });
      }
    } catch (error) {
      if (typeof ack === "function") ack({ ok: false, error: error.message || "Could not share the PDF" });
    }
  });

  socket.on("sync_state", ({ roomCode, readingState, document } = {}, ack) => {
    if (shouldDropSocketEvent("sync_state_write")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }

    const room = rooms.get(String(roomCode || "").trim().toUpperCase());
    if (!room || !room.users.has(uid) || room.sessionMode !== "reading" || !room.document?.fileUrl) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not ready for co-reading sync" });
      return;
    }
    if (room.createdBy && room.createdBy !== uid) {
      if (typeof ack === "function") ack({ ok: false, error: "Only the host can sync PDF state" });
      return;
    }

    const incomingSignature = String(document?.signature || readingState?.signature || "").trim();
    if (incomingSignature && incomingSignature !== room.document.signature) {
      if (typeof ack === "function") ack({ ok: false, error: "Document mismatch" });
      return;
    }

    let changed = false;
    const nextTotalPages = normalizeReadingTotalPages(readingState?.totalPages || document?.totalPages || 0);
    if (nextTotalPages > 0 && nextTotalPages !== normalizeReadingTotalPages(room.readingState?.totalPages || 0)) {
      room.readingState.totalPages = nextTotalPages;
      room.document.totalPages = nextTotalPages;
      changed = true;
    }

    if (readingState?.page != null) {
      const nextPage = clampReadingPage(readingState.page, room.readingState.totalPages || room.document.totalPages || 0);
      if (nextPage !== clampReadingPage(room.readingState.page, room.readingState.totalPages || room.document.totalPages || 0)) {
        room.readingState.page = nextPage;
        room.readingState.updatedAt = Date.now();
        room.readingState.updatedBy = uid;
        changed = true;
      }
    }

    if (changed) {
      const payload = buildReadingInitialStatePayload(room);
      io.to(room.roomCode).emit("initial_state", payload);
    }

    if (typeof ack === "function") {
      ack({
        ok: true,
        changed,
        readingState: getRoomReadingStatePayload(room),
        document: getRoomDocumentPayload(room),
      });
    }
  });

  socket.on("request_page_change", ({ roomCode, page } = {}, ack) => {
    if (shouldDropSocketEvent("request_page_change")) {
      if (typeof ack === "function") ack({ ok: false, error: "Too many requests. Please try again." });
      return;
    }

    const room = rooms.get(String(roomCode || "").trim().toUpperCase());
    if (!room || !room.users.has(uid)) {
      if (typeof ack === "function") ack({ ok: false, error: "Room not found" });
      return;
    }
    if (room.sessionMode !== "reading") {
      if (typeof ack === "function") ack({ ok: false, error: "Page sync is only available in co-reading rooms" });
      return;
    }
    if (room.createdBy && room.createdBy !== uid) {
      if (typeof ack === "function") ack({ ok: false, error: "Only the host can change pages" });
      return;
    }
    if (!room.document?.fileUrl) {
      if (typeof ack === "function") ack({ ok: false, error: "Upload a PDF before changing pages" });
      return;
    }

    const now = Date.now();
    // Rapid repeated page flips are collapsed by a tiny mutation window so all
    // clients observe one coherent page change at a time.
    if (room.readingMutationLockUntil && now < room.readingMutationLockUntil) {
      if (typeof ack === "function") ack({ ok: false, error: "Page changes are happening too quickly" });
      return;
    }

    const nextPage = clampReadingPage(page, room.readingState.totalPages || room.document.totalPages || 0);
    const currentPage = clampReadingPage(room.readingState.page, room.readingState.totalPages || room.document.totalPages || 0);
    room.readingMutationLockUntil = now + READING_PAGE_LOCK_MS;

    if (nextPage !== currentPage) {
      room.readingState = {
        page: nextPage,
        totalPages: normalizeReadingTotalPages(room.readingState.totalPages || room.document.totalPages || 0),
        updatedAt: now,
        updatedBy: uid,
      };

      addRoomHistory(room, {
        type: "reading_page",
        uid,
        payload: { page: nextPage, totalPages: room.readingState.totalPages || 0 },
      });
      touchRoomActivity(room.roomCode).catch(() => {});
      logActivity({
        uid,
        roomCode: room.roomCode,
        type: "reading_page_changed",
        payload: { page: nextPage, totalPages: room.readingState.totalPages || 0 },
      }).catch(() => {});

      io.to(room.roomCode).emit("sync_page", {
        page: nextPage,
        totalPages: room.readingState.totalPages || 0,
        updatedBy: uid,
        username,
        serverTime: now,
      });
      io.to(room.roomCode).emit("reading_page_update", {
        page: nextPage,
        totalPages: room.readingState.totalPages || 0,
        updatedBy: uid,
        username,
      });
    }

    if (typeof ack === "function") {
      ack({
        ok: true,
        page: nextPage,
        totalPages: room.readingState.totalPages || 0,
      });
    }
  });

  socket.on("reading_page_update", ({ roomCode, page } = {}) => {
    if (shouldDropSocketEvent("reading_page_update")) return;
    const room = rooms.get(roomCode);
    if (!room || !room.users.has(uid)) return;
    if (room.sessionMode !== "reading") return;
    if (room.createdBy && room.createdBy !== uid) {
      socket.emit("error", { message: "Only the host can change pages in co-reading" });
      return;
    }
    if (!room.document?.fileUrl) {
      socket.emit("error", { message: "Upload a PDF before changing pages" });
      return;
    }

    const now = Date.now();
    if (room.readingMutationLockUntil && now < room.readingMutationLockUntil) return;

    const nextPage = clampReadingPage(page, room.readingState.totalPages || room.document.totalPages || 0);
    const currentPage = clampReadingPage(room.readingState.page, room.readingState.totalPages || room.document.totalPages || 0);
    if (nextPage === currentPage) return;

    // This fire-and-forget event mirrors the ack-based page-change endpoint so
    // viewers still converge even if the host updates page state from the UI directly.
    room.readingMutationLockUntil = now + READING_PAGE_LOCK_MS;
    room.readingState = {
      page: nextPage,
      totalPages: normalizeReadingTotalPages(room.readingState.totalPages || room.document.totalPages || 0),
      updatedAt: now,
      updatedBy: uid,
    };
    addRoomHistory(room, {
      type: "reading_page",
      uid,
      payload: { page: nextPage, totalPages: room.readingState.totalPages || 0 },
    });
    touchRoomActivity(roomCode).catch(() => {});

    io.to(roomCode).emit("sync_page", {
      page: nextPage,
      totalPages: room.readingState.totalPages || 0,
      updatedBy: uid,
      username,
      serverTime: now,
    });
    io.to(roomCode).emit("reading_page_update", {
      page: nextPage,
      totalPages: room.readingState.totalPages || 0,
      updatedBy: uid,
      username,
    });
  });
}

module.exports = { registerRoomSocketHandlers }
