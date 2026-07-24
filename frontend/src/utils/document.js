/**
 * Helpers for 2-GATHER's co-reading document flow. Shared documents in 2-GATHER
 * are usually PDFs that room members load together, so these helpers normalize
 * names, generate signatures, and recognize backend upload URLs.
 */

/**
 * Guesses a document filename from a URL path and falls back to a default PDF name.
 * @param {string} value - Candidate document URL.
 * @returns {string} Decoded filename or `shared-document.pdf` when none is available.
 */
const guessDocumentFileName = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(segment || "").trim() || "shared-document.pdf";
  } catch {
    return "shared-document.pdf";
  }
};

/**
 * Builds a lightweight document signature from filename and file size.
 * This signature is used as a cheap deduplication key for shared document state.
 * @param {string} fileName - Document filename.
 * @param {number} fileSize - Document size in bytes.
 * @returns {string} Stable `name:size` signature string.
 */
const buildDocumentSignature = (fileName, fileSize) => `${String(fileName || "shared-document.pdf").trim()}:${Math.max(0, Math.floor(Number(fileSize) || 0))}`;

/**
 * Tests whether a URL points at 2-GATHER's temporary shared-upload endpoint.
 * Shared upload URLs use the `/api/uploads/document/:documentId` backend path.
 * @param {string} value - Candidate URL string.
 * @returns {boolean} True when the URL matches the shared upload route pattern.
 */
const isSharedUploadUrl = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    return /\/api\/uploads\/document\/[^/]+$/i.test(parsed.pathname || "");
  } catch {
    return false;
  }
};

export { guessDocumentFileName, buildDocumentSignature, isSharedUploadUrl };
