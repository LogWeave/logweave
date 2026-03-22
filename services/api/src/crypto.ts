/**
 * AES-256-GCM envelope encryption for sensitive config values.
 *
 * Used to encrypt S3 connector credentials at rest in ClickHouse.
 * If LOGWEAVE_ENCRYPTION_KEY is not set, values are stored in plaintext
 * (acceptable for local dev with MinIO, not for production with real AWS keys).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/** Derive a 32-byte key from the user-provided encryption key via SHA-256. */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/**
 * Encrypt plaintext. Returns base64-encoded string: iv + authTag + ciphertext.
 * Returns the original string unchanged if no encryption key is provided.
 */
export function encrypt(plaintext: string, encryptionKey: string | undefined): string {
  if (!encryptionKey) return plaintext

  const key = deriveKey(encryptionKey)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  // Format: base64(iv + authTag + ciphertext)
  const combined = Buffer.concat([iv, authTag, encrypted])
  return `enc:${combined.toString('base64')}`
}

/**
 * Decrypt a value encrypted by encrypt(). Handles both encrypted (enc:...) and
 * plaintext values for backwards compatibility during migration.
 */
export function decrypt(value: string, encryptionKey: string | undefined): string {
  // Not encrypted — return as-is
  if (!value.startsWith('enc:')) return value

  if (!encryptionKey) {
    throw new Error('Cannot decrypt: LOGWEAVE_ENCRYPTION_KEY is not set')
  }

  const key = deriveKey(encryptionKey)
  const combined = Buffer.from(value.slice(4), 'base64')

  const iv = combined.subarray(0, IV_LENGTH)
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}
