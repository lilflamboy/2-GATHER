"use strict";

const {
  ALLOWED_SESSION_MODES, ALLOWED_CONTENT_TYPES,
  READING_PAGE_MAX, MAX_VIDEO_NAME_LENGTH,
  MAX_VIDEO_TIME, SESSION_ENGINE_REGISTRY,
} = require("../config/constants.js");
const {
  sanitize, sanitizeContentUrl,
} = require("./sanitize.js");

function normalizeUsername(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
}

function normalizeReadingTotalPages(value) {
  const totalPages = Math.floor(Number(value) || 0);
  if (!Number.isFinite(totalPages) || totalPages <= 0) return 0;
  return Math.max(1, Math.min(READING_PAGE_MAX, totalPages));
}

function normalizeDocumentMimeType(value, fileName = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "application/pdf") return "application/pdf";
  if (raw === "text/plain") return "text/plain";
  if (raw === "application/msword") return "application/msword";
  if (raw === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (String(fileName || "").toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (String(fileName || "").toLowerCase().endsWith(".txt")) return "text/plain";
  if (String(fileName || "").toLowerCase().endsWith(".doc")) return "application/msword";
  if (String(fileName || "").toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "";
}

function normalizeRoomType(roomType) {
  const value = String(roomType || "").trim().toLowerCase();
  if (value === "duo" || value === "family" || value === "friends") return value;
  return "friends";
}

function normalizeSessionMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  if (ALLOWED_SESSION_MODES.includes(value)) return value;
  return "watch";
}

function resolveSessionEngine(mode) {
  const normalized = normalizeSessionMode(mode);
  return SESSION_ENGINE_REGISTRY[normalized] || SESSION_ENGINE_REGISTRY.watch;
}

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

function normalizeMetadataForSessionEngine(sessionMode, metadata = {}) {
  const engine = resolveSessionEngine(sessionMode);
  const sanitizedUrl = sanitizeContentUrl(metadata.contentUrl || "");
  const normalizedSourceType = normalizeContentType(metadata.sourceType || "unknown");
  const sourceType = engine.allowedContentTypes.has(normalizedSourceType) ? normalizedSourceType : "unknown";
  return {
    videoName: sanitize(String(metadata.videoName || "")).slice(0, MAX_VIDEO_NAME_LENGTH),
    duration: Math.max(0, Math.min(MAX_VIDEO_TIME, Number(metadata.duration) || 0)),
    sourceType,
    fileFingerprint: String(metadata.fileFingerprint || "").slice(0, 220),
    contentUrl: sanitizedUrl,
    engineId: engine.id,
  };
}

module.exports = {
  normalizeUsername,
  normalizeRoomType,
  normalizeSessionMode,
  resolveSessionEngine,
  normalizeContentType,
  normalizeMetadataForSessionEngine,
  normalizeDocumentMimeType,
  normalizeReadingTotalPages,
};
