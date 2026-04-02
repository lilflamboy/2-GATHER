import {
  normalizeUrl,
  isHttpUrl,
  isYoutubeUrl,
  clampContentType,
  buildYoutubeEmbedUrl,
  extractYouTubeId,
} from "./engineUtils.js";

const ui = Object.freeze({
  resourcePlaceholder: "Paste YouTube link",
  resourceHelp: "Paste a YouTube link to watch together, or upload a local video file below.",
  fileAccept: "video/*",
  uploadPrimary: "Load your video file",
  uploadHint: "Everyone loads their own copy — playback stays in sync.",
  uploadButtonLabel: "Choose Video File",
  chatPlaceholder: "Message...",
});

function resolveResourceFromUrl(value) {
  // Watch mode is intentionally strict: shared URLs must resolve to YouTube so
  // every client gets the same transport behavior and sync expectations.
  const raw = normalizeUrl(value);
  if (!raw) {
    return {
      valid: true,
      reason: "",
      normalizedUrl: "",
      contentType: "unknown",
      syncKind: "none",
    };
  }
  if (!isHttpUrl(raw)) {
    return { valid: false, reason: "Enter a valid http(s) link", normalizedUrl: "", contentType: "unknown", syncKind: "none" };
  }
  if (isYoutubeUrl(raw)) {
    const videoId = extractYouTubeId(raw);
    if (!videoId) {
      return { valid: false, reason: "Invalid YouTube link", normalizedUrl: "", contentType: "unknown", syncKind: "none" };
    }
    return {
      valid: true,
      reason: "",
      normalizedUrl: buildYoutubeEmbedUrl(raw),
      contentType: "youtube",
      syncKind: "youtube",
      videoId,
    };
  }
  return {
    valid: false,
    reason: "Please paste a YouTube watch link",
    normalizedUrl: "",
    contentType: "unknown",
    syncKind: "none",
  };
}

function validateFile(file) {
  // Local watch sessions only accept actual video media; everything else should
  // be routed through a different engine.
  if (!file) return { valid: false, reason: "No file selected" };
  const mime = String(file.type || "").toLowerCase();
  if (!mime.startsWith("video/")) return { valid: false, reason: "Please choose a video file" };
  return { valid: true, reason: "" };
}

const WatchEngine = {
  key: "watch",
  label: "WatchEngine",
  ui,
  // Watch mode exposes standard play/pause/seek synchronization.
  allowPlaybackSync: true,
  resolveResourceFromUrl,
  validateFile,
  inferContentTypeFromUrl: value => clampContentType(resolveResourceFromUrl(value).contentType, "unknown"),
};

export default WatchEngine;
