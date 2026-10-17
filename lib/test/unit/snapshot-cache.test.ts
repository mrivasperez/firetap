import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { SnapshotCache, clearLocalCache } from '../../utils/snapshot-cache'

const entry = (snapshotKey: string) => ({ snapshotKey, storedBytes: 3, snapshot: new Uint8Array([1, 2, 3]) })

describe('clearLocalCache', () => {
  it('deletes every cached document, and caching works again afterwards', async () => {
    const a = new SnapshotCache('a')
    const b = new SnapshotCache('b')
    await a.put(entry('1-a'))
    await b.put(entry('1-b'))

    await clearLocalCache()
    expect(await a.get()).toBeNull()
    expect(await b.get()).toBeNull()

    await a.put(entry('2-a'))
    expect((await a.get())?.snapshotKey).toBe('2-a')
  })

  it('is not blocked by another tab that has the cache open', async () => {
    const here = new SnapshotCache('doc')
    await here.put(entry('1-x'))

    vi.resetModules()
    const otherTab = await import('../../utils/snapshot-cache')
    const there = new otherTab.SnapshotCache('doc')
    expect((await there.get())?.snapshotKey).toBe('1-x')

    await clearLocalCache()
    expect(await there.get()).toBeNull()
  })
})
