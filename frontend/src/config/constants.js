/**
 * Central frontend constants for Lumiere. Keeping connection settings, storage
 * keys, UI limits, WebRTC config, and quick-reaction defaults here avoids
 * scattering shared values across hooks and components.
 */

// Resolve the backend base URL from Vite env first, then fall back to the
// current browser hostname in development so local and LAN testing both work.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || `http://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:5001`;

// UI limits used by room screens to bound in-memory chat history and sanitize
// playback values before rendering or syncing them in the browser.
const MAX_MESSAGES = 200;
const MAX_VIDEO_TIME = 86400;

// Storage keys for room/session bootstrap. Session storage keeps the active
// room code scoped to one tab, while local storage preserves username and push
// preferences across browser restarts.
const SESSION_KEY = "lumiere_room";
const USERNAME_KEY = "lumiere_username";
const PUSH_PREF_KEY = "lumiere_push_notifications";

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
  SERVER_URL,
  MAX_MESSAGES,
  MAX_VIDEO_TIME,
  SESSION_KEY,
  USERNAME_KEY,
  PUSH_PREF_KEY,
  QUICK_EMOJIS,
  ICE_CONFIG,
};
