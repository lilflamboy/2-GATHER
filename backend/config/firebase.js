'use strict'

/**
 * Firebase Admin SDK bootstrap for the Lumiere backend. This singleton is used
 * for verifying Firebase ID tokens and any future privileged server-side
 * Firebase operations. It must be initialized exactly once at startup, and it
 * supports either inline service-account JSON or a filesystem path to the same
 * credentials.
 */

const admin = require('firebase-admin')

// Credentials can come from inline JSON in env or from a path-based service
// account file, which keeps local and deployed environments flexible.
let serviceAccount
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Parse inline JSON defensively so bad credential data fails fast at boot
  // instead of surfacing later as confusing auth verification errors.
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  } catch (err) {
    console.error('[lumiere]', 'Bad FIREBASE_SERVICE_ACCOUNT JSON:', err.message)
    process.exit(1)
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  // Path-based credentials are useful when the runtime mounts a secret file
  // instead of injecting the full JSON blob into the environment.
  serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
}

if (!admin.apps.length) {
  // Use explicit service-account credentials when provided; otherwise fall
  // back to application-default credentials for cloud-managed environments.
  admin.initializeApp(
    serviceAccount
      ? { credential: admin.credential.cert(serviceAccount) }
      : { credential: admin.credential.applicationDefault() }
  )
}

// initializeApp() registers the Admin SDK globally so every require() gets the
// same verified app instance instead of creating competing duplicates.
module.exports = admin
