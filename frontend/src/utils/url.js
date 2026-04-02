const normalizeCode = (s) => s.trim().toUpperCase();

const isHttpUrl = (value) => /^https?:\/\/\S+$/i.test(String(value || "").trim());
const isYoutubeUrl = (value) => /youtu\.?be|youtube\.com/i.test(String(value || ""));
const isPdfUrl = (value) => /\.pdf(\?|#|$)/i.test(String(value || ""));
const isBlobUrl = (value) => /^blob:/i.test(String(value || "").trim());
const isDirectMediaUrl = (value) => /\.(mp4|webm|ogg|m3u8|mp3|wav|aac|m4a)(\?|#|$)/i.test(String(value || ""));

export {
  normalizeCode,
  isHttpUrl,
  isYoutubeUrl,
  isPdfUrl,
  isBlobUrl,
  isDirectMediaUrl,
};
