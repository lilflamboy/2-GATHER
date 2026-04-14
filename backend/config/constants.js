"use strict";

/**
 * Central constants and configuration values for the
 * Lumiere backend. All environment variables are read
 * here so the rest of the codebase never touches
 * process.env directly.
 */

// Server config centralizes process-level settings so startup, CORS, and
// database bootstrap all read from one stable source of truth.
const PORT = process.env.PORT || 10000;
const CLIENT_ORIGIN = process.env.CLIENT_URL || "http://localhost:5173";
const NODE_ENV = process.env.NODE_ENV || "development";
const MONGODB_URI = process.env.MONGODB_URI || "";
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "32mb";

// These fallback origins keep local frontend development working even when
// only a single primary CLIENT_URL is configured in the environment.
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

// This allowlist is consumed by CORS and other origin checks. It reads the
// comma-separated env value, trims whitespace, drops empties, and de-dupes.
const CLIENT_ORIGINS = (process.env.CLIENT_URLS || `${CLIENT_ORIGIN},${DEFAULT_DEV_ORIGINS.join(",")}`)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .filter((origin, index, arr) => arr.indexOf(origin) === index); // Keep the first matching origin so the final allowlist stays deterministic.

// Room limits cap the amount of state one room, chat thread, or shared-memory
// workflow can accumulate before the app rejects new input.
const ROOM_EXPIRY_MS = parseInt(process.env.ROOM_EXPIRY_MS || "14400000", 10);
const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOM_USERS = 6;
const MAX_VIDEO_TIME = 86400;
const WATCH_MEMORY_MIN_SECONDS = parseInt(process.env.WATCH_MEMORY_MIN_SECONDS || "45", 10);
const MAX_WATCHLIST_ITEMS = parseInt(process.env.MAX_WATCHLIST_ITEMS || "150", 10);
const MAX_WATCHLIST_TITLE_LENGTH = 120;
const MAX_WATCHLIST_URL_LENGTH = 500;
const MAX_WATCHLIST_NOTES_LENGTH = 260;
const MAX_SHARED_MEMORY_NOTE_LENGTH = 600;
const MAX_SHARED_MEMORY_GENRE_LENGTH = 48;
const MAX_SHARED_MEMORY_MOOD_LENGTH = 48;
const MAX_SHARED_MEMORY_HIGHLIGHT_LENGTH = 12;
const MAX_SHARED_MEMORY_SESSION_MINUTES = 1440;
const MAX_SHARED_MEMORY_REACTION_COUNT = 9999;
const MAX_ROOM_MOOD_TAG_LENGTH = 32;
const MAX_CONTENT_URL_LENGTH = 700;
const MAX_SESSION_HIGHLIGHTS = parseInt(process.env.MAX_SESSION_HIGHLIGHTS || "120", 10);
const MAX_SESSION_REACTIONS = parseInt(process.env.MAX_SESSION_REACTIONS || "3000", 10);
const MAX_INSIGHT_SUMMARY_LENGTH = parseInt(process.env.MAX_INSIGHT_SUMMARY_LENGTH || "3000", 10);
const MAX_ROOM_HISTORY_ITEMS = 500;
const MAX_VIDEO_NAME_LENGTH = 180;

// Sync waiting controls decide when one member is so far behind that playback
// should pause briefly and let everyone realign before resuming.
const SYNC_WAIT_THRESHOLD = parseFloat(process.env.SYNC_WAIT_THRESHOLD || "1.4");
const SYNC_RESUME_THRESHOLD = parseFloat(process.env.SYNC_RESUME_THRESHOLD || "0.35");
const SYNC_WAIT_GRACE_MS = parseInt(process.env.SYNC_WAIT_GRACE_MS || "5500", 10);
const SYNC_WAIT_COOLDOWN_MS = parseInt(process.env.SYNC_WAIT_COOLDOWN_MS || "3200", 10);
const SYNC_RESUME_GRACE_MS = parseInt(process.env.SYNC_RESUME_GRACE_MS || "1200", 10);
const SYNC_BUFFER_LOW_SECONDS = parseFloat(process.env.SYNC_BUFFER_LOW_SECONDS || "1.2");
const SYNC_NON_BUFFERING_EXTRA_GAP = parseFloat(process.env.SYNC_NON_BUFFERING_EXTRA_GAP || "0.9");
const MEMBER_TIME_TTL_MS = parseInt(process.env.MEMBER_TIME_TTL_MS || "10000", 10);

