import { describe, expect, it, vi } from 'vitest'
import { MSG_AWARENESS, MSG_UPDATE, PeerSession, type SessionLimits } from '../../core/peer-session'
import { FakeDataChannel, fakeChannelPair } from '../support/fake-webrtc'

type Received = { type: number; payload: Uint8Array }

function sessionPair(limits: Partial<SessionLimits> = {}) {
  const [ca, cb] = fakeChannelPair()
  const received: Received[] = []
  const errors: Error[] = []
  const sent: number[] = []
  const send = ca.send.bind(ca)
  ca.send = (data: ArrayBufferView) => {
    sent.push(data.byteLength)
    send(data)
  }
  const a = new PeerSession(ca, { onMessage: () => {}, onError: (e) => errors.push(e) }, limits)
  const b = new PeerSession(
    cb,
    { onMessage: (type, payload) => received.push({ type, payload: payload.slice() }), onError: (e) => errors.push(e) },
    limits
  )
  cb.onmessage = ({ data }) => b.receive(data as ArrayBuffer)
  return { a, b, ca, cb, received, errors, sent }
}

const until = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true), { timeout: 5000, interval: 5 })

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

describe('PeerSession', () => {
  it('delivers small messages as single frames', async () => {
    const { a, received, sent } = sessionPair()
    a.send(MSG_UPDATE, bytes(100))
    await until(() => received.length === 1)
    expect(received[0].type).toBe(MSG_UPDATE)
    expect(received[0].payload).toEqual(bytes(100))
    expect(sent).toEqual([101])
  })

  it('chunks a 5MB message into frames no larger than the limit and reassembles it', async () => {
    const { a, received, sent, errors } = sessionPair()
    const payload = bytes(5 * 1024 * 1024)
    a.send(MSG_UPDATE, payload)
    await until(() => received.length === 1)
    expect(errors).toEqual([])
    expect(Buffer.from(received[0].payload).equals(Buffer.from(payload))).toBe(true)
    expect(Math.max(...sent)).toBeLessThanOrEqual(16 * 1024)
  })

  it('keeps messages in order across chunked and single frames', async () => {
    const { a, received } = sessionPair()
    a.send(MSG_UPDATE, bytes(10, 1))
    a.send(MSG_UPDATE, bytes(100_000, 2))
    a.send(MSG_AWARENESS, bytes(10, 3))
    await until(() => received.length === 3)
    expect(received.map((r) => r.payload.length)).toEqual([10, 100_000, 10])
    expect(received[2].type).toBe(MSG_AWARENESS)
  })

  it('never buffers more than the high-water mark (backpressure)', async () => {
    FakeDataChannel.sendBufferCapacity = 512 * 1024
    const { a, ca, received, errors } = sessionPair({ highWaterBytes: 64 * 1024, lowWaterBytes: 16 * 1024 })
    let peak = 0
    const send = ca.send.bind(ca)
    ca.send = (data: ArrayBufferView) => {
      send(data)
      peak = Math.max(peak, ca.bufferedAmount)
    }
    // 4MB in one go would overflow the 512KB send buffer without backpressure.
    a.send(MSG_UPDATE, bytes(4 * 1024 * 1024))
    await until(() => received.length === 1)
    expect(errors).toEqual([])
    expect(peak).toBeLessThanOrEqual(64 * 1024 + 16 * 1024)
    FakeDataChannel.sendBufferCapacity = 16 * 1024 * 1024
  })

  it('fails on a chunk from a different message', () => {
    const { b, errors } = sessionPair()
    const chunk = (id: number, index: number, total: number) => {
      const f = new Uint8Array(13 + 4)
      const v = new DataView(f.buffer)
      f[0] = 5
      v.setUint32(1, id)
      v.setUint32(5, index)
      v.setUint32(9, total)
      return f
    }
    b.receive(chunk(1, 0, 3))
    b.receive(chunk(2, 0, 3))
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/unexpected chunk/)
  })

  it('rejects messages that declare more than the size limit', () => {
    const { b, errors } = sessionPair({ maxMessageBytes: 1024 * 1024 })
    const f = new Uint8Array(20)
    const v = new DataView(f.buffer)
    f[0] = 5
    v.setUint32(1, 1)
    v.setUint32(5, 0)
    v.setUint32(9, 1_000_000)
    b.receive(f)
    expect(errors[0]?.message).toMatch(/invalid size/)
  })

  it('reports unknown message types and handler failures', () => {
    const errors: Error[] = []
    const [, cb] = fakeChannelPair()
    const s = new PeerSession(cb, {
      onMessage: () => {
        throw new Error('bad update')
      },
      onError: (e) => errors.push(e),
    })
    s.receive(new Uint8Array([MSG_UPDATE, 1, 2]))
    expect(errors[0].message).toMatch(/bad update/)

    const errors2: Error[] = []
    const s2 = new PeerSession(cb, { onMessage: () => {}, onError: (e) => errors2.push(e) })
    s2.receive(new Uint8Array([99]))
    expect(errors2[0].message).toMatch(/unknown message type/)
  })

  it('fails when the send queue grows past its limit', () => {
    const { a, ca, errors } = sessionPair({ maxQueuedBytes: 1024 * 1024 })
    Object.defineProperty(ca, 'readyState', { value: 'connecting' }) // nothing drains
    a.send(MSG_UPDATE, bytes(2 * 1024 * 1024))
    expect(errors[0]?.message).toMatch(/send queue exceeded/)
  })
})
