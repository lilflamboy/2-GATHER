/**
 * Handles temporary document upload and download endpoints for shared reading.
 * Uploads are base64-encoded PDFs stored in memory with a TTL, which is why
 * the JSON body limit is set above the actual file-size limit to account for
 * base64 expansion during transport.
 */
'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const {
  upsertDocumentUpload,
  getUploadedDocumentById,
} = require('../services/document.service.js')
const { listRoomParticipantsByCode } =
  require('../services/room.service.js')
const { buildDocumentSignature } =
  require('../utils/helpers.js')
const { rooms } =
  require('../sockets/roomStore.js')

/**
 * POST /api/uploads/document
 * Validates and stores a temporary room-scoped PDF upload.
 * @requires auth - Yes.
 * @body {string} roomCode - The room the document belongs to.
 * @body {string} fileName - The uploaded file name.
 * @body {string} mimeType - The claimed MIME type.
 * @body {string} base64Data - The base64-encoded PDF payload.
 * @returns {object} - Upload metadata including the temporary document URL, signature, and expiry time.
 */
router.post('/uploads/document', requireHttpAuth, async (req, res) => {
  try {
    const roomCode = String(req.body?.roomCode || '').trim().toUpperCase()
    const fileName = String(req.body?.fileName || '').trim()
    const mimeType = String(req.body?.mimeType || '').trim()
    const base64Data = String(req.body?.base64Data || '').trim()
    // Validate the required room and payload fields before doing membership or storage work.
    if (!roomCode) {
      return res.status(400).json({ error: 'roomCode is required' })
    }
    if (!base64Data) {
      return res.status(400).json({ error: 'base64Data is required' })
    }

    // Security fix: only current or historical room participants may upload room documents.
    const liveRoom = rooms.get(roomCode)
    let canAccessRoom = !!(liveRoom && liveRoom.users.has(req.authUser.uid))
    if (!canAccessRoom) {
      const participants = await listRoomParticipantsByCode(roomCode)
      canAccessRoom = participants.some((row) => row.userId === req.authUser.uid)
    }
    if (!canAccessRoom) {
      return res.status(403).json({ error: 'You do not have access to this room document' })
    }

    // Store the temporary upload and return the embed-friendly metadata the client needs.
    const uploaded = upsertDocumentUpload({
      ownerUid: req.authUser.uid,
      roomCode,
      fileName,
      mimeType,
      base64Data,
    })

    const baseUrl = `${req.protocol}://${req.get('host')}`
    return res.json({
      id: uploaded.id,
      url: `${baseUrl}/api/uploads/document/${uploaded.id}`,
      mimeType: uploaded.mimeType,
      fileName: uploaded.fileName,
      bytes: uploaded.bytes,
      signature: buildDocumentSignature(uploaded.fileName, uploaded.bytes),
      expiresAt: uploaded.expiresAt,
    })
  } catch (error) {
    const status = error.status || 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not upload document' : (error.message || 'Could not upload document'),
    })
  }
})

/**
 * GET /api/uploads/document/:documentId
 * Streams a temporary uploaded document back to an authorized room participant.
 * @requires auth - Yes.
 * @body {none} - No request body.
 * @returns {buffer} - The raw PDF bytes plus headers that support inline browser embedding.
 */
router.get('/uploads/document/:documentId', requireHttpAuth, async (req, res) => {
  const documentId = String(req.params.documentId || '').trim()
  const row = getUploadedDocumentById(documentId)
  if (!row) return res.status(404).send('Document not found or expired')

  // Security fix: downloads require owner access or room participation, not just knowledge of the ID.
  let canAccessDocument = row.ownerUid === req.authUser.uid
  if (!canAccessDocument && row.roomCode) {
    const liveRoom = rooms.get(String(row.roomCode || '').trim().toUpperCase())
    canAccessDocument = !!(liveRoom && liveRoom.users.has(req.authUser.uid))
    if (!canAccessDocument) {
      const participants = await listRoomParticipantsByCode(row.roomCode)
      canAccessDocument = participants.some((participant) => participant.userId === req.authUser.uid)
    }
  }
  if (!canAccessDocument) {
    return res.status(403).send('You do not have access to this document')
  }

  try {
    const buffer = Buffer.from(row.base64Data, 'base64')
    // Set headers for safe inline PDF embedding and expose document metadata to the client.
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Type, Content-Length, Content-Disposition, X-Document-Signature, X-Document-Name, X-Document-Size'
    )
    res.setHeader('Content-Type', row.mimeType || 'application/octet-stream')
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Content-Disposition', `inline; filename=\"${row.fileName || 'document'}\"`)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('X-Document-Signature', buildDocumentSignature(row.fileName, row.bytes))
    res.setHeader('X-Document-Name', row.fileName || 'document.pdf')
    res.setHeader('X-Document-Size', String(Math.max(0, Number(row.bytes) || 0)))
    return res.send(buffer)
  } catch {
    return res.status(500).send('Could not serve document')
  }
})

module.exports = router