// Rate limiting caps burst traffic on both HTTP and realtime channels so
// authentication, chat, and room control events cannot be spammed cheaply.
const HTTP_RATE_LIMIT_WINDOW_MS = parseInt(process.env.HTTP_RATE_LIMIT_WINDOW_MS || "60000", 10);
const HTTP_RATE_LIMIT_MAX = parseInt(process.env.HTTP_RATE_LIMIT_MAX || "120", 10);
const HTTP_AUTH_RATE_LIMIT_MAX = parseInt(process.env.HTTP_AUTH_RATE_LIMIT_MAX || "300", 10);
const SOCKET_EVENT_WINDOW_MS = parseInt(process.env.SOCKET_EVENT_WINDOW_MS || "15000", 10);
const SOCKET_EVENT_MAX = parseInt(process.env.SOCKET_EVENT_MAX || "90", 10);
const SYNC_HEARTBEAT_MS = parseInt(process.env.SYNC_HEARTBEAT_MS || "2000", 10);
const VIDEO_SCHEDULE_LEAD_MS = parseInt(process.env.VIDEO_SCHEDULE_LEAD_MS || "900", 10);

// Document upload limits intentionally separate payload size from file size:
// base64 transport adds overhead, so JSON_BODY_LIMIT is higher than the raw
// MAX_DOCUMENT_UPLOAD_BYTES cap enforced on the decoded file itself.
const MAX_DOCUMENT_UPLOAD_BYTES = parseInt(process.env.MAX_DOCUMENT_UPLOAD_BYTES || "20971520", 10);
const DOCUMENT_UPLOAD_TTL_MS = parseInt(process.env.DOCUMENT_UPLOAD_TTL_MS || "43200000", 10);
const READING_PAGE_LOCK_MS = parseInt(process.env.READING_PAGE_LOCK_MS || "100", 10);
const READING_PAGE_MAX = parseInt(process.env.READING_PAGE_MAX || "5000", 10);
const AUDIO_SCHEDULE_LEAD_MS = parseInt(process.env.AUDIO_SCHEDULE_LEAD_MS || "1500", 10);
const AUDIO_MUTATION_LOCK_MS = parseInt(process.env.AUDIO_MUTATION_LOCK_MS || "500", 10);
const AUDIO_TOGGLE_DEBOUNCE_MS = parseInt(process.env.AUDIO_TOGGLE_DEBOUNCE_MS || "300", 10);

// Validation constants define the canonical shape of user-controlled fields
// before they are accepted into profiles, room metadata, and uploads.
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
const MAX_BIO_LENGTH = 240;
const MAX_PHOTO_URL_LENGTH = parseInt(process.env.MAX_PHOTO_URL_LENGTH || "120000", 10);

// Default settings seed new profiles and act as fallbacks when legacy records
// are missing a newer preferences field.
const DEFAULT_SETTINGS = Object.freeze({
  inviteNotifications: true,
  memoryNudges: true,
  showOnlineStatus: true,
});

// Allowed session modes drive room creation, analytics, validation, and UI
// mode-switching so all layers share the same canonical labels.
const ALLOWED_SESSION_MODES = Object.freeze(["watch", "podcast", "music", "reading", "study"]);

// Allowed content types whitelist the media/document sources the room and
// session services know how to synchronize safely.
const ALLOWED_CONTENT_TYPES = Object.freeze(["local", "youtube", "netflix", "prime", "disney", "ott", "pdf", "document", "unknown"]);

// Relationship types define the tags used in dashboards, analytics, and
// couple-space features for accepted relationships.
const ALLOWED_RELATIONSHIP_TYPES = Object.freeze(["couple", "friends", "family", "group"]);

// Reaction types define the normalized reaction labels that can be stored for
// messages, watch sessions, and shared-memory highlights.
const ALLOWED_REACTION_TYPES = Object.freeze(["laugh", "love", "shock", "reaction", "bookmark", "note"]);

// Admin access is explicitly allowlisted by Firebase uid. The backend never
// trusts client-side role claims for admin features; it checks this set.
const ADMIN_UIDS = new Set(
  String(process.env.ADMIN_UIDS || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean)
);

/**
 * Checks whether a Firebase uid is in the explicit backend admin allowlist.
 * @param {string} uid - The authenticated Firebase user id to test.
 * @returns {boolean} True when the uid has backend admin access.
 */
function isAdminUser(uid) {
  return !!uid && ADMIN_UIDS.has(uid);
}

