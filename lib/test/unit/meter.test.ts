import { describe, expect, it } from 'vitest'
import { Meter, categorize } from '../../bench/meter.mjs'

describe('cost meter', () => {
  it('categorizes database paths', () => {
    expect(categorize('/ws/documents/doc-1/snapshots/latest')).toBe('snapshot')
    expect(categorize('ws/documents/doc-1/rooms/peers/abc')).toBe('presence')
    expect(categorize('/ws/documents/doc-1/signaling/abc/-N1')).toBe('signaling')
    expect(categorize('/ws/documents/doc-1/updates/-N1')).toBe('log')
    expect(categorize('/ws/documents/doc-1/meta')).toBe('meta')
    expect(categorize('/ws/documents/doc-1/documents')).toBe('snapshot')
    expect(categorize('/somewhere/else')).toBe('other')
  })

  it('attributes responses to the path of their request', () => {
    const m = new Meter()
    m.onSent(JSON.stringify({ t: 'd', d: { r: 3, a: 'g', b: { p: '/x/snapshots/latest' } } }))
    const response = JSON.stringify({ t: 'd', d: { r: 3, b: { s: 'ok', d: { update: 'abc' } } } })
    m.onReceived(response)
    expect(m.received.snapshot).toBe(Buffer.byteLength(response))
  })

  it('reassembles fragmented messages and counts every frame', () => {
    const m = new Meter()
    const msg = JSON.stringify({ t: 'd', d: { a: 'd', b: { p: '/x/rooms/peers/a', d: { name: 'n'.repeat(50) } } } })
    const parts = [msg.slice(0, 20), msg.slice(20)]
    m.onReceived('2')
    parts.forEach((p) => m.onReceived(p))
    expect(m.received.presence).toBe(1 + Buffer.byteLength(msg))
    expect(m.total()).toBe(1 + Buffer.byteLength(msg))
  })
})
