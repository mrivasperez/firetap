import { describe, expect, it } from 'vitest'
import { compressText, decompressText } from '../../utils/compression'

// A trimmed but realistic SDP offer with bundled ICE candidates.
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  ...Array.from(
    { length: 6 },
    (_, i) => `a=candidate:${1000 + i} 1 udp 2122260223 192.168.1.${10 + i} 5${i}123 typ host generation 0 network-id 1`
  ),
  'a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdefghijklmn',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
].join('\r\n')

describe('compressText', () => {
  it('shrinks SDP and round-trips it', async () => {
    const encoded = await compressText(SDP)
    expect(encoded).not.toBeNull()
    expect(encoded!.length).toBeLessThan(SDP.length * 0.8)
    expect(await decompressText(encoded!)).toBe(SDP)
  })

  it('returns null when compression would not help', async () => {
    expect(await compressText('fake:1')).toBeNull()
  })
})
