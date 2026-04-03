/**
 * Manages temporary document uploads for shared reading sessions.
 * Documents are stored in the in-memory store with a short TTL because
 * they are meant for transient room sharing rather than durable storage.
 */
'use strict'

const { memoryStore } =
  require('../models/memoryStore.js')
const { sanitizeUploadFileName } =
  require('../utils/sanitize.js')
const { normalizeDocumentMimeType } =
  require('../utils/normalize.js')
const { createDocumentUploadId } =
  require('../utils/helpers.js')
const {
  MAX_DOCUMENT_UPLOAD_BYTES,
  DOCUMENT_UPLOAD_TTL_MS,
} = require('../config/constants.js')

/**
 * Removes expired uploads from the in-memory document store.
 * Pruning keeps temporary room documents from lingering in memory past
 * their TTL and is called before new uploads are accepted.
 * @returns {void} Nothing is returned.
 */
function pruneExpiredDocumentUploads() {
  const now = Date.now()
  // Sweep the upload map and drop anything whose TTL has already elapsed.
  memoryStore.uploadedDocuments.forEach((item, id) => {
    const expiresAtMs = item?.expiresAt ? new Date(item.expiresAt).getTime() : 0
    if (!expiresAtMs || expiresAtMs <= now) {
      memoryStore.uploadedDocuments.delete(id)
    }
  })
}

/**
 * Loads a temporary uploaded document by ID if it is still valid.
 * Reads also enforce expiry so stale uploads are deleted the first time
 * they are encountered after timing out.
 * @param {string} documentId - The transient upload identifier.
 * @returns {object|null} The upload row when it exists and is still valid.
 */
function getUploadedDocumentById(documentId) {
  const id = String(documentId || "").trim()
  if (!id) return null
  const row = memoryStore.uploadedDocuments.get(id)
  if (!row) return null
  // Auto-delete expired rows on read so consumers never receive stale payloads.
  if (!row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) {
    memoryStore.uploadedDocuments.delete(id)
    return null
  }
  return row
}

/**
 * Validates and stores a temporary document upload in memory.
 * The flow checks owner identity, filename safety, MIME type, base64 payload
 * integrity, byte size, and then assigns a TTL-backed upload record.
 * @param {object} payload - The raw upload metadata and file contents.
 * @param {string} payload.ownerUid - The authenticated uploader's UID.
 * @param {string} [payload.roomCode] - The room that can access the document.
 * @param {string} payload.fileName - The original file name from the client.
 * @param {string} payload.mimeType - The claimed MIME type.
 * @param {string} payload.base64Data - The base64-encoded PDF payload.
 * @returns {object} The normalized upload row stored in memory.
 */
function upsertDocumentUpload({ ownerUid, roomCode = "", fileName, mimeType, base64Data }) {
  // Uploaded PDFs are short-lived and room-scoped, so we store them in memory
  // with a TTL instead of introducing a heavier object-storage dependency here.
  const normalizedOwnerUid = String(ownerUid || "").trim()
  if (!normalizedOwnerUid) throw new Error("Missing owner uid")
  const normalizedRoomCode = String(roomCode || "").trim().toUpperCase().slice(0, 32)
  const normalizedName = sanitizeUploadFileName(fileName)
  const normalizedMime = normalizeDocumentMimeType(mimeType, normalizedName)
  if (!normalizedMime) throw new Error("Unsupported document type")

  const normalizedBase64 = String(base64Data || "").trim()
  if (!normalizedBase64) throw new Error("Document payload is empty")
  if (!/^[a-zA-Z0-9+/=]+$/.test(normalizedBase64)) throw new Error("Invalid base64 payload")

  // Buffer.byteLength(..., "base64") converts the transport string into actual file bytes.
  const bytes = Buffer.byteLength(normalizedBase64, "base64")
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("Invalid document payload")
  if (bytes > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new Error(`Document exceeds ${Math.round(MAX_DOCUMENT_UPLOAD_BYTES / (1024 * 1024))}MB limit`)
  }

  // Clear expired uploads before inserting a fresh row so the map stays bounded.
  pruneExpiredDocumentUploads()
  const id = createDocumentUploadId()
  const createdAt = new Date()
  const expiresAt = new Date(Date.now() + DOCUMENT_UPLOAD_TTL_MS)
  const row = {
    id,
    ownerUid: normalizedOwnerUid,
    roomCode: normalizedRoomCode,
    fileName: normalizedName,
    mimeType: normalizedMime,
    bytes,
    base64Data: normalizedBase64,
    createdAt,
    expiresAt,
  }
  memoryStore.uploadedDocuments.set(id, row)
  return row
}

module.exports = {
  pruneExpiredDocumentUploads,
  getUploadedDocumentById,
  upsertDocumentUpload,
}
