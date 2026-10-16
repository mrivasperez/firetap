import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { loadDocumentFromFirebase, persistDocument } from '../../firebase/persistence'
import type { DatabasePathsConfig } from '../../utils/config'
import { closeClients, createClient, setRules, uniqueBasePath } from './helpers'

function nestedPaths(basePath: string): DatabasePathsConfig {
  return {
    structure: 'nested',
    nested: {
      basePath,
      subPaths: { documents: 'documents', rooms: 'rooms', snapshots: 'snapshots', signaling: 'signaling' },
    },
  }
}

describe('persistence', () => {
  beforeAll(() => setRules())
  afterAll(() => closeClients())

  it('round-trips a document through Firebase', async () => {
    const db = createClient()
    const paths = nestedPaths(uniqueBasePath('roundtrip'))

    const doc = new Y.Doc()
    doc.getText('t').insert(0, 'hello firetap')
    await persistDocument(db, doc, 'doc-1', 1, paths)

    const loaded = await loadDocumentFromFirebase(db, 'doc-1', paths)
    expect(loaded).not.toBeNull()
    const copy = new Y.Doc()
    Y.applyUpdate(copy, loaded!)
    expect(copy.getText('t').toString()).toBe('hello firetap')
  })

  it('returns null for a document that does not exist', async () => {
    const db = createClient()
    const paths = nestedPaths(uniqueBasePath('missing'))
    expect(await loadDocumentFromFirebase(db, 'nope', paths)).toBeNull()
  })
})
