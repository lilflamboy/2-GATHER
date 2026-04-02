"use strict";

const {
  MAX_VIDEO_TIME, MAX_ROOM_HISTORY_ITEMS,
  READING_PAGE_MAX,
} = require("../config/constants.js");
const {
  normalizeDocumentMimeType,
  normalizeReadingTotalPages,
  resolveSessionEngine,
} = require("./normalize.js");
const {
  sanitizeUploadFileName,
  sanitizeActivityPayload,
} = require("./sanitize.js");

function deriveDocumentFileNameFromUrl(fileUrl) {
  try {
    const parsed = new URL(String(fileUrl || ""));
    const pathname = parsed.pathname || "";
    const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
    return sanitizeUploadFileName(decodeURIComponent(lastSegment || ""));
  } catch {
    return "";
  }
}

function buildDocumentSignature(fileName, fileSize) {
  const normalizedName = sanitizeUploadFileName(fileName);
  const normalizedSize = Math.max(0, Math.floor(Number(fileSize) || 0));
  return `${normalizedName}:${normalizedSize}`;
}

function clampReadingPage(value, totalPages = 0) {
  const page = Math.floor(Number(value) || 1);
  const maxPage = normalizeReadingTotalPages(totalPages) || READING_PAGE_MAX;
  return Math.max(1, Math.min(maxPage, page));
}

function serializeRoomDocument(document) {
  if (!document?.fileUrl) return null;
  return {
    fileUrl: String(document.fileUrl || ""),
    fileName: sanitizeUploadFileName(document.fileName || ""),
    fileSize: Math.max(0, Math.floor(Number(document.fileSize) || 0)),
    mimeType: normalizeDocumentMimeType(document.mimeType || "application/pdf", document.fileName || ""),
    signature: String(document.signature || buildDocumentSignature(document.fileName, document.fileSize)),
    totalPages: normalizeReadingTotalPages(document.totalPages),
    uploadedBy: String(document.uploadedBy || ""),
    updatedAt: Math.max(0, Number(document.updatedAt) || Date.now()),
  };
}

function serializeReadingState(readingState = {}, roomDocument = null) {
  const totalPages = normalizeReadingTotalPages(readingState.totalPages || roomDocument?.totalPages || 0);
  return {
    page: clampReadingPage(readingState.page, totalPages),
    totalPages,
    updatedAt: Math.max(0, Number(readingState.updatedAt) || Date.now()),
    updatedBy: String(readingState.updatedBy || ""),
  };
}

function createDocumentUploadId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 10)}`;
}

function clampTime(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, MAX_VIDEO_TIME));
}

function uniqueStrings(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((item) => typeof item === "string" && item.trim()))];
}

function getProfileStoreCopy(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function pushBounded(list, item, maxItems) {
  list.push(item);
  if (list.length > maxItems) {
    list.splice(0, list.length - maxItems);
  }
}

function addRoomHistory(room, entry) {
  if (!room || !entry) return;
  pushBounded(
    room.history,
    {
      type: String(entry.type || "event"),
      uid: String(entry.uid || ""),
      roomCode: String(room.roomCode || ""),
      payload: sanitizeActivityPayload(entry.payload || {}),
      timestamp: Date.now(),
    },
    MAX_ROOM_HISTORY_ITEMS
  );
}

function resolveVideoState(videoState) {
  const now = Date.now() / 1000;
  const rate = (typeof videoState?.playbackRate === "number" && videoState.playbackRate > 0 && videoState.playbackRate <= 4)
    ? videoState.playbackRate
    : 1;
  const baseTime = clampTime(typeof videoState?.currentTime === "number" ? videoState.currentTime : 0);
  const lastUpdate = Number(videoState?.lastUpdate);
  const scheduledStartAt = Number(videoState?.scheduledStartAt);
  const effectiveStartAt = videoState?.isPlaying
    ? (
      Number.isFinite(scheduledStartAt) && scheduledStartAt > 0
        ? Math.max(Number.isFinite(lastUpdate) ? lastUpdate : 0, scheduledStartAt)
        : lastUpdate
    )
    : lastUpdate;
  const elapsed = videoState?.isPlaying && Number.isFinite(effectiveStartAt) ? Math.max(0, now - effectiveStartAt) : 0;
  const currentTime = clampTime(baseTime + elapsed * rate);
  return {
    currentTime,
    isPlaying: !!videoState?.isPlaying,
    playbackRate: rate,
    lastUpdate: now,
    scheduledStartAt: Number.isFinite(scheduledStartAt) && scheduledStartAt > now ? scheduledStartAt : 0,
  };
}

module.exports = {
  clampTime,
  clampReadingPage,
  uniqueStrings,
  buildDocumentSignature,
  deriveDocumentFileNameFromUrl,
  createDocumentUploadId,
  serializeRoomDocument,
  serializeReadingState,
  resolveSessionEngine,
  resolveVideoState,
  addRoomHistory,
  getProfileStoreCopy,
  pushBounded,
};
