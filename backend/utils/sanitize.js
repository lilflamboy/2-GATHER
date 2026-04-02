"use strict";

const {
  MAX_MESSAGE_LENGTH, MAX_BIO_LENGTH, MAX_PHOTO_URL_LENGTH,
  MAX_CONTENT_URL_LENGTH, MAX_ROOM_MOOD_TAG_LENGTH,
  MAX_SHARED_MEMORY_GENRE_LENGTH,
  MAX_SHARED_MEMORY_MOOD_LENGTH,
} = require("../config/constants.js");

function escapeAngleBrackets(text) {
  return String(text || "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitize(text) {
  if (typeof text !== "string") return "";
  return escapeAngleBrackets(text).trim().slice(0, MAX_MESSAGE_LENGTH);
}

function sanitizeBio(text) {
  if (typeof text !== "string") return "";
  return escapeAngleBrackets(text).trim().slice(0, MAX_BIO_LENGTH);
}

function sanitizePhotoURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\/\S+$/i.test(raw)) return raw.slice(0, MAX_PHOTO_URL_LENGTH);
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+$/.test(raw)) {
    return raw.slice(0, MAX_PHOTO_URL_LENGTH);
  }
  return "";
}

function sanitizeUploadFileName(value) {
  return String(value || "")
    .replace(/[^\w.\- ()]/g, "_")
    .trim()
    .slice(0, 120) || `document-${Date.now()}.pdf`;
}

function sanitizeSharedMemoryGenre(value) {
  return sanitize(String(value || "")).slice(0, MAX_SHARED_MEMORY_GENRE_LENGTH);
}

function sanitizeSharedMemoryMoodTag(value) {
  return sanitize(String(value || "")).slice(0, MAX_SHARED_MEMORY_MOOD_LENGTH);
}

function sanitizeRoomMoodTag(value) {
  return sanitize(String(value || "")).slice(0, MAX_ROOM_MOOD_TAG_LENGTH);
}

function sanitizeActivityPayload(payload) {
  try {
    const raw = JSON.stringify(payload || {});
    if (raw.length <= 2500) return JSON.parse(raw);
    return {
      truncated: true,
      preview: raw.slice(0, 2500),
    };
  } catch {
    return {};
  }
}

function sanitizeContentUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\/\S+$/i.test(raw)) {
    return raw.slice(0, MAX_CONTENT_URL_LENGTH);
  }
  return "";
}

module.exports = {
  escapeAngleBrackets,
  sanitize,
  sanitizeBio,
  sanitizePhotoURL,
  sanitizeContentUrl,
  sanitizeUploadFileName,
  sanitizeRoomMoodTag,
  sanitizeActivityPayload,
  sanitizeSharedMemoryGenre,
  sanitizeSharedMemoryMoodTag,
};
