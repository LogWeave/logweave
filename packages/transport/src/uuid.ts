import { randomBytes } from 'node:crypto'

/**
 * Generate a UUIDv7 — timestamp-sortable, globally unique. Assigned to each
 * event at spool-insert (#268/#269) as the source `event_id` dedup key.
 * Layout: 48-bit unix ms | 4-bit version (7) | 12-bit rand_a | 2-bit variant | 62-bit rand_b
 */
export function uuidv7(): string {
  const now = Date.now()
  const rand = randomBytes(10)
  const buf = Buffer.alloc(16)

  // Bytes 0-5: 48-bit timestamp (big-endian)
  buf.writeUIntBE(now, 0, 6)
  // Bytes 6-7: version (0111) + 12 bits of randomness
  buf.writeUInt8(0x70 | (rand.readUInt8(0) & 0x0f), 6)
  buf.writeUInt8(rand.readUInt8(1), 7)
  // Bytes 8-15: variant (10) + 62 bits of randomness
  buf.writeUInt8(0x80 | (rand.readUInt8(2) & 0x3f), 8)
  rand.copy(buf, 9, 3, 10)

  const hex = buf.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
