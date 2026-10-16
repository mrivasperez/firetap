import { describe, expect, it } from 'vitest'
import { desiredNeighbors } from '../../core/topology'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `peer-${String(i).padStart(3, '0')}`)

function graph(n: number, k: number) {
  const all = ids(n)
  return new Map(all.map((id) => [id, desiredNeighbors(id, all, k)]))
}

function isConnected(g: Map<string, Set<string>>): boolean {
  const [start] = g.keys()
  const seen = new Set([start])
  const queue = [start]
  while (queue.length) {
    for (const next of g.get(queue.shift()!)!) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen.size === g.size
}

function diameter(g: Map<string, Set<string>>): number {
  let max = 0
  for (const start of g.keys()) {
    const dist = new Map([[start, 0]])
    const queue = [start]
    while (queue.length) {
      const id = queue.shift()!
      for (const next of g.get(id)!) {
        if (!dist.has(next)) {
          dist.set(next, dist.get(id)! + 1)
          queue.push(next)
        }
      }
    }
    max = Math.max(max, ...dist.values())
  }
  return max
}

describe('desiredNeighbors', () => {
  it('is a full mesh while everyone fits', () => {
    const g = graph(7, 6)
    for (const [id, neighbors] of g) expect(neighbors.size).toBe(6)
    expect(diameter(g)).toBe(1)
  })

  it.each([2, 3, 4, 6, 8])('is symmetric, capped, and connected for k=%i', (k) => {
    for (let n = 2; n <= 60; n++) {
      const g = graph(n, k)
      for (const [id, neighbors] of g) {
        expect(neighbors.size).toBeLessThanOrEqual(k)
        expect(neighbors.has(id)).toBe(false)
        for (const other of neighbors) expect(g.get(other)!.has(id)).toBe(true)
      }
      expect(isConnected(g)).toBe(true)
    }
  })

  it('keeps paths short in large rooms', () => {
    expect(diameter(graph(20, 6))).toBeLessThanOrEqual(4)
    expect(diameter(graph(50, 6))).toBeLessThanOrEqual(7)
  })

  it('uses far fewer links than a full mesh', () => {
    const edges = (n: number, k: number) => [...graph(n, k).values()].reduce((s, x) => s + x.size, 0) / 2
    expect(edges(20, 6)).toBeLessThanOrEqual(60) // full mesh: 190
  })
})
