/**
 * Normalization helpers for 2-GATHER backend inputs. Sanitization removes
 * dangerous content, while normalization coerces values into the application's
 * expected shape: lowercasing identifiers, selecting valid enum members,
 * clamping numeric ranges, and building canonical payload structures.
 */

"use strict";

const {
  ALLOWED_SESSION_MODES, ALLOWED_CONTENT_TYPES,
  READING_PAGE_MAX, MAX_VIDEO_NAME_LENGTH,
  MAX_DOCUMENT_UPLOAD_BYTES,
  MAX_VIDEO_TIME, SESSION_ENGINE_REGISTRY,
} = require("../config/constants.js");
const {
  sanitize, sanitizeContentUrl,
  sanitizeUploadFileName,
} = require("./sanitize.js");

/**
 * Normalizes usernames into the canonical lowercase backend format.
 * @param {string} value - Raw username candidate from a client.
 * @returns {string} Lowercased username text containing only allowed chars.
 */
function normalizeUsername(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
}

/**
 * Normalizes total page counts for reading mode into the supported range.
 * @param {number|string} value - Raw page count from a client or parser.
 * @returns {number} A value from 0 to READING_PAGE_MAX, with invalid input as 0.
 */
function normalizeReadingTotalPages(value) {
  const totalPages = Math.floor(Number(value) || 0);
  if (!Number.isFinite(totalPages) || totalPages <= 0) return 0;
  return Math.max(1, Math.min(READING_PAGE_MAX, totalPages));
}

/**
 * Validates and normalizes uploaded-document MIME types.
 * @param {string} value - Raw MIME type reported by the client.
 * @param {string} fileName - File name used as an extension fallback.
 * @returns {string} A supported normalized MIME type or an empty string.
 */
