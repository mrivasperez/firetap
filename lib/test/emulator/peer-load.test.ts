import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle, AdapterOptions } from '../../core/types'
import { FakeRTCPeerConnection, installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, readRaw, setRules, uniqueBasePath, waitFor } from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []

function recordingLogger() {
  const lines: string[] = []
  return { lines, logger: { debug: (...args: unknown[]) => lines.push(args.join(' ')), warn: () => {}, error: () => {} } }
}
const fromPeers = (lines: string[]) => lines.some((l) => l.includes('snapshot from a peer'))

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

/** Write enough separate edits that the next client to load merges them into a snapshot. */
async function writeLog(basePath: string) {
  const writer = await openAdapter(basePath, { persistDebounceMs: 60_000 })
  for (let i = 0; i < 40; i++) {
    writer.ydoc.getText('t').insert(text(writer).length, `${i}:${randomBytes(600).toString('hex')}\n`)
    await writer.flush()
  }
  await writer.disconnect()
}

/** A document with a snapshot at the given generation, held open by one client. */
async function documentWithSnapshot(label: string) {
  const basePath = uniqueBasePath(label)
  await writeLog(basePath)
  const holder = await openAdapter(basePath) // merges on load
  await waitFor(async () => (await generation(basePath)) === 1, { message: 'snapshot' })
  return { basePath, holder }
}

describe('loading from peers', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(() => closeClients())

  it('gets the snapshot from a peer and downloads only the edit log', async () => {
    const { basePath, holder } = await documentWithSnapshot('peer-load')
    holder.ydoc.getText('t').insert(0, 'unmerged edit\n')
    await holder.flush()

    const joiner = recordingLogger()
    const c = await openAdapter(basePath, { logger: joiner.logger })
    expect(fromPeers(joiner.lines)).toBe(true)
    expect(text(c)).toBe(text(holder))
  })

  it('downloads the snapshot when no peer can be reached', async () => {
    const { basePath, holder } = await documentWithSnapshot('peer-load-blocked')
    FakeRTCPeerConnection.isBlocked = () => true
    const joiner = recordingLogger()
    const c = await openAdapter(basePath, { logger: joiner.logger })
    expect(fromPeers(joiner.lines)).toBe(false)
    expect(text(c)).toBe(text(holder))
  })

  it('does not trust a peer whose document is behind the stored snapshot', async () => {
    const { basePath, holder } = await documentWithSnapshot('peer-load-stale')
    // Someone else adds edits and merges them into generation 2; the holder is still at 1.
    FakeRTCPeerConnection.isBlocked = () => true
    await writeLog(basePath)
    const merger = await openAdapter(basePath)
    await waitFor(async () => (await generation(basePath)) === 2, { message: 'generation 2' })
    await merger.disconnect()
    FakeRTCPeerConnection.isBlocked = () => false

    const joiner = recordingLogger()
    const c = await openAdapter(basePath, { logger: joiner.logger })
    expect(fromPeers(joiner.lines)).toBe(false)
    expect(text(c).length).toBeGreaterThan(text(holder).length - 1)
    expect((await readRaw(`${basePath}/doc/meta/generation`)) as number).toBe(2)
  }, 60_000)

  it('emits sync-completed when the first sync with a peer finishes', async () => {
    const basePath = uniqueBasePath('sync-completed')
    const a = await openAdapter(basePath)
    const synced: string[] = []
    a.on('sync-completed', ({ peerId }) => synced.push(peerId))
    const b = await openAdapter(basePath)
    await waitFor(() => synced.length === 1, { message: 'sync-completed' })
    expect(synced).toEqual([b.getUserInfo().id])
  })
})
