"use strict";

const {
  HTTP_RATE_LIMIT_WINDOW_MS, HTTP_RATE_LIMIT_MAX,
  HTTP_AUTH_RATE_LIMIT_MAX, SOCKET_EVENT_WINDOW_MS,
  SOCKET_EVENT_MAX,
} = require("../config/constants.js");

const httpRateLimitHits = new Map();
const httpAuthRateLimitHits = new Map();
const socketEventRateLimitHits = new Map();

function isRateLimitExceeded(store, key, windowMs, maxEvents) {
  if (!key || !store || windowMs <= 0 || maxEvents <= 0) return false;

  const now = Date.now();
  const current = store.get(key);
  if (!current || (now - current.firstHit) > windowMs) {
    store.set(key, { count: 1, firstHit: now });
    return false;
  }

  current.count += 1;
  store.set(key, current);
  return current.count > maxEvents;
}

function cleanupRateLimitStore(store, windowMs) {
  const now = Date.now();
  store.forEach((record, key) => {
    if (!record || !Number.isFinite(record.firstHit) || (now - record.firstHit) > (windowMs * 2)) {
      store.delete(key);
    }
  });
}

function getRequestRateKey(req, scope = "http") {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return `${scope}:${String(ip)}`;
}

function applyHttpRateLimit(maxEvents, scope) {
  return (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    const key = getRequestRateKey(req, scope);
    if (isRateLimitExceeded(httpRateLimitHits, key, HTTP_RATE_LIMIT_WINDOW_MS, maxEvents)) {
      return res.status(429).json({ error: "Too many requests. Please slow down." });
    }
    return next();
  };
}

function isSocketEventRateLimited(socketId, eventType) {
  return isRateLimitExceeded(
    socketEventRateLimitHits,
    `${socketId}:${eventType}`,
    SOCKET_EVENT_WINDOW_MS,
    SOCKET_EVENT_MAX
  );
}

function clearSocketEventRateLimits(socketId) {
  const prefix = `${socketId}:`;
  socketEventRateLimitHits.forEach((_, key) => {
    if (key.startsWith(prefix)) socketEventRateLimitHits.delete(key);
  });
}

setInterval(() => {
  cleanupRateLimitStore(httpRateLimitHits, HTTP_RATE_LIMIT_WINDOW_MS);
  cleanupRateLimitStore(httpAuthRateLimitHits, HTTP_RATE_LIMIT_WINDOW_MS);
  cleanupRateLimitStore(socketEventRateLimitHits, SOCKET_EVENT_WINDOW_MS);
}, Math.max(5000, Math.min(60000, SOCKET_EVENT_WINDOW_MS))).unref();

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
