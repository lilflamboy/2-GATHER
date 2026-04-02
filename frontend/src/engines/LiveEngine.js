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
  resourcePlaceholder: "Paste class link, lecture URL, or study resource",
  resourceHelp: "Use lecture/resource links to run teacher-student style study rooms.",
  fileAccept: "audio/*,video/*,.pdf,application/pdf",
  uploadPrimary: "Load class media or paste a lecture link",
  uploadHint: "Host-led session: teacher can drive playback while students discuss in chat.",
  uploadButtonLabel: "Choose Video File",
  chatPlaceholder: "Ask doubts, share checkpoints, raise hand...",
});

function resolveResourceFromUrl(value) {
  // Study rooms borrow the watch/podcast URL rules but allow more "companion"
  // resources because not every class link is directly playable media.
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
  // Live study sessions can mix lecture media with documents like PDFs/TXT notes.
  if (!file) return { valid: false, reason: "No file selected" };
  const mime = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  const isDoc = mime.includes("pdf") || name.endsWith(".pdf") || name.endsWith(".txt");
  if (!mime.startsWith("audio/") && !mime.startsWith("video/") && !isDoc) {
    return { valid: false, reason: "Please choose audio/video/PDF for live study" };
  }
  return { valid: true, reason: "" };
}

const LiveEngine = {
  key: "study",
  label: "LiveEngine",
  ui,
  allowPlaybackSync: true,
  resolveResourceFromUrl,
  validateFile,
  inferContentTypeFromUrl: value => clampContentType(resolveResourceFromUrl(value).contentType, "unknown"),
};

export default LiveEngine;
