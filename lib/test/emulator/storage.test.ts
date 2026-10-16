import { goOffline, goOnline, type Database } from 'firebase/database'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle, AdapterOptions } from '../../core/types'
import { LoadError, type SaveState } from '../../firebase/document-store'
import { base64ToUint8Array } from '../../utils/base64'
import { FakeRTCPeerConnection, installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import {
  closeClients,
  createClient,
  nestedPaths,
  readRaw,
  setRules,
  sleep,
  uniqueBasePath,
  waitFor,
  writeRaw,
} from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []
const quiet = { warn: () => {}, error: () => {} }

async function openAdapter(basePath: string, extra: Partial<AdapterOptions> & { db?: Database } = {}) {
  const { db = createClient(), ...rest } = extra
  const adapter = await createFirebaseYWebrtcAdapter({
    docId: 'doc',
    firebaseDatabase: db,
    databasePaths: nestedPaths(basePath),
    logger: quiet,
    ...rest,
  })
  open.push(adapter)
  return adapter
}

const text = (adapter: AdapterHandle) => adapter.ydoc.getText('t').toString()

type RawLog = Record<string, { data: string; by: string }> | null

async function storedText(basePath: string): Promise<string> {
  const log = (await readRaw(`${basePath}/doc/updates`)) as RawLog
  const doc = new Y.Doc()
  for (const entry of Object.values(log ?? {})) Y.applyUpdate(doc, base64ToUint8Array(entry.data))
  return doc.getText('t').toString()
}

const OPEN_RULES = { rules: { '.read': true, '.write': true } }

describe('storage: edit log', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(async () => {
    vi.unstubAllGlobals()
    await setRules(OPEN_RULES)
    open.splice(0).forEach((a) => a.disconnect())
  })
  afterAll(() => closeClients())

  it('saves edits and loads them back', async () => {
    const basePath = uniqueBasePath('roundtrip')
    const a = await openAdapter(basePath)
    a.ydoc.getText('t').insert(0, 'hello')
    await a.flush()
    const b = await openAdapter(basePath)
    expect(text(b)).toBe('hello')
  })

  it('keeps both sides of concurrent edits from peers that never connected', async () => {
    FakeRTCPeerConnection.isBlocked = () => true
    const basePath = uniqueBasePath('partition')
    const a = await openAdapter(basePath)
    const b = await openAdapter(basePath)
    a.ydoc.getText('t').insert(0, 'A')
    b.ydoc.getText('t').insert(0, 'B')
    await Promise.all([a.disconnect(), b.disconnect()])

    const c = await openAdapter(basePath)
    expect(text(c).split('').sort().join('')).toBe('AB')
  })

  it('rejects instead of opening an empty document when the read fails', async () => {
    const basePath = uniqueBasePath('noread')
    const seed = await openAdapter(basePath)
    seed.ydoc.getText('t').insert(0, 'precious')
    await seed.disconnect()
    const before = await readRaw(`${basePath}/doc/updates`)

    await setRules({ rules: { '.write': true, $root: { '.read': "!$root.beginsWith('t-noread')" } } })
    await expect(openAdapter(basePath)).rejects.toBeInstanceOf(LoadError)
    expect(await readRaw(`${basePath}/doc/updates`)).toEqual(before)
  })

  it('rejects a corrupt log entry instead of starting empty', async () => {
    const basePath = uniqueBasePath('corrupt')
    await writeRaw(`${basePath}/doc/updates/-bad`, { data: '!!! not base64 !!!', by: 'x' })
    await expect(openAdapter(basePath)).rejects.toBeInstanceOf(LoadError)
  })

  it('saves an edit made while an earlier write is still in flight', async () => {
    const basePath = uniqueBasePath('inflight')
    const db = createClient()
    const a = await openAdapter(basePath, { db, persistDebounceMs: 20 })
    let wentOffline = false
    a.on('save-state-changed', ({ state }) => {
      // The first write is about to go out: hold its acknowledgement back.
      if (state === 'saving' && !wentOffline) {
        wentOffline = true
        goOffline(db)
      }
    })
    a.ydoc.getText('t').insert(0, 'one')
    await waitFor(() => wentOffline, { message: 'first write in flight' })
    a.ydoc.getText('t').insert(3, ' two')
    await sleep(100)
    goOnline(db)

    await waitFor(() => a.getSaveState() === 'saved' && !a.hasUnsavedChanges(), { message: 'saved' })
    expect(await storedText(basePath)).toBe('one two')
  })

  it('stores the final state after rapid edits and concurrent flushes', async () => {
    const basePath = uniqueBasePath('rapid')
    const a = await openAdapter(basePath, { persistDebounceMs: 5 })
    const t = a.ydoc.getText('t')
    const flushes: Promise<void>[] = []
    for (let i = 0; i < 200; i++) {
      t.insert(t.length, String(i % 10))
      if (i % 7 === 0) flushes.push(a.flush())
      if (i % 20 === 0) await sleep(1)
    }
    await Promise.all(flushes)
    await a.flush()
    expect(await storedText(basePath)).toBe(t.toString())
  })

  it('disconnect() saves edits made just before it', async () => {
    const basePath = uniqueBasePath('disconnect')
    const a = await openAdapter(basePath, { persistDebounceMs: 60_000 })
    a.ydoc.getText('t').insert(0, 'last words')
    expect(a.hasUnsavedChanges()).toBe(true)
    await a.disconnect()
    expect(await storedText(basePath)).toBe('last words')
  })

  describe('in a browser-like page', () => {
    let doc: EventTarget & { hidden: boolean }
    let windowListenerTypes: string[]

    beforeEach(() => {
      doc = Object.assign(new EventTarget(), { hidden: false })
      const win = new EventTarget()
      windowListenerTypes = []
      const add = win.addEventListener.bind(win)
      win.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null) => {
        windowListenerTypes.push(type)
        add(type, listener)
      }
      vi.stubGlobal('document', doc)
      vi.stubGlobal('window', win)
    })

    it('saves when the tab is hidden, without waiting for the batch delay', async () => {
      const basePath = uniqueBasePath('hidden')
      const a = await openAdapter(basePath, { persistDebounceMs: 60_000 })
      a.ydoc.getText('t').insert(0, 'before closing')
      expect(a.hasUnsavedChanges()).toBe(true)

      doc.hidden = true
      doc.dispatchEvent(new Event('visibilitychange'))
      await waitFor(async () => (await storedText(basePath)) === 'before closing', { message: 'flush on hide' })
      await waitFor(() => !a.hasUnsavedChanges(), { message: 'acknowledged' })
    })

    it('registers no beforeunload listener; prompting is the app’s call', async () => {
      await openAdapter(uniqueBasePath('nobeforeunload'))
      expect(windowListenerTypes).toContain('pagehide')
      expect(windowListenerTypes).not.toContain('beforeunload')
    })
  })

  it('reports failed writes and retries until they succeed', async () => {
    const basePath = uniqueBasePath('denied')
    const a = await openAdapter(basePath, { persistDebounceMs: 10 })
    const states: SaveState[] = []
    const errors: Error[] = []
    a.on('save-state-changed', ({ state }) => states.push(state))
    a.on('persist-error', ({ error }) => errors.push(error))

    await setRules({ rules: { '.read': true, $root: { '.write': "!$root.beginsWith('t-denied')" } } })
    a.ydoc.getText('t').insert(0, 'eventually saved')
    await waitFor(() => a.getSaveState() === 'error', { message: 'error state' })
    expect(errors.length).toBeGreaterThan(0)
    expect(a.hasUnsavedChanges()).toBe(true)
    await expect(a.flush()).rejects.toBeInstanceOf(Error)

    await setRules(OPEN_RULES)
    await waitFor(() => a.getSaveState() === 'saved', { timeout: 15_000, message: 'retry succeeds' })
    expect(states).toContain('error')
    expect(await storedText(basePath)).toBe('eventually saved')
  })

  describe('edits of a peer that disappears', () => {
    // Writes by "pa" are rejected, so A can never save its own edits.
    const rulesBlockingA = {
      rules: {
        '.read': true,
        $root: {
          $doc: {
            rooms: { '.write': true },
            signaling: { '.write': true },
            meta: { '.write': true },
            snapshots: { '.write': true },
            updates: { $entry: { '.write': "newData.child('by').val() !== 'pa'" } },
          },
        },
      },
    }

    it('are saved by a peer that has them if the author crashed first', async () => {
      await setRules(rulesBlockingA)
      const basePath = uniqueBasePath('crash')
      const dbA = createClient()
      const a = await openAdapter(basePath, { db: dbA, peerId: 'pa' })
      // Like TipTap's caret extension, the app replaces the awareness user field.
      a.awareness.setLocalStateField('user', { name: 'Alice', color: '#f00' })
      const b = await openAdapter(basePath, { peerId: 'pb' })
      await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'connection' })

      a.ydoc.getText('t').insert(0, 'only in memory')
      await waitFor(() => text(b) === 'only in memory', { message: 'edit reaches B' })

      // A's tab dies: its connections drop without a clean disconnect.
      goOffline(dbA)
      for (const pc of FakeRTCPeerConnection.registry.values()) pc.simulateFailure()

      await waitFor(async () => (await storedText(basePath)) === 'only in memory', {
        timeout: 15_000,
        message: 'rescue write',
      })
      const log = (await readRaw(`${basePath}/doc/updates`)) as RawLog
      expect(Object.values(log ?? {}).every((e) => e.by === 'pb')).toBe(true)
    })

    it('are not written again when the author saved them before leaving', async () => {
      const basePath = uniqueBasePath('clean')
      const a = await openAdapter(basePath, { peerId: 'pa' })
      const b = await openAdapter(basePath, { peerId: 'pb' })
      await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'connection' })

      a.ydoc.getText('t').insert(0, 'saved by A')
      await waitFor(() => text(b) === 'saved by A', { message: 'edit reaches B' })
      await a.disconnect()
      await sleep(4000) // longer than the rescue jitter

      const log = (await readRaw(`${basePath}/doc/updates`)) as RawLog
      expect(Object.values(log ?? {}).map((e) => e.by)).toEqual(['pa'])
    })
  })
})
