import { describe, expect, it } from 'vitest'
import { compressData, decompressData } from '../../utils/compression'
import { COMPRESSION_THRESHOLD } from '../../utils/constants'

describe('compression', () => {
  it('leaves small payloads uncompressed', async () => {
    const data = new Uint8Array([1, 2, 3])
    const { compressed, isCompressed } = await compressData(data)
    expect(isCompressed).toBe(false)
    expect(compressed).toEqual(data)
  })

  it('round-trips a compressible payload', async () => {
    const data = new TextEncoder().encode('firetap '.repeat(COMPRESSION_THRESHOLD))
    const { compressed, isCompressed } = await compressData(data)
    expect(isCompressed).toBe(true)
    expect(compressed.length).toBeLessThan(data.length)
    expect(await decompressData(compressed)).toEqual(data)
  })
})
