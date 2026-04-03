'use strict'

const express = require('express')

const router = express.Router()

const { requireHttpAuth } =
  require('../middleware/auth.js')
const {
  upsertDocumentUpload,
  getUploadedDocumentById,
} = require('../services/document.service.js')
const { buildDocumentSignature } =
  require('../utils/helpers.js')

router.post('/uploads/document', requireHttpAuth, async (req, res) => {
  try {
    const fileName = String(req.body?.fileName || '').trim()
    const mimeType = String(req.body?.mimeType || '').trim()
    const base64Data = String(req.body?.base64Data || '').trim()
    if (!base64Data) {
      return res.status(400).json({ error: 'base64Data is required' })
    }

    const uploaded = upsertDocumentUpload({
      ownerUid: req.authUser.uid,
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
    return res.status(400).json({ error: error.message || 'Could not upload document' })
  }
})

router.get('/uploads/document/:documentId', async (req, res) => {
  const documentId = String(req.params.documentId || '').trim()
  const row = getUploadedDocumentById(documentId)
  if (!row) return res.status(404).send('Document not found or expired')

  try {
    const buffer = Buffer.from(row.base64Data, 'base64')
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
