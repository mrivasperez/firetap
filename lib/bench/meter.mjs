// Counts the bytes Firebase sends over one WebSocket, by database path.
// Large messages arrive as a frame holding the frame count, then the fragments.
// Server responses carry only the request id, so paths come from the requests.

export const CATEGORIES = ['snapshot', 'log', 'meta', 'presence', 'signaling', 'connection', 'other']

const SEGMENT_CATEGORIES = {
  snapshots: 'snapshot',
  documents: 'snapshot', // legacy document node
  updates: 'log',
  meta: 'meta',
  rooms: 'presence',
  signaling: 'signaling',
}

// The base path may contain these words too, so the last match wins.
export function categorize(path) {
  if (!path) return 'other'
  const segments = path.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    const category = SEGMENT_CATEGORIES[segments[i]]
    if (category) return category
  }
  return 'other'
}

function byteLength(payload) {
  return typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : payload.length
}

export class Meter {
  constructor() {
    this.received = Object.fromEntries(CATEGORIES.map((c) => [c, 0]))
    this.sent = 0
    this.messages = 0
    this.requestPaths = new Map()
    this.pending = null // { remaining, bytes, parts }
  }

  onSent(payload) {
    this.sent += byteLength(payload)
    const msg = tryParse(payload)
    const r = msg?.d?.r
    const p = msg?.d?.b?.p
    if (msg?.t === 'd' && r !== undefined && typeof p === 'string') this.requestPaths.set(r, p)
  }

  onReceived(payload) {
    const bytes = byteLength(payload)
    const text = typeof payload === 'string' ? payload : payload.toString('utf8')

    if (this.pending) {
      this.pending.bytes += bytes
      this.pending.parts.push(text)
      if (--this.pending.remaining === 0) {
        const { bytes: total, parts } = this.pending
        this.pending = null
        this.attribute(parts.join(''), total)
      }
      return
    }

    if (/^\d+$/.test(text)) {
      const count = Number(text)
      if (count > 0) this.pending = { remaining: count, bytes, parts: [] }
      else this.received.connection += bytes
      return
    }

    this.attribute(text, bytes)
  }

  attribute(text, bytes) {
    this.messages++
    const msg = tryParse(text)
    let category = 'other'
    if (msg?.t === 'c') {
      category = 'connection'
    } else if (msg?.t === 'd') {
      const d = msg.d ?? {}
      if (typeof d.b?.p === 'string') {
        category = categorize(d.b.p)
      } else if (d.r !== undefined && this.requestPaths.has(d.r)) {
        category = categorize(this.requestPaths.get(d.r))
        this.requestPaths.delete(d.r)
      }
    }
    this.received[category] += bytes
  }

  total() {
    return Object.values(this.received).reduce((a, b) => a + b, 0)
  }

  snapshot() {
    return { received: { ...this.received }, total: this.total(), sent: this.sent }
  }
}

function tryParse(text) {
  try {
    return JSON.parse(typeof text === 'string' ? text : text.toString('utf8'))
  } catch {
    return null
  }
}

export function diff(after, before) {
  const received = {}
  for (const c of CATEGORIES) received[c] = after.received[c] - before.received[c]
  return { received, total: after.total - before.total, sent: after.sent - before.sent }
}

export function sum(snapshots) {
  const received = Object.fromEntries(CATEGORIES.map((c) => [c, 0]))
  let total = 0
  let sent = 0
  for (const s of snapshots) {
    for (const c of CATEGORIES) received[c] += s.received[c]
    total += s.total
    sent += s.sent
  }
  return { received, total, sent }
}
