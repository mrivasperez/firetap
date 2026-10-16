import 'fake-indexeddb/auto'
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle, AdapterOptions } from '../../core/types'
import { installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, readRaw, setRules, uniqueBasePath, waitFor } from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []

function recordingLogger() {
  const lines: string[] = []
  const record = (...args: unknown[]) => lines.push(args.join(' '))
  return { lines, logger: { debug: record, warn: record, error: () => {} } }
}
const usedCache = (lines: string[]) => lines.some((l) => l.includes('from the local cache'))

async function openAdapter(basePath: string, extra: Partial<AdapterOptions> = {}) {
  const adapter = await createFirebaseYWebrtcAdapter({
    docId: 'doc',
    firebaseDatabase: createClient(),
    databasePaths: nestedPaths(basePath),
    logger: { warn: () => {}, error: () => {} },
    ...extra,
  })
  open.push(adapter)
  return adapter
}

const text = (adapter: AdapterHandle) => adapter.ydoc.getText('t').toString()
const generation = async (basePath: string) => ((await readRaw(`${basePath}/doc/meta/generation`)) as number) ?? 0

async function writeLog(basePath: string) {
  const writer = await openAdapter(basePath, { persistDebounceMs: 60_000, localCache: false })
  for (let i = 0; i < 40; i++) {
    writer.ydoc.getText('t').insert(text(writer).length, `${i}:${randomBytes(600).toString('hex')}\n`)
    await writer.flush()
  }
  const content = text(writer)
  await writer.disconnect()
  return content
}

/** Merge the log into snapshot `target` with a client that (optionally) caches it, then close it. */
async function mergeTo(basePath: string, target: number, extra: Partial<AdapterOptions> = {}) {
  const merger = await openAdapter(basePath, extra)
  await waitFor(async () => (await generation(basePath)) === target, { message: `generation ${target}` })
  await merger.disconnect()
}

async function corruptCachedSnapshots(basePath: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('firetap', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const store = db.transaction('snapshots', 'readwrite').objectStore('snapshots')
  const keys = await new Promise<IDBValidKey[]>((resolve) => {
    const request = store.getAllKeys()
    request.onsuccess = () => resolve(request.result)
  })
  for (const key of keys.filter((k) => String(k).includes(basePath))) {
    const entry = await new Promise<{ snapshot: Uint8Array }>((resolve) => {
      const request = store.get(key)
      request.onsuccess = () => resolve(request.result)
    })
    store.put({ ...entry, snapshot: new Uint8Array([1, 2, 3, 4, 5]) }, key)
  }
}

describe('local snapshot cache', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(() => closeClients())

  it('reopens a document without downloading its snapshot again', async () => {
    const basePath = uniqueBasePath('cache-hit')
    const content = await writeLog(basePath)
    await mergeTo(basePath, 1)

    const reopen = recordingLogger()
    const a = await openAdapter(basePath, { logger: reopen.logger })
    expect(usedCache(reopen.lines)).toBe(true)
    expect(text(a)).toBe(content)
  })

  it('ignores a cached snapshot that has since been replaced', async () => {
    const basePath = uniqueBasePath('cache-stale')
    await writeLog(basePath)
    await mergeTo(basePath, 1)
    const content = await writeLog(basePath)
    await mergeTo(basePath, 2, { localCache: false })

    const reopen = recordingLogger()
    const a = await openAdapter(basePath, { logger: reopen.logger })
    expect(usedCache(reopen.lines)).toBe(false)
    expect(text(a)).toBe(content)
  }, 60_000)

  it('downloads the snapshot when the cached copy is unreadable', async () => {
    const basePath = uniqueBasePath('cache-corrupt')
    const content = await writeLog(basePath)
    await mergeTo(basePath, 1)
    await corruptCachedSnapshots(basePath)

    const reopen = recordingLogger()
    const a = await openAdapter(basePath, { logger: reopen.logger })
    expect(reopen.lines.some((l) => l.includes('unreadable'))).toBe(true)
    expect(text(a)).toBe(content)
  })

  it('is not used when localCache is false', async () => {
    const basePath = uniqueBasePath('cache-off')
    await writeLog(basePath)
    await mergeTo(basePath, 1)

    const reopen = recordingLogger()
    await openAdapter(basePath, { logger: reopen.logger, localCache: false })
    expect(usedCache(reopen.lines)).toBe(false)
  })
})
