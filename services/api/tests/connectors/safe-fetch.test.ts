import assert from 'node:assert/strict'
import { type AddressInfo, createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import {
  isBlockedHostname,
  isInternalIp,
  safeFetch,
  SsrfBlockedError,
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
      'feba::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1', // multicast
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1', // IPv4-mapped private
    ]) {
      assert.equal(isInternalIp(ip), true, `${ip} should be internal`)
    }
  })

  it('allows public IPv6 and treats junk as internal (fail closed)', () => {
    assert.equal(isInternalIp('2606:4700:4700::1111'), false)
    assert.equal(isInternalIp('2001:4860:4860::8888'), false)
    assert.equal(isInternalIp('not-an-ip'), true)
    assert.equal(isInternalIp(''), true)
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