// The session engine registry maps each mode to the runtime engine contract
// used by room orchestration, validation, and frontend capability checks.
const SESSION_ENGINE_REGISTRY = Object.freeze({
  watch: Object.freeze({
    id: "WatchEngine",
    allowPlayback: true,
    allowedContentTypes: new Set(["local", "youtube", "netflix", "prime", "disney", "ott", "unknown"]),
  }),
  podcast: Object.freeze({
    id: "PodcastEngine",
    allowPlayback: true,
    allowedContentTypes: new Set(["local", "youtube", "unknown", "ott"]),
  }),
  music: Object.freeze({
    id: "MusicEngine",
    allowPlayback: true,
    allowedContentTypes: new Set(["local", "youtube", "unknown", "ott"]),
  }),
  reading: Object.freeze({
    id: "ReadingEngine",
    allowPlayback: false,
    allowedContentTypes: new Set(["pdf", "document", "unknown"]),
  }),
  study: Object.freeze({
    id: "LiveEngine",
    allowPlayback: true,
    allowedContentTypes: new Set(["local", "youtube", "pdf", "document", "unknown", "ott"]),
  }),
});

module.exports = {
  PORT,
  CLIENT_ORIGIN,
  NODE_ENV,
  MONGODB_URI,
  JSON_BODY_LIMIT,
  DEFAULT_DEV_ORIGINS,
  CLIENT_ORIGINS,
  ROOM_EXPIRY_MS,
  MAX_MESSAGE_LENGTH,
  MAX_ROOM_USERS,
  MAX_VIDEO_TIME,
  SYNC_WAIT_THRESHOLD,
  SYNC_RESUME_THRESHOLD,
  SYNC_WAIT_GRACE_MS,
  SYNC_WAIT_COOLDOWN_MS,
  SYNC_RESUME_GRACE_MS,
  SYNC_BUFFER_LOW_SECONDS,
  SYNC_NON_BUFFERING_EXTRA_GAP,
  MEMBER_TIME_TTL_MS,
  WATCH_MEMORY_MIN_SECONDS,
  MAX_WATCHLIST_ITEMS,
  MAX_WATCHLIST_TITLE_LENGTH,
  MAX_WATCHLIST_URL_LENGTH,
  MAX_WATCHLIST_NOTES_LENGTH,
  MAX_SHARED_MEMORY_NOTE_LENGTH,
  MAX_SHARED_MEMORY_GENRE_LENGTH,
  MAX_SHARED_MEMORY_MOOD_LENGTH,
  MAX_SHARED_MEMORY_HIGHLIGHT_LENGTH,
  MAX_SHARED_MEMORY_SESSION_MINUTES,
  MAX_SHARED_MEMORY_REACTION_COUNT,
  MAX_ROOM_MOOD_TAG_LENGTH,
  MAX_CONTENT_URL_LENGTH,
  MAX_SESSION_HIGHLIGHTS,
  MAX_SESSION_REACTIONS,
  MAX_INSIGHT_SUMMARY_LENGTH,
  MAX_ROOM_HISTORY_ITEMS,
  MAX_VIDEO_NAME_LENGTH,
  HTTP_RATE_LIMIT_WINDOW_MS,
  HTTP_RATE_LIMIT_MAX,
  HTTP_AUTH_RATE_LIMIT_MAX,
  SOCKET_EVENT_WINDOW_MS,
  SOCKET_EVENT_MAX,
  SYNC_HEARTBEAT_MS,
  VIDEO_SCHEDULE_LEAD_MS,
  MAX_DOCUMENT_UPLOAD_BYTES,
  DOCUMENT_UPLOAD_TTL_MS,
  READING_PAGE_LOCK_MS,
  READING_PAGE_MAX,
  AUDIO_SCHEDULE_LEAD_MS,
  AUDIO_MUTATION_LOCK_MS,
  AUDIO_TOGGLE_DEBOUNCE_MS,
  USERNAME_REGEX,
  MAX_BIO_LENGTH,
  MAX_PHOTO_URL_LENGTH,
  DEFAULT_SETTINGS,
  ALLOWED_SESSION_MODES,
  ALLOWED_CONTENT_TYPES,
  ALLOWED_RELATIONSHIP_TYPES,
  ALLOWED_REACTION_TYPES,
  ADMIN_UIDS,
  isAdminUser,
  SESSION_ENGINE_REGISTRY,
};
