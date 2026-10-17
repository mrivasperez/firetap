import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle } from '../../core/types'
import { LoadError, loadDocument, updateDocument } from '../../server'
import { installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import {
  closeAdminDatabases,
  closeClients,
  createAdminDatabase,
  createClient,
  nestedPaths,
  readRaw,
  setRules,
  uniqueBasePath,
  waitFor,
  writeRaw,
} from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []
const quiet = { warn: () => {}, error: () => {} }

async function openAdapter(basePath: string) {
  const adapter = await createFirebaseYWebrtcAdapter({
    docId: 'doc',
    firebaseDatabase: createClient(),
    databasePaths: nestedPaths(basePath),
    logger: quiet,
  })
  open.push(adapter)
  return adapter
}

async function serverOptions(basePath: string) {
  return { docId: 'doc', database: await createAdminDatabase(), databasePaths: nestedPaths(basePath), logger: quiet }
}

describe('server entry', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(async () => {
    await closeClients()
    await closeAdminDatabases()
  })

  it('creates a document that browsers open', async () => {
    const basePath = uniqueBasePath('server-create')
    const doc = await updateDocument(await serverOptions(basePath), (ydoc) => {
      ydoc.getText('t').insert(0, 'from the server')
    })
    expect(doc.getText('t').toString()).toBe('from the server')
    doc.destroy()

    const entries = Object.values((await readRaw(`${basePath}/doc/updates`)) as Record<string, { by: string }>)
    expect(entries).toHaveLength(1)
    expect(entries[0].by).toMatch(/^server-/)

    const adapter = await openAdapter(basePath)
    expect(adapter.ydoc.getText('t').toString()).toBe('from the server')
  })

  it('reads and edits a document browsers wrote, after it was merged', async () => {
    const basePath = uniqueBasePath('server-edit')
    const writer = await openAdapter(basePath)
    writer.ydoc.getText('t').insert(0, 'browser')
    await writer.flush()
    await writer.disconnect()

    const options = await serverOptions(basePath)
    const loaded = await loadDocument(options)
    expect(loaded.getText('t').toString()).toBe('browser')
    loaded.destroy()

    const updated = await updateDocument(options, (ydoc) => {
      ydoc.getText('t').insert(ydoc.getText('t').length, ' + server')
    })
    updated.destroy()

    const reader = await openAdapter(basePath)
    expect(reader.ydoc.getText('t').toString()).toBe('browser + server')
  })

  it('reaches people who have the document open, without appearing among them', async () => {
    const basePath = uniqueBasePath('server-live')
    const a = await openAdapter(basePath)
    const b = await openAdapter(basePath)
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'A and B connect' })
    const presenceEvents: number[] = []
    a.on('presence-changed', ({ peers }) => presenceEvents.push(peers.length))

    ;(await updateDocument(await serverOptions(basePath), (ydoc) => ydoc.getText('t').insert(0, 'live'))).destroy()

    await waitFor(() => a.ydoc.getText('t').toString() === 'live' && b.ydoc.getText('t').toString() === 'live', {
      message: 'server edit reaches A and B',
    })
    expect(Object.keys((await readRaw(`${basePath}/doc/rooms/peers`)) as object)).toHaveLength(2)
    expect(presenceEvents).toEqual([])
    expect(a.getPresentPeers()).toHaveLength(1)
  })

  it('merges a large log it loaded', async () => {
    const basePath = uniqueBasePath('server-merge')
    const options = await serverOptions(basePath)
    let expected = ''
    for (let i = 0; i < 20; i++) {
      const chunk = `${i}:${randomBytes(600).toString('hex')}\n`
      expected += chunk
      ;(await updateDocument(options, (ydoc) => ydoc.getText('t').insert(ydoc.getText('t').length, chunk))).destroy()
    }

    const meta = (await readRaw(`${basePath}/doc/meta`)) as { generation: number } | null
    expect(meta?.generation).toBeGreaterThan(0)
    const doc = await loadDocument(options)
    expect(doc.getText('t').toString()).toBe(expected)
    doc.destroy()
  })

  it('writes nothing when the change makes no edits', async () => {
    const basePath = uniqueBasePath('server-noop')
    ;(await updateDocument(await serverOptions(basePath), () => {})).destroy()
    expect(await readRaw(`${basePath}/doc`)).toBeNull()
  })

  it('rejects with LoadError instead of editing an unreadable document', async () => {
    const basePath = uniqueBasePath('server-corrupt')
    await writeRaw(`${basePath}/doc/updates/bad`, { by: 'x', data: Buffer.from('not yjs').toString('base64') })
    const change = (ydoc: Y.Doc) => ydoc.getText('t').insert(0, 'lost?')
    await expect(updateDocument(await serverOptions(basePath), change)).rejects.toBeInstanceOf(LoadError)
    expect(Object.keys((await readRaw(`${basePath}/doc/updates`)) as object)).toEqual(['bad'])
  })
})
