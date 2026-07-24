/**
 * Shared helper functions for the 2-GATHER backend. This file groups reusable
 * helpers across several categories: time clamping, document utilities, room
 * state serialization, collection utilities, and safe in-memory object copying.
 */

"use strict";

const {
  MAX_VIDEO_TIME, MAX_ROOM_HISTORY_ITEMS,
  READING_PAGE_MAX,
} = require("../config/constants.js");
// Session-engine lookup lives in normalize.js, but callers still import it
// from helpers as part of the older shared-helper surface area.
const {
  normalizeDocumentMimeType,
  normalizeReadingTotalPages,
  resolveSessionEngine,
} = require("./normalize.js");
const {
  sanitizeUploadFileName,
  sanitizeActivityPayload,
} = require("./sanitize.js");

/**
 * Checks whether a hostname points at a private LAN address.
 * @param {string} hostname - Parsed hostname from an Origin or URL.
 * @returns {boolean} True when the host is in a private IPv4 LAN range.
 */
function isPrivateLanHost(hostname) {
  return /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
}

/**
 * Derives a display file name from a document URL when none was provided.
 * @param {string} fileUrl - Shareable document URL.
 * @returns {string} A sanitized file name or an empty string on parse failure.
 */
function deriveDocumentFileNameFromUrl(fileUrl) {
  try {
    // The final path segment is the best lightweight guess for a human-friendly name.
    const parsed = new URL(String(fileUrl || ""));
    const pathname = parsed.pathname || "";
    const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
    return sanitizeUploadFileName(decodeURIComponent(lastSegment || ""));
  } catch {
    return "";
  }
}

/**
 * Builds a lightweight document signature from a normalized name and size.
 * @param {string} fileName - Human-readable file name.
 * @param {number|string} fileSize - File size in bytes.
 * @returns {string} A stable `name:size` signature used for deduplication.
 */
function buildDocumentSignature(fileName, fileSize) {
  const normalizedName = sanitizeUploadFileName(fileName);
  const normalizedSize = Math.max(0, Math.floor(Number(fileSize) || 0));
  return `${normalizedName}:${normalizedSize}`;
}

/**
 * Clamps a reading page number into the valid range for the document.
 * @param {number|string} value - Requested current page.
 * @param {number|string} totalPages - Total page count for the document.
 * @returns {number} A page number between 1 and the allowed maximum.
 */
function clampReadingPage(value, totalPages = 0) {
  const page = Math.floor(Number(value) || 1);
  const maxPage = normalizeReadingTotalPages(totalPages) || READING_PAGE_MAX;
  return Math.max(1, Math.min(maxPage, page));
}

/**
 * Serializes room-document state into a safe canonical payload.
 * @param {object} document - Raw room document state.
 * @returns {object|null} Serialized room document metadata or null when missing.
 */
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

/**
 * Serializes reading-mode state into a bounded payload for sockets and storage.
 * @param {object} readingState - Raw reading-state object.
 * @param {object|null} roomDocument - Optional room document used for fallback pages.
 * @returns {object} A normalized reading-state payload with bounded page info.
 */
function serializeReadingState(readingState = {}, roomDocument = null) {
  const totalPages = normalizeReadingTotalPages(readingState.totalPages || roomDocument?.totalPages || 0);
  return {
    page: clampReadingPage(readingState.page, totalPages),
    totalPages,
    updatedAt: Math.max(0, Number(readingState.updatedAt) || Date.now()),
    updatedBy: String(readingState.updatedBy || ""),
  };
}

/**
 * Creates a unique identifier for temporary uploaded documents.
 * @returns {string} A timestamp-plus-random upload id.
 */
function createDocumentUploadId() {
  // Combining a time component with random fragments keeps ids sortable by
  // creation time while still making collisions very unlikely.
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Clamps playback time into the supported shared-media range.
 * @param {number} value - Candidate playback position in seconds.
 * @returns {number} A value between 0 and MAX_VIDEO_TIME.
 */
function clampTime(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, MAX_VIDEO_TIME));
}

/**
 * Returns the unique non-empty strings from an array-like input.
 * @param {any[]} list - Candidate list of string values.
 * @returns {string[]} De-duplicated trimmed strings in encounter order.
 */
function uniqueStrings(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((item) => typeof item === "string" && item.trim()))];
}

/**
 * Creates a deep JSON copy of a profile-like object from the memory store.
 * @param {object} profile - Source object from the in-memory store.
 * @returns {object} A detached deep copy safe to mutate elsewhere.
 */
function getProfileStoreCopy(profile) {
  // The memory store must not leak live references to callers.
  return JSON.parse(JSON.stringify(profile));
}

/**
 * Pushes an item into an array while enforcing a maximum item count.
 * @param {any[]} list - Mutable target array.
 * @param {any} item - Item to append.
 * @param {number} maxItems - Maximum allowed array length.
 * @returns {void} This helper mutates the provided list in place.
 */
function pushBounded(list, item, maxItems) {
  list.push(item);
  if (list.length > maxItems) {
    list.splice(0, list.length - maxItems);
  }
}

/**
 * Appends a bounded history entry onto a live room object.
 * @param {object} room - Live room object that owns the history array.
 * @param {object} entry - Activity entry to append.
 * @returns {void} This helper mutates room.history in place.
 */
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

/**
 * Resolves the current effective video state from the last synced room state.
 * @param {object} videoState - Persisted live video state for the room.
 * @returns {object} Playback state with computed currentTime and timestamps.
 */
function resolveVideoState(videoState) {
  const now = Date.now() / 1000;
  const rate = (typeof videoState?.playbackRate === "number" && videoState.playbackRate > 0 && videoState.playbackRate <= 4)
    ? videoState.playbackRate
    : 1;
  const baseTime = clampTime(typeof videoState?.currentTime === "number" ? videoState.currentTime : 0);
  const lastUpdate = Number(videoState?.lastUpdate);
  const scheduledStartAt = Number(videoState?.scheduledStartAt);
  // When playback is scheduled for the future, use the later of the last sync
  // marker and the scheduled start so elapsed time is not double-counted.
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
    scheduledStartAt: Number.isFinite(scheduledStartAt) && scheduledStartAt > now ? scheduledStartAt : 0, // Past schedule markers are cleared so clients only see genuinely upcoming starts.
  };
}

module.exports = {
  isPrivateLanHost,
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
