/**
 * Central sanitization helpers for the Lumiere backend. This file keeps the
 * app's input-cleaning rules in one place so routes, services, and sockets all
 * strip dangerous characters, normalize whitespace, and enforce field-specific
 * length limits consistently before storing or broadcasting user input.
 */

"use strict";

const {
  MAX_MESSAGE_LENGTH, MAX_BIO_LENGTH, MAX_PHOTO_URL_LENGTH,
  MAX_CONTENT_URL_LENGTH, MAX_ROOM_MOOD_TAG_LENGTH,
  MAX_SHARED_MEMORY_GENRE_LENGTH,
  MAX_SHARED_MEMORY_MOOD_LENGTH,
} = require("../config/constants.js");

/**
 * Escapes raw angle brackets so user text cannot be interpreted as markup.
 * @param {string} text - Raw text that may contain `<` or `>` characters.
 * @returns {string} Text with angle brackets converted to HTML entities.
 */
function escapeAngleBrackets(text) {
  // Angle brackets are the minimum characters needed to form HTML tags, so
  // escaping them blocks simple markup injection/XSS payloads.
  return String(text || "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Applies the backend's base sanitizer for general user-entered text.
 * @param {string} text - Arbitrary text supplied by a client.
 * @returns {string} Trimmed, escaped text capped to the global message limit.
 */
function sanitize(text) {
  if (typeof text !== "string") return "";
  return escapeAngleBrackets(text).trim().slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Sanitizes profile bio text using the bio-specific length cap.
 * @param {string} text - Raw bio text supplied by the user.
 * @returns {string} Escaped, trimmed bio content clipped to the bio limit.
 */
function sanitizeBio(text) {
  if (typeof text !== "string") return "";
  return escapeAngleBrackets(text).trim().slice(0, MAX_BIO_LENGTH);
}

/**
 * Sanitizes avatar/photo URLs while allowing hosted images or inline image data.
 * @param {string} value - Candidate photo URL or base64 image data URI.
 * @returns {string} A safe photo reference or an empty string when rejected.
 */
function sanitizePhotoURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // Hosted images are allowed over normal web protocols.
  if (/^https?:\/\/\S+$/i.test(raw)) return raw.slice(0, MAX_PHOTO_URL_LENGTH);
  // Base64 image data URIs are allowed for inline avatars, but other schemes
  // such as javascript:, file:, or arbitrary data payloads are rejected.
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+$/.test(raw)) {
    return raw.slice(0, MAX_PHOTO_URL_LENGTH);
  }
  return "";
}

/**
 * Sanitizes uploaded file names into a conservative safe display value.
 * @param {string} value - Raw file name supplied by the client or URL parser.
 * @returns {string} A cleaned file name using a restricted character allowlist.
 */
function sanitizeUploadFileName(value) {
  // Replace disallowed characters with underscores so file names cannot smuggle
  // path separators or confusing shell-like characters into logs/UI.
  return String(value || "")
    .replace(/[^\w.\- ()]/g, "_")
    .trim()
    .slice(0, 120) || `document-${Date.now()}.pdf`;
}

/**
 * Sanitizes a shared-memory genre label into a short plain-text value.
 * @param {string} value - Genre text collected from a shared memory form.
 * @returns {string} A trimmed, escaped genre capped to the genre limit.
 */
function sanitizeSharedMemoryGenre(value) {
  return sanitize(String(value || "")).slice(0, MAX_SHARED_MEMORY_GENRE_LENGTH);
}

/**
 * Sanitizes a shared-memory mood label into a short plain-text tag.
 * @param {string} value - Mood text collected from a shared memory form.
 * @returns {string} A trimmed, escaped mood tag capped to the mood limit.
 */
function sanitizeSharedMemoryMoodTag(value) {
  return sanitize(String(value || "")).slice(0, MAX_SHARED_MEMORY_MOOD_LENGTH);
}

/**
 * Sanitizes a room mood tag that describes the tone of a live room.
 * @param {string} value - Mood tag text submitted with room metadata.
 * @returns {string} A trimmed, escaped room mood tag within the tag limit.
 */
function sanitizeRoomMoodTag(value) {
  return sanitize(String(value || "")).slice(0, MAX_ROOM_MOOD_TAG_LENGTH);
}

/**
 * Sanitizes activity payloads into a bounded plain-JSON shape for logging.
 * @param {any} payload - Activity metadata attached to an activity event.
 * @returns {object} A JSON-safe payload or a truncated preview object.
 */
function sanitizeActivityPayload(payload) {
  try {
    // Serializing and parsing strips functions, prototypes, and other complex
    // values so activity logs only keep plain JSON-safe data.
    const raw = JSON.stringify(payload || {});
    if (raw.length <= 2500) return JSON.parse(raw);
    // Oversized payloads are reduced to a preview to keep activity rows bounded.
    return {
      truncated: true,
      preview: raw.slice(0, 2500),
    };
  } catch {
    return {};
  }
}

/**
 * Sanitizes shareable content URLs used by rooms, uploads, and watchlist items.
 * @param {string} value - Candidate URL for room content or a document link.
 * @returns {string} A trimmed http/https URL or an empty string when invalid.
 */
function sanitizeContentUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // Content URLs use a dedicated longer limit because media/document links are
  // often longer than small profile-image URLs.
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
