import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle } from '../../core/types'
import { MSG_UPDATE } from '../../core/peer-session'
import { FakeDataChannel, installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, setRules, sleep, uniqueBasePath, waitFor } from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []
const quiet = { warn: () => {}, error: () => {} }

async function openAdapter(basePath: string, peerId: string) {
  const adapter = await createFirebaseYWebrtcAdapter({
    docId: 'doc',
    peerId,
    firebaseDatabase: createClient(),
    databasePaths: nestedPaths(basePath),
    logger: quiet,
  })
  open.push(adapter)
  return adapter
}

/** A and C can't signal each other; both reach B. */
async function lineOfThree(label: string) {
  const basePath = uniqueBasePath(label)
  const a = await openAdapter(basePath, 'pa')
  const b = await openAdapter(basePath, 'pb')
  const c = await openAdapter(basePath, 'pc')
  await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 2 && c.getPeerCount() === 1, {
    message: 'A-B-C line',
  })
  return { a, b, c }
}

let sentFrames: { type: number; channel: FakeDataChannel }[] = []
let dropFrame: ((index: number, type: number) => boolean) | null = null
const originalSend = FakeDataChannel.prototype.send

const text = (adapter: AdapterHandle) => adapter.ydoc.getText('t').toString()

describe('forwarding between peers', () => {
  beforeAll(() =>
    setRules({
      rules: {
        '.read': true,
        $root: {
          $doc: {
            rooms: { '.write': true },
            snapshots: { '.write': true },
            documents: { '.write': true },
            signaling: {
              $target: {
                $msg: {
                  '.write':
                    "!((newData.child('from').val() === 'pa' && $target === 'pc') || (newData.child('from').val() === 'pc' && $target === 'pa'))",
                },
              },
            },
          },
        },
      },
    })
  )
  beforeEach(() => {
    resetFakeWebRTC()
    sentFrames = []
    dropFrame = null
    FakeDataChannel.prototype.send = function (data) {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null
      if (bytes) {
        const index = sentFrames.push({ type: bytes[0], channel: this }) - 1
        if (dropFrame?.(index, bytes[0])) return
      }
      originalSend.call(this, data)
    }
  })
  afterEach(() => {
    FakeDataChannel.prototype.send = originalSend
    vi.useRealTimers()
    open.splice(0).forEach((a) => a.disconnect())
  })
  afterAll(async () => {
    await setRules()
    await closeClients()
  })

  it('relays edits and cursors between peers without a direct connection', async () => {
    const { a, b, c } = await lineOfThree('line')
    a.ydoc.getText('t').insert(0, 'from A ')
    await waitFor(() => text(c) === 'from A ', { message: 'A -> C via B' })
    c.ydoc.getText('t').insert(text(c).length, 'and C')
    await waitFor(() => text(a) === 'from A and C', { message: 'C -> A via B' })
    expect(text(b)).toBe('from A and C')

    a.awareness.setLocalStateField('cursor', 7)
    await waitFor(() => c.awareness.getStates().get(a.ydoc.clientID)?.cursor === 7, { message: 'cursor A at C' })
  })

  it('does not forward in a full mesh, where everyone already got it', async () => {
    const basePath = uniqueBasePath('mesh')
    const peers = [await openAdapter(basePath, 'm1'), await openAdapter(basePath, 'm2'), await openAdapter(basePath, 'm3')]
    await waitFor(() => peers.every((p) => p.getPeerCount() === 2), { message: 'mesh' })
    await sleep(300) // neighbor lists exchanged
    sentFrames = []

    peers[0].ydoc.getText('t').insert(0, 'hello')
    await waitFor(() => peers.every((p) => text(p) === 'hello'), { message: 'sync' })
    await sleep(300)
    expect(sentFrames.filter((f) => f.type === MSG_UPDATE)).toHaveLength(2)
  })

  it('repairs a missed relay through periodic state-vector exchange', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { a, c } = await lineOfThree('repair')
    await sleep(300)
    sentFrames = []

    // Drop B's relay to C (the second update frame; the first is A -> B).
    let updates = 0
    dropFrame = (_index, type) => type === MSG_UPDATE && ++updates === 2
    a.ydoc.getText('t').insert(0, 'lost on the way')
    await sleep(500)
    expect(text(c)).toBe('')

    vi.advanceTimersByTime(30_000)
    await waitFor(() => text(c) === 'lost on the way', { message: 'anti-entropy repair' })
  })
})
