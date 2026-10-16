// In-process stand-ins for RTCPeerConnection and RTCDataChannel, so adapters
// running in Node can connect through real Firebase signaling.

type Listener = (event: { data?: unknown; channel?: FakeDataChannel }) => void

export class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
  bufferedAmount = 0
  remote: FakeDataChannel | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: Listener | null = null

  constructor(readonly label: string) {}

  send(data: unknown): void {
    if (this.readyState !== 'open') throw new Error(`InvalidStateError: channel is ${this.readyState}`)
    const remote = this.remote
    setTimeout(() => {
      if (remote?.readyState === 'open') remote.onmessage?.({ data })
    }, 0)
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
    const remote = this.remote
    if (remote && remote.readyState !== 'closed') setTimeout(() => remote.close(), 0)
  }

  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }
}

type Description = { type: 'offer' | 'answer'; sdp: string }

export class FakeRTCPeerConnection extends EventTarget {
  static registry = new Map<string, FakeRTCPeerConnection>()
  static created = 0
  /** Return true to make a pair fail to connect, like peers behind a strict NAT. */
  static isBlocked: (a: FakeRTCPeerConnection, b: FakeRTCPeerConnection) => boolean = () => false
  /** When > 0, a server-reflexive candidate arrives at once but gathering only
   * completes after this long, like with an unreachable STUN server. */
  static gatheringCompleteMs = 0

  readonly id = `fake-${++FakeRTCPeerConnection.created}`
  connectionState: RTCPeerConnectionState = 'new'
  iceGatheringState: RTCIceGatheringState = 'new'
  localDescription: Description | null = null
  remoteDescription: Description | null = null
  onconnectionstatechange: (() => void) | null = null
  ondatachannel: Listener | null = null
  onicecandidate: (() => void) | null = null
  private channels: FakeDataChannel[] = []
  private remoteId: string | null = null
  private gatheringTimers: ReturnType<typeof setTimeout>[] = []

  constructor(_config?: unknown) {
    super()
    FakeRTCPeerConnection.registry.set(this.id, this)
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label)
    this.channels.push(channel)
    return channel
  }

  async createOffer(): Promise<Description> {
    return { type: 'offer', sdp: `fake:${this.id}` }
  }

  async createAnswer(): Promise<Description> {
    return { type: 'answer', sdp: `fake:${this.id}` }
  }

  async setLocalDescription(description: Description): Promise<void> {
    this.assertOpen()
    this.localDescription = description
    const delay = FakeRTCPeerConnection.gatheringCompleteMs
    if (delay <= 0) {
      this.iceGatheringState = 'complete'
      this.dispatchEvent(new Event('icegatheringstatechange'))
      return
    }
    this.iceGatheringState = 'gathering'
    this.gatheringTimers.push(
      setTimeout(() => {
        const event = Object.assign(new Event('icecandidate'), { candidate: { type: 'srflx' } })
        this.dispatchEvent(event)
      }, 10),
      setTimeout(() => {
        this.iceGatheringState = 'complete'
        this.dispatchEvent(new Event('icegatheringstatechange'))
      }, delay)
    )
  }

  async setRemoteDescription(description: Description): Promise<void> {
    this.assertOpen()
    this.remoteDescription = description
    this.remoteId = description.sdp.split(':')[1]
    if (description.type === 'answer') setTimeout(() => this.connectPair(), 0)
  }

  close(): void {
    if (this.connectionState === 'closed') return
    this.setState('closed', false)
    this.gatheringTimers.forEach((t) => clearTimeout(t))
    this.channels.forEach((c) => c.close())
    FakeRTCPeerConnection.registry.delete(this.id)
    // The other side notices the transport went away.
    const remote = this.remoteId ? FakeRTCPeerConnection.registry.get(this.remoteId) : undefined
    if (remote && remote.connectionState === 'connected') setTimeout(() => remote.setState('disconnected'), 0)
  }

  simulateFailure(): void {
    const remote = this.remoteId ? FakeRTCPeerConnection.registry.get(this.remoteId) : undefined
    this.setState('failed')
    remote?.setState('failed')
  }

  private connectPair(): void {
    const answerer = this.remoteId ? FakeRTCPeerConnection.registry.get(this.remoteId) : undefined
    if (!answerer || answerer.remoteId !== this.id || this.connectionState === 'closed') return
    if (FakeRTCPeerConnection.isBlocked(this, answerer)) {
      this.setState('failed')
      answerer.setState('failed')
      return
    }
    this.setState('connected')
    answerer.setState('connected')
    for (const local of this.channels) {
      const remote = new FakeDataChannel(local.label)
      local.remote = remote
      remote.remote = local
      answerer.channels.push(remote)
      answerer.ondatachannel?.({ channel: remote })
      local.open()
      remote.open()
    }
  }

  private setState(state: RTCPeerConnectionState, notify = true): void {
    if (this.connectionState === state || this.connectionState === 'closed') return
    this.connectionState = state
    if (notify) this.onconnectionstatechange?.()
  }

  private assertOpen(): void {
    if (this.connectionState === 'closed') throw new Error('InvalidStateError: connection is closed')
  }
}

class FakeRTCSessionDescription {
  type: string
  sdp: string
  constructor(init: { type: string; sdp: string }) {
    this.type = init.type
    this.sdp = init.sdp
  }
}

export function installFakeWebRTC(): void {
  const g = globalThis as Record<string, unknown>
  g.RTCPeerConnection = FakeRTCPeerConnection
  g.RTCSessionDescription = FakeRTCSessionDescription
}

export function resetFakeWebRTC(): void {
  FakeRTCPeerConnection.registry.clear()
  FakeRTCPeerConnection.isBlocked = () => false
  FakeRTCPeerConnection.gatheringCompleteMs = 0
}
