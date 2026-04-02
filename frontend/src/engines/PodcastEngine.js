import {
  normalizeUrl,
  isHttpUrl,
  isYoutubeUrl,
  isDirectMediaUrl,
  clampContentType,
  buildYoutubeEmbedUrl,
  detectYouTubeVideoId,
} from "./engineUtils.js";

const ui = Object.freeze({
  resourcePlaceholder: "Paste YouTube/podcast/audio URL",
  resourceHelp: "YouTube/audio links can be pasted for podcast and educational sessions.",
  fileAccept: "audio/*,video/*",
  uploadPrimary: "Load your podcast or audio file",
  uploadHint: "Paste YouTube/audio links or load local media. Direct media files sync best.",
  uploadButtonLabel: "Choose Media File",
  chatPlaceholder: "Drop reactions, insights, or key timestamps...",
});

function resolveResourceFromUrl(value) {
  // Podcast mode is intentionally more permissive than watch mode: YouTube,
  // direct media URLs, and "companion" links are all valid inputs.
  const raw = normalizeUrl(value);
  if (!raw) {
    return { valid: true, reason: "", normalizedUrl: "", contentType: "unknown", syncKind: "none" };
  }
  if (!isHttpUrl(raw)) {
    return { valid: false, reason: "Enter a valid http(s) link", normalizedUrl: "", contentType: "unknown", syncKind: "none" };
  }
  if (isYoutubeUrl(raw)) {
    const videoId = detectYouTubeVideoId(raw);
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
  if (isDirectMediaUrl(raw)) {
    return {
      valid: true,
      reason: "",
      normalizedUrl: raw,
      contentType: "local",
      syncKind: "html5",
    };
  }
  return {
    valid: true,
    reason: "",
    normalizedUrl: raw,
    contentType: "unknown",
    syncKind: "companion",
  };
}

function validateFile(file) {
  // Podcasts can be distributed as either audio-only or video files.
  if (!file) return { valid: false, reason: "No file selected" };
  const mime = String(file.type || "").toLowerCase();
  if (!mime.startsWith("audio/") && !mime.startsWith("video/")) {
    return { valid: false, reason: "Please choose an audio or video file" };
  }
  return { valid: true, reason: "" };
}

const PodcastEngine = {
  key: "podcast",
  label: "PodcastEngine",
  ui,
  allowPlaybackSync: true,
  resolveResourceFromUrl,
  validateFile,
  inferContentTypeFromUrl: value => clampContentType(resolveResourceFromUrl(value).contentType, "unknown"),
};

export default PodcastEngine;
