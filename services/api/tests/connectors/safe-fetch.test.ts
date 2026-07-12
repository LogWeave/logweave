import assert from 'node:assert/strict'
import { type AddressInfo, createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import {
  assertAddressesAllowed,
  isBlockedHostname,
  isInternalIp,
  SsrfBlockedError,
  safeFetch,
} from '../../src/connectors/safe-fetch.js'

// ---------------------------------------------------------------------------
// isInternalIp
// ---------------------------------------------------------------------------

describe('isInternalIp', () => {
  it('blocks IPv4 loopback, private, link-local, and CGNAT ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1', // CGNAT
      '224.0.0.1', // multicast
    ]) {
      assert.equal(isInternalIp(ip), true, `${ip} should be internal`)
    }
  })

  it('allows public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      assert.equal(isInternalIp(ip), false, `${ip} should be public`)
    }
  })

  it('blocks IPv6 loopback, link-local, unique-local, and mapped internal', () => {
    for (const ip of [
      '::1',
      '::',
      'fe80::1',
      'febf::1', // link-local upper boundary
      'fc00::1',
      'fd12:3456::1',
      'ff02::1', // multicast
      '::ffff:127.0.0.1', // IPv4-mapped loopback (dotted)
      '::ffff:10.0.0.1', // IPv4-mapped private (dotted)
    ]) {
      assert.equal(isInternalIp(ip), true, `${ip} should be internal`)
    }
  })

  it('blocks IPv4-mapped IPv6 written in hex-colon notation (regression)', () => {
    // ::ffff:7f00:1 == 127.0.0.1, ::ffff:a9fe:a9fe == 169.254.169.254 (metadata),
    // ::ffff:0a00:1 == 10.0.0.1 — these must not slip past as "public".
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0a00:1', '[::ffff:7f00:1]']) {
      assert.equal(isInternalIp(ip), true, `${ip} should be internal`)
    }
  })

  it('allows public IPv6 and IPv4-mapped public addresses', () => {
    assert.equal(isInternalIp('2606:4700:4700::1111'), false)
    assert.equal(isInternalIp('2001:4860:4860::8888'), false)
    assert.equal(isInternalIp('fec0::1'), false) // just outside fe80::/10
    assert.equal(isInternalIp('::ffff:8.8.8.8'), false) // mapped public
    assert.equal(isInternalIp('::ffff:0808:0808'), false) // mapped public, hex form
  })

  it('treats junk as internal (fail closed)', () => {
    assert.equal(isInternalIp('not-an-ip'), true)
    assert.equal(isInternalIp(''), true)
  })
})

// ---------------------------------------------------------------------------
// assertAddressesAllowed — the resolve-time guard (rebinding defense)
// ---------------------------------------------------------------------------

describe('assertAddressesAllowed', () => {
  it('throws when a hostname resolves to an internal address', () => {
    assert.throws(
      () => assertAddressesAllowed('evil.example.com', [{ address: '10.0.0.5' }], new Set()),
      SsrfBlockedError,
    )
  })

  it('throws if any resolved address is internal (mixed result)', () => {
    assert.throws(
      () =>
        assertAddressesAllowed(
          'evil.example.com',
          [{ address: '93.184.216.34' }, { address: '169.254.169.254' }],
          new Set(),
        ),
      SsrfBlockedError,
    )
  })

  it('allows a hostname that resolves only to public addresses', () => {
    assert.doesNotThrow(() =>
      assertAddressesAllowed('logs.example.com', [{ address: '93.184.216.34' }], new Set()),
    )
  })

  it('permits an internal resolution for an explicitly allowlisted host', () => {
    assert.doesNotThrow(() =>
      assertAddressesAllowed('loki', [{ address: '10.0.0.5' }], new Set(['loki'])),
    )
  })

  it('fails closed when a hostname resolves to nothing', () => {
    assert.throws(() => assertAddressesAllowed('nx.example.com', [], new Set()), SsrfBlockedError)
  })
})

// ---------------------------------------------------------------------------
// isBlockedHostname
// ---------------------------------------------------------------------------

describe('isBlockedHostname', () => {
  it('blocks localhost and internal IP literals', () => {
    assert.equal(isBlockedHostname('localhost'), true)
    assert.equal(isBlockedHostname('app.localhost'), true)
    assert.equal(isBlockedHostname('127.0.0.1'), true)
    assert.equal(isBlockedHostname('169.254.169.254'), true)
    assert.equal(isBlockedHostname('[::1]'), true)
  })

  it('allows public hostnames and IPs', () => {
    assert.equal(isBlockedHostname('logs.example.com'), false)
    assert.equal(isBlockedHostname('8.8.8.8'), false)
  })
})

// ---------------------------------------------------------------------------
// safeFetch (integration against a local server)
// ---------------------------------------------------------------------------

describe('safeFetch', () => {
  let server: Server
  let port: number
  // What the test server should do on the next request.
  let handler: (path: string) => { status: number; headers?: Record<string, string>; body?: string }

  before(async () => {
    handler = () => ({ status: 200, body: '{"ok":true}' })
    server = createServer((req, res) => {
      const { status, headers, body } = handler(req.url ?? '/')
      res.writeHead(status, headers)
      res.end(body ?? '')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('blocks a request to an internal address by default', async () => {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), SsrfBlockedError)
  })

  it('allows an internal host that is explicitly allowlisted', async () => {
    handler = () => ({ status: 200, body: '{"ok":true}' })
    const res = await safeFetch(`http://127.0.0.1:${port}/`, {
      allowedHosts: new Set(['127.0.0.1']),
    })
    assert.equal(res.ok, true)
    assert.deepEqual(await res.json(), { ok: true })
  })

  it('rejects unsupported protocols', async () => {
    await assert.rejects(safeFetch('file:///etc/passwd'), SsrfBlockedError)
  })

  it('re-validates redirects and blocks a redirect to an internal IP', async () => {
    // First hop is allowlisted; it 302s to an internal IP that is NOT allowlisted.
    handler = () => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    })
    await assert.rejects(
      safeFetch(`http://127.0.0.1:${port}/`, { allowedHosts: new Set(['127.0.0.1']) }),
      SsrfBlockedError,
    )
  })

  it('propagates non-2xx status without throwing', async () => {
    handler = () => ({ status: 404, body: 'nope' })
    const res = await safeFetch(`http://127.0.0.1:${port}/`, {
      allowedHosts: new Set(['127.0.0.1']),
    })
    assert.equal(res.ok, false)
    assert.equal(res.status, 404)
    assert.equal(await res.text(), 'nope')
  })
})
