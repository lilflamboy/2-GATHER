import {
  normalizeUrl,
  isHttpUrl,
  isPdfUrl,
  clampContentType,
} from "./engineUtils.js";

const ui = Object.freeze({
  resourcePlaceholder: "Paste a direct PDF URL",
  resourceHelp: "PDF links are tracked in-room so everyone opens the same shared document.",
  fileAccept: ".pdf,application/pdf",
  uploadPrimary: "Load a PDF or paste a shareable PDF link",
  uploadHint: "Upload a PDF for room sharing or paste a direct PDF URL for instant sync.",
  uploadButtonLabel: "Choose PDF",
  chatPlaceholder: "Discuss the page, passage, or annotation...",
});

function resolveResourceFromUrl(value) {
  // Reading mode only treats direct PDF links as syncable room sources.
  const raw = normalizeUrl(value);
  if (!raw) {
    return { valid: true, reason: "", normalizedUrl: "", contentType: "unknown", syncKind: "none" };
  }
  if (!isHttpUrl(raw)) {
    return { valid: false, reason: "Enter a valid http(s) link", normalizedUrl: "", contentType: "unknown", syncKind: "none" };
  }
  if (isPdfUrl(raw)) {
    return {
      valid: true,
      reason: "",
      normalizedUrl: raw,
      contentType: "pdf",
      syncKind: "reading",
    };
  }
  return {
    valid: false,
    reason: "Please paste a direct PDF URL",
    normalizedUrl: "",
    contentType: "unknown",
    syncKind: "none",
  };
}

function validateFile(file) {
  // Browsers are inconsistent with PDF MIME types, so fall back to filename too.
  if (!file) return { valid: false, reason: "No file selected" };
  const mime = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  const looksPdf = mime.includes("pdf") || name.endsWith(".pdf");
  if (!looksPdf) {
    return { valid: false, reason: "Please choose a PDF file" };
  }
  return { valid: true, reason: "" };
}

const ReadingEngine = {
  key: "reading",
  label: "ReadingEngine",
  ui,
  // Co-reading syncs page state rather than media playback.
  allowPlaybackSync: false,
  resolveResourceFromUrl,
  validateFile,
  inferContentTypeFromUrl: value => clampContentType(resolveResourceFromUrl(value).contentType, "unknown"),
};

export default ReadingEngine;
