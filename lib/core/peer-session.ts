// Every message is one frame, [type][payload]. Larger frames are split into
// [MSG_CHUNK][messageId u32][index u32][total u32][slice] chunks.

export const MSG_SYNC_STEP1 = 1; // [version: u8][state vector]
export const MSG_SYNC_STEP2 = 2; // [update containing what the other side is missing]
export const MSG_UPDATE = 3; // [update]
export const MSG_AWARENESS = 4; // [awareness update]
const MSG_CHUNK = 5;
export const MSG_NEIGHBORS = 6; // [UTF-8 JSON array of the sender's directly connected peer ids]
export const MSG_PERSISTED = 7; // [UTF-8 JSON {peer, client, clock}]

const MESSAGE_TYPES = new Set([
  MSG_SYNC_STEP1,
  MSG_SYNC_STEP2,
  MSG_UPDATE,
  MSG_AWARENESS,
  MSG_NEIGHBORS,
  MSG_PERSISTED,
]);

export const PROTOCOL_VERSION = 1;

const CHUNK_HEADER_BYTES = 13;

export type SessionLimits = {
  maxFrameBytes: number;
  highWaterBytes: number;
  lowWaterBytes: number;
  maxQueuedBytes: number;
  maxMessageBytes: number;
};

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxFrameBytes: 16 * 1024,
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  maxQueuedBytes: 64 * 1024 * 1024,
  maxMessageBytes: 64 * 1024 * 1024,
};

export type SessionChannel = {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: Uint8Array<ArrayBuffer>): void;
  addEventListener(type: "bufferedamountlow", listener: () => void): void;
  removeEventListener(type: "bufferedamountlow", listener: () => void): void;
};

export type SessionHandlers = {
  onMessage(type: number, payload: Uint8Array): void;
  onError(error: Error): void;
};

type Reassembly = {
  id: number;
  total: number;
  next: number;
  parts: Uint8Array[];
  bytes: number;
};

export class PeerSession {
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private queuedBytes = 0;
  private nextMessageId = 1;
  private reassembly: Reassembly | null = null;
  private failed = false;
  private closed = false;
  private readonly limits: SessionLimits;
  private readonly onBufferedAmountLow = () => this.flush();

  constructor(
    private readonly channel: SessionChannel,
    private readonly handlers: SessionHandlers,
    limits: Partial<SessionLimits> = {}
  ) {
    this.limits = { ...DEFAULT_SESSION_LIMITS, ...limits };
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = this.limits.lowWaterBytes;
    channel.addEventListener("bufferedamountlow", this.onBufferedAmountLow);
  }

  get queuedByteCount(): number {
    return this.queuedBytes;
  }

  send(type: number, payload: Uint8Array): void {
    if (this.failed || this.closed) return;
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = type;
    frame.set(payload, 1);

    if (frame.length <= this.limits.maxFrameBytes) {
      this.enqueue(frame);
    } else {
      const sliceBytes = this.limits.maxFrameBytes - CHUNK_HEADER_BYTES;
      const total = Math.ceil(frame.length / sliceBytes);
      const id = this.nextMessageId++ >>> 0;
      for (let index = 0; index < total; index++) {
        const slice = frame.subarray(index * sliceBytes, (index + 1) * sliceBytes);
        const chunk = new Uint8Array(CHUNK_HEADER_BYTES + slice.length);
        const view = new DataView(chunk.buffer);
        chunk[0] = MSG_CHUNK;
        view.setUint32(1, id);
        view.setUint32(5, index);
        view.setUint32(9, total);
        chunk.set(slice, CHUNK_HEADER_BYTES);
        this.enqueue(chunk);
      }
    }
    this.flush();
  }

  receive(data: ArrayBuffer | Uint8Array): void {
    if (this.failed || this.closed) return;
    const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (frame.length === 0) return this.fail("empty frame");

    if (frame[0] !== MSG_CHUNK) {
      if (this.reassembly) return this.fail("frame interleaved with a chunked message");
      return this.deliver(frame);
    }

    if (frame.length <= CHUNK_HEADER_BYTES) return this.fail("chunk without data");
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = view.getUint32(1);
    const index = view.getUint32(5);
    const total = view.getUint32(9);
    const slice = frame.subarray(CHUNK_HEADER_BYTES);

    let r = this.reassembly;
    if (!r) {
      if (index !== 0) return this.fail(`chunked message ${id} started at chunk ${index}`);
      const sliceBytes = this.limits.maxFrameBytes - CHUNK_HEADER_BYTES;
      if (total < 2 || (total - 1) * sliceBytes > this.limits.maxMessageBytes) {
        return this.fail(`chunked message ${id} declares an invalid size (${total} chunks)`);
      }
      r = this.reassembly = { id, total, next: 0, parts: [], bytes: 0 };
    }
    if (id !== r.id || total !== r.total || index !== r.next) {
      return this.fail(`unexpected chunk ${id}:${index}/${total} (expected ${r.id}:${r.next}/${r.total})`);
    }
    r.bytes += slice.length;
    if (r.bytes > this.limits.maxMessageBytes) {
      return this.fail(`chunked message ${id} exceeds ${this.limits.maxMessageBytes} bytes`);
    }
    r.parts.push(slice.slice());
    r.next++;

    if (r.next === r.total) {
      this.reassembly = null;
      const message = new Uint8Array(r.bytes);
      let offset = 0;
      for (const part of r.parts) {
        message.set(part, offset);
        offset += part.length;
      }
      this.deliver(message);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.reassembly = null;
    this.channel.removeEventListener("bufferedamountlow", this.onBufferedAmountLow);
  }

  private deliver(frame: Uint8Array): void {
    const type = frame[0];
    if (!MESSAGE_TYPES.has(type)) {
      return this.fail(`unknown message type ${type}`);
    }
    try {
      this.handlers.onMessage(type, frame.subarray(1));
    } catch (error) {
      this.fail(`failed to apply message type ${type}: ${(error as Error)?.message ?? error}`);
    }
  }

  private enqueue(frame: Uint8Array<ArrayBuffer>): void {
    this.queue.push(frame);
    this.queuedBytes += frame.length;
    if (this.queuedBytes > this.limits.maxQueuedBytes) {
      this.fail(`send queue exceeded ${this.limits.maxQueuedBytes} bytes`);
    }
  }

  flush(): void {
    while (
      !this.failed &&
      !this.closed &&
      this.queue.length > 0 &&
      this.channel.readyState === "open" &&
      this.channel.bufferedAmount <= this.limits.highWaterBytes
    ) {
      const frame = this.queue.shift()!;
      this.queuedBytes -= frame.length;
      try {
        this.channel.send(frame);
      } catch (error) {
        return this.fail(`send failed: ${(error as Error)?.message ?? error}`);
      }
    }
  }

  private fail(reason: string): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.reassembly = null;
    this.handlers.onError(new Error(reason));
  }
}
