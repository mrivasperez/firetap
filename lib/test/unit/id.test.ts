import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from '../../utils/id'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomId', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses crypto.randomUUID when available', () => {
    expect(randomId()).toMatch(UUID)
  })

  it('falls back to getRandomValues outside secure contexts', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    const ids = new Set(Array.from({ length: 100 }, () => randomId()))
    expect(ids.size).toBe(100)
    for (const id of ids) expect(id).toMatch(UUID)
  })
})
