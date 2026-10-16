import { describe, expect, it } from 'vitest'
import { buildDatabasePaths, DEFAULT_DATABASE_PATHS, type DatabasePathsConfig } from '../../utils/config'

describe('buildDatabasePaths', () => {
  it('defaults to the nested layout', () => {
    expect(buildDatabasePaths(undefined, 'doc-1')).toEqual(buildDatabasePaths(DEFAULT_DATABASE_PATHS, 'doc-1'))
    expect(buildDatabasePaths(undefined, 'doc-1').snapshots).toBe('/documents/doc-1/snapshots')
  })

  it('keys every flat root by docId', () => {
    const flat: DatabasePathsConfig = {
      structure: 'flat',
      flat: { documents: '/documents', rooms: '/rooms', snapshots: '/snapshots', signaling: '/signaling' },
    }
    expect(buildDatabasePaths(flat, 'doc-1')).toEqual({
      documents: '/documents/doc-1',
      rooms: '/rooms/doc-1',
      snapshots: '/snapshots/doc-1',
      signaling: '/signaling/doc-1',
    })
  })

  it('never gives two documents the same path in any layout', () => {
    const layouts: (DatabasePathsConfig | undefined)[] = [
      undefined,
      { structure: 'flat', flat: { documents: '/d', rooms: '/r', snapshots: '/s', signaling: '/g' } },
      {
        structure: 'nested',
        nested: { basePath: '/ws/documents', subPaths: { documents: 'd', rooms: 'r', snapshots: 's', signaling: 'g' } },
      },
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
