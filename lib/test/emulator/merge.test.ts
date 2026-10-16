import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle, AdapterOptions } from '../../core/types'
import { LoadError } from '../../firebase/document-store'
import { installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import {
  closeClients,
  createClient,
  nestedPaths,
  readRaw,
  setRules,
  storedDoc,
  uniqueBasePath,
  waitFor,
  writeRaw,
} from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []
const quiet = { warn: () => {}, error: () => {} }

async function openAdapter(basePath: string, extra: Partial<AdapterOptions> = {}) {
  const adapter = await createFirebaseYWebrtcAdapter({
    docId: 'doc',
    firebaseDatabase: createClient(),
    databasePaths: nestedPaths(basePath),
    logger: quiet,
    ...extra,
  })
  open.push(adapter)
  return adapter
}

const text = (adapter: AdapterHandle) => adapter.ydoc.getText('t').toString()
const logKeys = async (basePath: string) =>
  Object.keys(((await readRaw(`${basePath}/doc/updates`)) as object | null) ?? {})

async function growLog(basePath: string, entries = 40) {
  const writer = await openAdapter(basePath, { persistDebounceMs: 60_000 })
  for (let i = 0; i < entries; i++) {
    writer.ydoc.getText('t').insert(text(writer).length, `${i}:${randomBytes(600).toString('hex')}\n`)
    await writer.flush()
  }
  const expected = text(writer)
  await writer.disconnect()
  return expected
}

describe('merging the log into snapshots', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(() => closeClients())

  it('merges a large log on load, keeping every edit', async () => {
    const basePath = uniqueBasePath('merge')
    const expected = await growLog(basePath)
    expect(await logKeys(basePath)).toHaveLength(40)

    const merged: number[] = []
    const reader = await openAdapter(basePath)
    reader.on('document-persisted', ({ version }) => merged.push(version))
    expect(text(reader)).toBe(expected)

    await waitFor(async () => ((await readRaw(`${basePath}/doc/meta/generation`)) as number) === 1, {
      message: 'generation 1',
    })
    await waitFor(async () => (await logKeys(basePath)).length === 0, { message: 'log cleaned up' })
    expect(merged).toEqual([1])
    expect(Object.keys((await readRaw(`${basePath}/doc/snapshots`)) as object)).toHaveLength(1)

    const later = await openAdapter(basePath)
    expect(text(later)).toBe(expected)
  })

  it('merges again once the log grows after a merge', async () => {
    const basePath = uniqueBasePath('remerge')
    await growLog(basePath)
    await openAdapter(basePath)
    await waitFor(async () => ((await readRaw(`${basePath}/doc/meta/generation`)) as number) === 1, {
      message: 'generation 1',
    })

    const expected = await growLog(basePath)
    await openAdapter(basePath)
    await waitFor(async () => ((await readRaw(`${basePath}/doc/meta/generation`)) as number) === 2, {
      message: 'generation 2',
    })
    const later = await openAdapter(basePath)
    expect(text(later)).toBe(expected)
  })

  it('loses nothing when clients merge concurrently while others keep writing', async () => {
    const basePath = uniqueBasePath('race')
    const before = await growLog(basePath)

    // Two readers load (and both try to merge) while a writer adds more.
    const writer = await openAdapter(basePath, { persistDebounceMs: 5 })
    const [r1, r2] = await Promise.all([openAdapter(basePath), openAdapter(basePath)])
    for (let i = 0; i < 20; i++) {
      writer.ydoc.getText('t').insert(text(writer).length, `late-${i}\n`)
      await writer.flush()
    }
    await waitFor(async () => ((await readRaw(`${basePath}/doc/meta/generation`)) as number) >= 1, {
      message: 'a merge',
    })
    await waitFor(async () => ((await readRaw(`${basePath}/doc/meta/lease`)) ?? null) === null, {
      message: 'lease released',
    })

    const final = (await storedDoc(`${basePath}/doc`)).getText('t').toString()
    expect(final).toBe(text(writer))
    expect(final.startsWith(before)).toBe(true)
    expect(Object.keys((await readRaw(`${basePath}/doc/snapshots`)) as object)).toHaveLength(1)
    expect(text(r1)).toBe(before)
    expect(text(r2)).toBe(before)
  })

  it('does not merge while another client holds the lease', async () => {
    const basePath = uniqueBasePath('lease')
    const expected = await growLog(basePath)
    await writeRaw(`${basePath}/doc/meta`, {
      generation: 0,
      snapshot: null,
      parts: 0,
      bytes: 0,
      lease: { holder: 'someone-else', until: Date.now() + 60_000 },
    })
    const reader = await openAdapter(basePath)
    expect(text(reader)).toBe(expected)
    await new Promise((r) => setTimeout(r, 1000))
    expect(await readRaw(`${basePath}/doc/meta/generation`)).toBe(0)
    expect(await logKeys(basePath)).toHaveLength(40)
  })

  it('rejects when the snapshot meta points to is missing, instead of opening without it', async () => {
    const basePath = uniqueBasePath('missing-snapshot')
    await writeRaw(`${basePath}/doc/meta`, { generation: 3, snapshot: '3-gone', parts: 1, bytes: 10 })
    await expect(openAdapter(basePath)).rejects.toBeInstanceOf(LoadError)
  })

  it('stores and reloads a document larger than Firebase’s string limit', async () => {
    const basePath = uniqueBasePath('huge')
    const writer = await openAdapter(basePath, { persistDebounceMs: 60_000 })
    // Random text barely compresses, so this stays ~12MB+ even after gzip and base64.
    const content = randomBytes(9 * 1024 * 1024).toString('base64')
    writer.ydoc.getText('t').insert(0, content)
    await writer.disconnect()

    const [entry] = Object.values((await readRaw(`${basePath}/doc/updates`)) as Record<string, { n?: number }>)
    expect(entry.n).toBeGreaterThan(1) // stored in parts

    const reader = await openAdapter(basePath) // loads, then merges into a multi-part snapshot
    expect(text(reader).length).toBe(content.length)
    await waitFor(async () => ((await readRaw(`${basePath}/doc/meta/parts`)) as number) > 1, {
      timeout: 30_000,
      message: 'multi-part snapshot',
    })

    const again = await openAdapter(basePath)
    expect(text(again) === content).toBe(true)
  }, 120_000)
})

describe('merging during a session', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))

  it('merges while clients stay open once their edits grow the log', async () => {
    const basePath = uniqueBasePath('in-session')
    const a = await openAdapter(basePath, { persistDebounceMs: 50 })
    const b = await openAdapter(basePath, { persistDebounceMs: 50 })
    await waitFor(() => a.getPeerCount() === 1, { message: 'connection' })

    for (let i = 0; i < 30; i++) {
      const writer = i % 2 ? a : b
      writer.ydoc.getText('t').insert(text(writer).length, `${i}:${randomBytes(600).toString('hex')}\n`)
      await new Promise((r) => setTimeout(r, 100))
    }
    await Promise.all([a.flush(), b.flush()])

    await waitFor(async () => ((await readRaw(`${basePath}/doc/meta/generation`)) as number) >= 1, {
      timeout: 20_000,
      message: 'a merge during the session',
    })
    await waitFor(async () => (await storedDoc(`${basePath}/doc`)).getText('t').toString() === text(a), {
      message: 'stored state matches',
    })
    expect(text(b)).toBe(text(a))
  }, 40_000)
})
