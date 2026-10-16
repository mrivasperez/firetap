import { describe, expect, it } from 'vitest'
import { buildDatabasePaths, DEFAULT_DATABASE_PATHS, type DatabasePathsConfig } from '../../utils/config'

describe('buildDatabasePaths', () => {
  it('defaults to the nested layout', () => {
    expect(buildDatabasePaths(undefined, 'doc-1')).toEqual(buildDatabasePaths(DEFAULT_DATABASE_PATHS, 'doc-1'))
    expect(buildDatabasePaths(undefined, 'doc-1')).toEqual({
      rooms: '/documents/doc-1/rooms',
      signaling: '/documents/doc-1/signaling',
      updates: '/documents/doc-1/updates',
      snapshots: '/documents/doc-1/snapshots',
      meta: '/documents/doc-1/meta',
    })
  })

  it('keys every flat root by docId', () => {
    const flat: DatabasePathsConfig = { structure: 'flat', flat: { rooms: '/presence' } }
    expect(buildDatabasePaths(flat, 'doc-1')).toEqual({
      rooms: '/presence/doc-1',
      signaling: '/signaling/doc-1',
      updates: '/updates/doc-1',
      snapshots: '/snapshots/doc-1',
      meta: '/meta/doc-1',
    })
  })

  it('applies custom nested sub-paths', () => {
    const nested: DatabasePathsConfig = { structure: 'nested', nested: { basePath: '/ws/docs', subPaths: { updates: 'log' } } }
    expect(buildDatabasePaths(nested, 'd').updates).toBe('/ws/docs/d/log')
    expect(buildDatabasePaths(nested, 'd').rooms).toBe('/ws/docs/d/rooms')
  })

  it('never gives two documents the same path in any layout', () => {
    const layouts: (DatabasePathsConfig | undefined)[] = [
      undefined,
      { structure: 'flat' },
      { structure: 'nested', nested: { basePath: '/ws/documents' } },
    ]
    for (const layout of layouts) {
      const a = Object.values(buildDatabasePaths(layout, 'doc-a'))
      const b = Object.values(buildDatabasePaths(layout, 'doc-b'))
      for (const path of a) expect(b).not.toContain(path)
    }
  })

  it.each(['', '   ', 'a/b', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b'])('rejects invalid docId %j', (docId) => {
    expect(() => buildDatabasePaths(undefined, docId)).toThrow(/docId/)
  })
})
