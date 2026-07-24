/**
 * Central frontend constants for 2-GATHER. Keeping connection settings, storage
 * keys, UI limits, WebRTC config, and quick-reaction defaults here avoids
 * scattering shared values across hooks and components.
 */

// Normalize the backend base URL once so every API/socket caller avoids
// accidental double slashes, while production relies on VITE_API_URL.
const normalizeBaseUrl = (url) => String(url || "").trim().replace(/\/+$/, "");
const DEV_API_URL = `http://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:10000`;
const API_URL = normalizeBaseUrl(import.meta.env.VITE_API_URL || (import.meta.env.DEV ? DEV_API_URL : ""));
const getApiUrl = () => {
  if (!API_URL) {
    throw new Error("Missing VITE_API_URL for frontend API requests.");
  }
  return API_URL;
};

const buildApiUrl = (path = "") => {
  const normalizedPath = String(path || "").trim();
  const baseUrl = getApiUrl();
  if (!normalizedPath) {
    return baseUrl;
  }
  return normalizedPath.startsWith("/") ? `${baseUrl}${normalizedPath}` : `${baseUrl}/${normalizedPath}`;
};

// UI limits used by room screens to bound in-memory chat history and sanitize
// playback values before rendering or syncing them in the browser.
const MAX_MESSAGES = 200;
const MAX_VIDEO_TIME = 86400;

// Storage keys for room/session bootstrap. Session storage keeps the active
// room code scoped to one tab, while local storage preserves username and push
// preferences across browser restarts.
const SESSION_KEY = "2-gather_room";
const USERNAME_KEY = "2-gather_username";
const PUSH_PREF_KEY = "2-gather_push_notifications";

// Quick-reaction emoji shortcuts shown in the chat UI for one-tap responses.
const QUICK_EMOJIS = ["❤️", "😂", "😮", "😢", "🔥", "👏"];

// ICE servers help WebRTC peers discover a routable network path. These Google
// STUN endpoints do not relay media; they simply tell each browser its public
// address so peer-to-peer call setup can succeed more often.
const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }, // Primary Google STUN server used during peer negotiation.
    { urls: "stun:stun1.l.google.com:19302" }, // Secondary STUN server for redundancy if the first one is unavailable.
  ],
};

export {
  API_URL,
  getApiUrl,
  buildApiUrl,
  MAX_MESSAGES,
  MAX_VIDEO_TIME,
  SESSION_KEY,
  USERNAME_KEY,
  PUSH_PREF_KEY,
  QUICK_EMOJIS,
  ICE_CONFIG,
};
