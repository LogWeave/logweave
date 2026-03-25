import { hkdf as hkdfCb, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const hkdfAsync = promisify(hkdfCb)

// scrypt params per OWASP recommendation: N=32768 (2^15), r=8, p=1
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SALT_LENGTH = 16
const KEY_LENGTH = 64

function scryptAsync(password: string | Buffer, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

const MIN_PASSWORD_LENGTH = 12

/**
 * Hash a password with scrypt. Returns "salt_hex:hash_hex".
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scryptAsync(password, salt, KEY_LENGTH)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/**
 * Verify a password against a stored "salt_hex:hash_hex" string.
 * Uses timing-safe comparison.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false

  const salt = Buffer.from(saltHex, 'hex')
  const storedHash = Buffer.from(hashHex, 'hex')
  const derived = await scryptAsync(password, salt, KEY_LENGTH)

  return timingSafeEqual(derived, storedHash)
}

/**
 * Run scrypt against a dummy value (timing normalization for nonexistent users).
 */
export async function dummyVerify(): Promise<void> {
  const salt = Buffer.alloc(SALT_LENGTH)
  await scryptAsync('dummy', salt, KEY_LENGTH)
}

/**
 * Validate password meets minimum requirements.
 * Returns null if valid, error message if invalid.
 */
export function validatePasswordPolicy(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  return null
}

/**
 * Derive domain-separated keys from a single encryption key using HKDF.
 */
export async function deriveKeys(encryptionKey: string): Promise<{
  sessionSigningKey: Buffer
  totpEncryptionKey: Buffer
  csrfTokenKey: Buffer
}> {
  const ikm = Buffer.from(encryptionKey, 'utf-8')

  const [sessionSigningKey, totpEncryptionKey, csrfTokenKey] = await Promise.all([
    hkdfAsync('sha256', ikm, Buffer.alloc(0), 'logweave-session-hmac', 32),
    hkdfAsync('sha256', ikm, Buffer.alloc(0), 'logweave-totp-encryption', 32),
    hkdfAsync('sha256', ikm, Buffer.alloc(0), 'logweave-csrf-token', 32),
  ])

  return {
    sessionSigningKey: Buffer.from(sessionSigningKey),
    totpEncryptionKey: Buffer.from(totpEncryptionKey),
    csrfTokenKey: Buffer.from(csrfTokenKey),
  }
}

/**
 * Generate recovery codes: 10 random 128-bit values, displayed as xxxx-xxxx-xxxx-xxxx.
 * Returns { display: string[], hashed: string[] }.
 */
export async function generateRecoveryCodes(): Promise<{
  display: string[]
  hashed: string[]
}> {
  const codes: string[] = []
  const hashed: string[] = []

  for (let i = 0; i < 10; i++) {
    const raw = randomBytes(16).toString('hex') // 128 bits
    const display = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`
    codes.push(display)
    const hash = await hashPassword(raw.slice(0, 16)) // hash the first 16 hex chars
    hashed.push(hash)
  }

  return { display: codes, hashed }
}
