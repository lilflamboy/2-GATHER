/**
 * Sliding-window rate limiting helpers for the Lumiere backend. These guards
 * protect normal HTTP traffic, auth-related HTTP traffic, and noisy realtime
 * socket events with separate in-memory stores so bursts in one area do not
 * starve unrelated traffic.
 */

"use strict";

const {
  HTTP_RATE_LIMIT_WINDOW_MS, HTTP_RATE_LIMIT_MAX,
  HTTP_AUTH_RATE_LIMIT_MAX, SOCKET_EVENT_WINDOW_MS,
  SOCKET_EVENT_MAX,
} = require("../config/constants.js");

// General HTTP request hit counts keyed by `scope:ip`.
const httpRateLimitHits = new Map();
// Auth-sensitive request hit counts keyed by `scope:ip`.
const httpAuthRateLimitHits = new Map();
// Realtime socket event hit counts keyed by `socketId:eventType`.
const socketEventRateLimitHits = new Map();

/**
 * Checks whether a key has exceeded its event budget within the active window.
 * @param {Map} store - Rate-limit store that tracks hit counters.
 * @param {string} key - Unique rate-limit key for the caller and scope.
 * @param {number} windowMs - Sliding-window size in milliseconds.
 * @param {number} maxEvents - Maximum allowed hits inside the window.
 * @returns {boolean} True when the caller should be rate-limited.
 */
function isRateLimitExceeded(store, key, windowMs, maxEvents) {
  if (!key || !store || windowMs <= 0 || maxEvents <= 0) return false;

  const now = Date.now();
  const current = store.get(key);
  // Reset the bucket once the original hit falls outside the active window.
  if (!current || (now - current.firstHit) > windowMs) {
    store.set(key, { count: 1, firstHit: now });
    return false;
  }

  current.count += 1;
  store.set(key, current);
  return current.count > maxEvents;
}

/**
 * Removes stale rate-limit entries that are well outside the active window.
 * @param {Map} store - Rate-limit store to clean.
 * @param {number} windowMs - Window size used by that store.
 * @returns {void} This function mutates the provided store in place.
 */
function cleanupRateLimitStore(store, windowMs) {
  const now = Date.now();
  store.forEach((record, key) => {
    // Evict invalid or very old entries so the in-memory stores do not grow forever.
    if (!record || !Number.isFinite(record.firstHit) || (now - record.firstHit) > (windowMs * 2)) {
      store.delete(key);
    }
  });
}

/**
 * Builds a stable HTTP rate-limit key from the request scope and caller IP.
 * @param {object} req - Express request object.
 * @param {string} scope - Logical rate-limit scope such as http or auth.
 * @returns {string} A key combining scope and the best available client IP.
 */
function getRequestRateKey(req, scope = "http") {
  // Express usually exposes proxy-aware IPs through req.ip, with the socket
  // address as a fallback when proxy metadata is unavailable.
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return `${scope}:${String(ip)}`;
}

/**
 * Creates Express middleware that enforces an HTTP sliding-window rate limit.
 * @param {number} maxEvents - Max requests allowed within the window.
 * @param {string} scope - Logical scope label used in the rate-limit key.
 * @returns {Function} Express middleware that returns 429 on over-limit traffic.
 */
function applyHttpRateLimit(maxEvents, scope) {
  return (req, res, next) => {
    // Preflight requests are not user actions and should not consume quota.
    if (req.method === "OPTIONS") return next();
    const key = getRequestRateKey(req, scope);
    if (isRateLimitExceeded(httpRateLimitHits, key, HTTP_RATE_LIMIT_WINDOW_MS, maxEvents)) {
      return res.status(429).json({ error: "Too many requests. Please slow down." });
    }
    return next();
  };
}

/**
 * Checks whether a socket event should be rate-limited for one connection.
 * @param {string} socketId - Socket.IO connection id.
 * @param {string} eventType - Event name being emitted by the client.
 * @returns {boolean} True when the socket has exceeded its event budget.
 */
function isSocketEventRateLimited(socketId, eventType) {
  return isRateLimitExceeded(
    socketEventRateLimitHits,
    `${socketId}:${eventType}`,
    SOCKET_EVENT_WINDOW_MS,
    SOCKET_EVENT_MAX
  );
}

/**
 * Clears all tracked socket-event counters for a disconnected socket.
 * @param {string} socketId - Socket.IO connection id being torn down.
 * @returns {void} This function mutates the socket-event store in place.
 */
function clearSocketEventRateLimits(socketId) {
  const prefix = `${socketId}:`;
  socketEventRateLimitHits.forEach((_, key) => {
    if (key.startsWith(prefix)) socketEventRateLimitHits.delete(key);
  });
}

// Periodic cleanup prevents stale buckets from lingering forever in memory
// when a caller stops sending traffic after an initial burst.
setInterval(() => {
  cleanupRateLimitStore(httpRateLimitHits, HTTP_RATE_LIMIT_WINDOW_MS);
  cleanupRateLimitStore(httpAuthRateLimitHits, HTTP_RATE_LIMIT_WINDOW_MS);
  cleanupRateLimitStore(socketEventRateLimitHits, SOCKET_EVENT_WINDOW_MS);
}, Math.max(5000, Math.min(60000, SOCKET_EVENT_WINDOW_MS))).unref(); // Run cleanup often enough to track short windows, but not so often that housekeeping becomes noisy.

module.exports = {
  httpRateLimitHits,
  httpAuthRateLimitHits,
  socketEventRateLimitHits,
  cleanupRateLimitStore,
  isRateLimitExceeded,
  getRequestRateKey,
  applyHttpRateLimit,
  isSocketEventRateLimited,
  clearSocketEventRateLimits,
};
