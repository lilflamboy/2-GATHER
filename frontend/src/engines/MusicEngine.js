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
  resourcePlaceholder: "Paste YouTube or direct audio URL",
  resourceHelp: "Music rooms sync audio by timeline only. Everyone either loads the same file or uses the same URL.",
  fileAccept: "audio/*",
  uploadPrimary: "Load an audio file or paste a music link",
  uploadHint: "MP3/WAV/AAC work best for local sync. YouTube and direct audio URLs are shareable across devices.",
  uploadButtonLabel: "Choose Audio File",
  chatPlaceholder: "React to the track, drop notes, or bookmark moments...",
});

function resolveResourceFromUrl(value) {
  // Music rooms only allow sources that can share one common timeline:
  // YouTube or a direct audio file URL.
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
    valid: false,
    reason: "Please use YouTube or a direct audio file URL",
    normalizedUrl: "",
    contentType: "unknown",
    syncKind: "none",
  };
}

function validateFile(file) {
  // Local music sync assumes every participant loaded the same audio asset.
  if (!file) return { valid: false, reason: "No file selected" };
  const mime = String(file.type || "").toLowerCase();
  if (!mime.startsWith("audio/")) {
    return { valid: false, reason: "Please choose an audio file (MP3/WAV/etc.)" };
  }
  return { valid: true, reason: "" };
}

const MusicEngine = {
  key: "music",
  label: "MusicEngine",
  ui,
  allowPlaybackSync: true,
  resolveResourceFromUrl,
  validateFile,
  inferContentTypeFromUrl: value => clampContentType(resolveResourceFromUrl(value).contentType, "unknown"),
};

export default MusicEngine;