function normalizeDocumentMimeType(value, fileName = "") {
  const raw = String(value || "").trim().toLowerCase();
  // Prefer explicit supported MIME types first.
  if (raw === "application/pdf") return "application/pdf";
  if (raw === "text/plain") return "text/plain";
  if (raw === "application/msword") return "application/msword";
  if (raw === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  // Fall back to the file extension when clients omit or misreport MIME types.
  if (String(fileName || "").toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (String(fileName || "").toLowerCase().endsWith(".txt")) return "text/plain";
  if (String(fileName || "").toLowerCase().endsWith(".doc")) return "application/msword";
  if (String(fileName || "").toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "";
}

/**
 * Normalizes room type values into the supported enum.
 * @param {string} roomType - Raw room type from a client or persisted row.
 * @returns {string} One of the allowed room types, defaulting to friends.
 */
function normalizeRoomType(roomType) {
  const value = String(roomType || "").trim().toLowerCase();
  if (value === "duo" || value === "family" || value === "friends") return value;
  return "friends";
}

/**
 * Normalizes session mode values into the supported mode enum.
 * @param {string} mode - Raw session mode value from a client or room record.
 * @returns {string} A supported session mode, defaulting to watch.
 */
function normalizeSessionMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  if (ALLOWED_SESSION_MODES.includes(value)) return value;
  return "watch";
}

/**
 * Resolves the session engine config for a normalized session mode.
 * @param {string} mode - Requested session mode.
 * @returns {object} The matching engine registry entry, or the watch engine.
 */
function resolveSessionEngine(mode) {
  const normalized = normalizeSessionMode(mode);
  return SESSION_ENGINE_REGISTRY[normalized] || SESSION_ENGINE_REGISTRY.watch;
}

/**
 * Normalizes content-source labels into the backend's known content types.
 * @param {string} value - Raw content type or provider hint.
 * @returns {string} A canonical content type string or unknown.
 */
function normalizeContentType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (ALLOWED_CONTENT_TYPES.includes(raw)) return raw;
  if (raw === "doc" || raw === "docs" || raw === "document") return "document";
  if (raw === "pdf") return "pdf";
  if (raw === "amazon" || raw === "primevideo" || raw === "prime_video") return "prime";
  if (raw === "disneyplus" || raw === "disney_plus" || raw === "hotstar") return "disney";
  if (raw === "youtube.com" || raw === "youtu.be") return "youtube";
  if (raw === "prime" || raw === "netflix" || raw === "youtube" || raw === "local" || raw === "ott") return raw;
  return "unknown";
}

/**
 * Normalizes session-engine metadata into a safe canonical payload.
 * @param {string} sessionMode - Active room session mode.
 * @param {object} metadata - Raw metadata supplied by the client or socket.
 * @returns {object} Sanitized metadata that matches the chosen session engine.
 */
function normalizeMetadataForSessionEngine(sessionMode, metadata = {}) {
  // Resolve the engine first so content validation can respect the active
  // mode's capabilities instead of using one global rule.
  const engine = resolveSessionEngine(sessionMode);
  const sanitizedUrl = sanitizeContentUrl(metadata.contentUrl || "");
  const normalizedSourceType = normalizeContentType(metadata.sourceType || "unknown");
  const sourceType = engine.allowedContentTypes.has(normalizedSourceType) ? normalizedSourceType : "unknown"; // Unsupported source types degrade to unknown instead of leaking invalid provider labels into the engine layer.
  return {
    videoName: sanitize(String(metadata.videoName || "")).slice(0, MAX_VIDEO_NAME_LENGTH),
    duration: Math.max(0, Math.min(MAX_VIDEO_TIME, Number(metadata.duration) || 0)),
    sourceType,
    fileFingerprint: String(metadata.fileFingerprint || "").slice(0, 220),
    contentUrl: sanitizedUrl,
    engineId: engine.id,
  };
}

/**
 * Normalizes a shared room-document payload into the canonical reading-mode shape.
 * @param {object} payload - Raw document metadata supplied by the client.
 * @returns {object} A validated document payload for reading-mode room state.
 */
function normalizeRoomDocumentPayload(payload = {}) {
  const fileUrl = sanitizeContentUrl(payload.fileUrl || payload.url || "");
  if (!fileUrl) {
    const error = new Error("A shareable PDF URL is required");
    error.status = 400;
    throw error;
  }

  let fallbackName = "";
  try {
    // Use the last URL path segment as a best-effort fallback file name.
    const parsed = new URL(String(fileUrl || ""));
    const pathname = parsed.pathname || "";
    const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
    fallbackName = sanitizeUploadFileName(decodeURIComponent(lastSegment || ""));
  } catch {
    fallbackName = "";
  }

  const fileName = sanitizeUploadFileName(payload.fileName || fallbackName || "shared-document.pdf");
  const mimeType = normalizeDocumentMimeType(payload.mimeType || "application/pdf", fileName);
  if (mimeType !== "application/pdf") {
    const error = new Error("Only PDF files are supported in co-reading");
    error.status = 400;
    throw error;
  }

  const fileSize = Math.max(0, Math.floor(Number(payload.fileSize) || 0));
  if (fileSize > MAX_DOCUMENT_UPLOAD_BYTES) {
    const error = new Error(`Document exceeds ${Math.round(MAX_DOCUMENT_UPLOAD_BYTES / (1024 * 1024))}MB limit`);
    error.status = 400;
    throw error;
  }

  return {
    fileUrl,
    fileName,
    fileSize,
    mimeType,
    signature: `${sanitizeUploadFileName(fileName)}:${Math.max(0, Math.floor(Number(fileSize) || 0))}`, // The signature combines normalized name and size so clients can cheaply detect document changes.
    totalPages: normalizeReadingTotalPages(payload.totalPages),
  };
}

module.exports = {
  normalizeUsername,
  normalizeRoomType,
  normalizeSessionMode,
  resolveSessionEngine,
  normalizeContentType,
  normalizeMetadataForSessionEngine,
  normalizeRoomDocumentPayload,
  normalizeDocumentMimeType,
  normalizeReadingTotalPages,
};
