/**
 * URL and room-code helpers used across the frontend. Centralizing these small
 * checks keeps room joins, content validation, and media-source detection
 * consistent between the lobby, room, and upload flows.
 */

/**
 * Normalizes a room code by trimming whitespace and forcing uppercase.
 * @param {string} s - Raw room code entered by the user.
 * @returns {string} Normalized room code used for join requests.
 */
const normalizeCode = (s) => s.trim().toUpperCase();

/**
 * Tests whether a value is an absolute HTTP or HTTPS URL.
 * @param {string} value - Candidate URL string.
 * @returns {boolean} True when the value starts with `http://` or `https://`.
 */
const isHttpUrl = (value) => /^https?:\/\/\S+$/i.test(String(value || "").trim());

/**
 * Tests whether a URL points at YouTube using `youtube.com` or `youtu.be`.
 * @param {string} value - Candidate URL string.
 * @returns {boolean} True when the value looks like a YouTube URL.
 */
const isYoutubeUrl = (value) => /youtu\.?be|youtube\.com/i.test(String(value || ""));

/**
 * Tests whether a URL ends with `.pdf`, even when query strings or fragments exist.
 * @param {string} value - Candidate URL string.
 * @returns {boolean} True when the URL targets a PDF resource.
 */
const isPdfUrl = (value) => /\.pdf(\?|#|$)/i.test(String(value || ""));

/**
 * Tests whether a URL is a browser-generated blob URL.
 * Blob URLs appear when the user loads a local file directly into the browser.
 * @param {string} value - Candidate URL string.
 * @returns {boolean} True when the value starts with `blob:`.
 */
const isBlobUrl = (value) => /^blob:/i.test(String(value || "").trim());

/**
 * Tests whether a URL points directly to a media file or HLS playlist.
 * HLS `.m3u8` is included because some watch sessions stream segmented video.
 * @param {string} value - Candidate URL string.
 * @returns {boolean} True when the URL ends with a recognized media extension.
 */
const isDirectMediaUrl = (value) => /\.(mp4|webm|ogg|m3u8|mp3|wav|aac|m4a)(\?|#|$)/i.test(String(value || ""));

export {
  normalizeCode,
  isHttpUrl,
  isYoutubeUrl,
  isPdfUrl,
  isBlobUrl,
  isDirectMediaUrl,
};
