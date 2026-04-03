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

function pruneExpiredDocumentUploads() {
  const now = Date.now()
  memoryStore.uploadedDocuments.forEach((item, id) => {
    const expiresAtMs = item?.expiresAt ? new Date(item.expiresAt).getTime() : 0
    if (!expiresAtMs || expiresAtMs <= now) {
      memoryStore.uploadedDocuments.delete(id)
    }
  })
}

function getUploadedDocumentById(documentId) {
  const id = String(documentId || "").trim()
  if (!id) return null
  const row = memoryStore.uploadedDocuments.get(id)
  if (!row) return null
  if (!row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) {
    memoryStore.uploadedDocuments.delete(id)
    return null
  }
  return row
}

function upsertDocumentUpload({ ownerUid, fileName, mimeType, base64Data }) {
  // Uploaded PDFs are short-lived and room-scoped, so we store them in memory
  // with a TTL instead of introducing a heavier object-storage dependency here.
  const normalizedOwnerUid = String(ownerUid || "").trim()
  if (!normalizedOwnerUid) throw new Error("Missing owner uid")
  const normalizedName = sanitizeUploadFileName(fileName)
  const normalizedMime = normalizeDocumentMimeType(mimeType, normalizedName)
  if (!normalizedMime) throw new Error("Unsupported document type")

  const normalizedBase64 = String(base64Data || "").trim()
  if (!normalizedBase64) throw new Error("Document payload is empty")
  if (!/^[a-zA-Z0-9+/=]+$/.test(normalizedBase64)) throw new Error("Invalid base64 payload")

  const bytes = Buffer.byteLength(normalizedBase64, "base64")
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("Invalid document payload")
  if (bytes > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new Error(`Document exceeds ${Math.round(MAX_DOCUMENT_UPLOAD_BYTES / (1024 * 1024))}MB limit`)
  }

  pruneExpiredDocumentUploads()
  const id = createDocumentUploadId()
  const createdAt = new Date()
  const expiresAt = new Date(Date.now() + DOCUMENT_UPLOAD_TTL_MS)
  const row = {
    id,
    ownerUid: normalizedOwnerUid,
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
