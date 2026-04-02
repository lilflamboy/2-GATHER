const SERVER_URL = import.meta.env.VITE_SERVER_URL || `http://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:5001`;
const MAX_MESSAGES = 200;
const MAX_VIDEO_TIME = 86400;
const SESSION_KEY = "lumiere_room";
const USERNAME_KEY = "lumiere_username";
const PUSH_PREF_KEY = "lumiere_push_notifications";
const QUICK_EMOJIS = ["❤️", "😂", "😮", "😢", "🔥", "👏"];

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
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
