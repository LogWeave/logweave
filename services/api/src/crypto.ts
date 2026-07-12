/**
 * AES-256-GCM envelope encryption for sensitive config values.
 *
 * Used to encrypt S3 connector credentials at rest in ClickHouse.
 * If LOGWEAVE_ENCRYPTION_KEY is not set, values are stored in plaintext
 * (acceptable for local dev only, not for production with real AWS keys).
 *
 * Versioned format:
 *   - `enc2:` — current. Key derived via HKDF-SHA256 with domain-separation label
 *     `logweave-config-encryption`. Defends against weak passphrases by stretching
 *     through HKDF (still not a password KDF — operators must use a high-entropy key).
 *   - `enc:`  — legacy. Key derived via raw SHA-256(secret). Read-only path; we
 *     decrypt and migrate forward on next write. Not used for new ciphertexts.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdf as hkdfCb,
  randomBytes,
} from 'node:crypto'
import { promisify } from 'node:util'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32

const PREFIX_V2 = 'enc2:'
const PREFIX_V1 = 'enc:'

const hkdfAsync = promisify(hkdfCb)

// Cache derived keys by a hash of the secret, never the plaintext secret itself,
// so the master key is not retained as a Map key for the process lifetime.
const v2KeyCache = new Map<string, Buffer>()

async function deriveKeyV2(secret: string): Promise<Buffer> {
  const cacheKey = createHash('sha256').update(secret).digest('hex')
  const cached = v2KeyCache.get(cacheKey)
  if (cached) return cached
  const ikm = Buffer.from(secret, 'utf-8')
  const derived = await hkdfAsync(
    'sha256',
    ikm,
    Buffer.alloc(0),
    'logweave-config-encryption',
    KEY_LENGTH,
  )
  const key = Buffer.from(derived)
  v2KeyCache.set(cacheKey, key)
  return key
}

function deriveKeyV1(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/**
 * Encrypt plaintext. Returns base64-encoded string with `enc2:` prefix.
 * Returns the original string unchanged if no encryption key is provided.
 */
export async function encrypt(
  plaintext: string,
  encryptionKey: string | undefined,
): Promise<string> {
  if (!encryptionKey) return plaintext

  const key = await deriveKeyV2(encryptionKey)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  const combined = Buffer.concat([iv, authTag, encrypted])
  return `${PREFIX_V2}${combined.toString('base64')}`
}

/**
 * Decrypt a value encrypted by encrypt(). Handles plaintext (no prefix), legacy
 * `enc:` (SHA-256 derived key), and current `enc2:` (HKDF derived key).
 */
export async function decrypt(value: string, encryptionKey: string | undefined): Promise<string> {
  if (!value.startsWith(PREFIX_V1) && !value.startsWith(PREFIX_V2)) return value

  if (!encryptionKey) {
    throw new Error('Cannot decrypt: LOGWEAVE_ENCRYPTION_KEY is not set')
  }

  const isV2 = value.startsWith(PREFIX_V2)
  const prefixLen = isV2 ? PREFIX_V2.length : PREFIX_V1.length
  const key = isV2 ? await deriveKeyV2(encryptionKey) : deriveKeyV1(encryptionKey)
  const combined = Buffer.from(value.slice(prefixLen), 'base64')

  const iv = combined.subarray(0, IV_LENGTH)
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}
