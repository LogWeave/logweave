import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WatchStore } from '../../src/watches/watch-store.js'

describe('WatchStore', () => {
  it('add + list returns the watched templateId', async () => {
    const store = new WatchStore()
    const added = await store.add('t1', 'tmpl-1')
    assert.equal(added, true)
    assert.deepEqual(store.list('t1'), ['tmpl-1'])
  })

  it('add with templateText stores it for retrieval', async () => {
    const store = new WatchStore()
    await store.add('t1', 'tmpl-1', 'Error in {service}')
    assert.equal(store.getTemplateText('t1', 'tmpl-1'), 'Error in {service}')
  })

  it('remove returns true if present, false if not', async () => {
    const store = new WatchStore()
    await store.add('t1', 'tmpl-1')
    assert.equal(await store.remove('t1', 'tmpl-1'), true)
    assert.equal(await store.remove('t1', 'tmpl-1'), false)
    assert.deepEqual(store.list('t1'), [])
  })

  it('has returns correct boolean', async () => {
    const store = new WatchStore()
    assert.equal(store.has('t1', 'tmpl-1'), false)
    await store.add('t1', 'tmpl-1')
    assert.equal(store.has('t1', 'tmpl-1'), true)
  })

  it('add is idempotent — second add returns false', async () => {
    const store = new WatchStore()
    assert.equal(await store.add('t1', 'tmpl-1'), true)
    assert.equal(await store.add('t1', 'tmpl-1'), false)
    assert.deepEqual(store.list('t1'), ['tmpl-1'])
  })

  it('list returns empty array for unknown tenant', () => {
    const store = new WatchStore()
    assert.deepEqual(store.list('unknown'), [])
  })

  it('tenant isolation — tenant A watches are separate from tenant B', async () => {
    const store = new WatchStore()
    await store.add('t-a', 'tmpl-1')
    await store.add('t-b', 'tmpl-2')
    assert.deepEqual(store.list('t-a'), ['tmpl-1'])
    assert.deepEqual(store.list('t-b'), ['tmpl-2'])
    assert.equal(store.has('t-a', 'tmpl-2'), false)
  })

  it('getWatchedByTenant returns map of all tenants and their watched sets', async () => {
    const store = new WatchStore()
    await store.add('t-a', 'tmpl-1')
    await store.add('t-a', 'tmpl-2')
    await store.add('t-b', 'tmpl-3')

    const all = store.getWatchedByTenant()
    assert.equal(all.size, 2)
    const setA = all.get('t-a')
    assert.ok(setA)
    assert.equal(setA.size, 2)
    assert.ok(setA.has('tmpl-1'))
    assert.ok(setA.has('tmpl-2'))
  })

  it('enforces per-tenant watch limit of 100', async () => {
    const store = new WatchStore({ maxPerTenant: 100 })
    for (let i = 0; i < 100; i++) {
      assert.equal(await store.add('t1', `tmpl-${i}`), true)
    }
    // 101st should fail
    const result = await store.add('t1', 'tmpl-overflow')
    assert.equal(result, 'limit_exceeded')
    assert.equal(store.list('t1').length, 100)
  })

  it('remove from unknown tenant is no-op', async () => {
    const store = new WatchStore()
    assert.equal(await store.remove('unknown', 'tmpl-1'), false)
  })

  it('list returns sorted templateIds', async () => {
    const store = new WatchStore()
    await store.add('t1', 'c-template')
    await store.add('t1', 'a-template')
    await store.add('t1', 'b-template')
    assert.deepEqual(store.list('t1'), ['a-template', 'b-template', 'c-template'])
  })
})
