import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decrypt, encrypt } from '../src/crypto.js'

const KEY = 'a'.repeat(32)
const OTHER_KEY = 'b'.repeat(32)

describe('crypto encrypt/decrypt', () => {
  it('round-trips a value (enc2)', async () => {
    const ct = await encrypt('super-secret-value', KEY)
    assert.ok(ct.startsWith('enc2:'))
    assert.equal(await decrypt(ct, KEY), 'super-secret-value')
  })

  it('uses a fresh IV — same plaintext encrypts to different ciphertexts', async () => {
    const a = await encrypt('x', KEY)
    const b = await encrypt('x', KEY)
    assert.notEqual(a, b)
  })

  it('does not decrypt under a different key (hashed key-cache is per-secret)', async () => {
    const ct = await encrypt('x', KEY)
    await assert.rejects(() => decrypt(ct, OTHER_KEY))
  })

  it('passes plaintext through when no key is configured', async () => {
    assert.equal(await encrypt('x', undefined), 'x')
    assert.equal(await decrypt('x', KEY), 'x') // no prefix → unchanged
  })

  it('caches consistently across repeated calls with the same secret', async () => {
    const ct = await encrypt('y', KEY)
    // Second derive hits the cache; must still decrypt correctly.
    assert.equal(await decrypt(ct, KEY), 'y')
    assert.equal(await decrypt(await encrypt('z', KEY), KEY), 'z')
  })
})
