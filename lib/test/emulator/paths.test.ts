import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import { closeClients, createClient, readRaw, setRules } from './helpers'

describe('default database paths', () => {
  beforeAll(() => setRules())
  afterAll(() => closeClients())

  it('keeps documents opened with default options isolated', async () => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const docA = `paths-a-${run}`
    const docB = `paths-b-${run}`

    const a = await createFirebaseYWebrtcAdapter({ docId: docA, firebaseDatabase: createClient() })
    a.ydoc.getText('t').insert(0, 'only in A')
    await a.forcePersist()
    a.disconnect()

    const b = await createFirebaseYWebrtcAdapter({ docId: docB, firebaseDatabase: createClient() })
    expect(b.ydoc.getText('t').toString()).toBe('')
    b.disconnect()

    expect(await readRaw(`/documents/${docA}/snapshots/latest/update`)).toEqual(expect.any(String))
    expect(await readRaw(`/documents/${docB}/snapshots/latest`)).toBeNull()
  })

  it('rejects an invalid docId before touching Firebase', async () => {
    await expect(
      createFirebaseYWebrtcAdapter({ docId: '../other', firebaseDatabase: createClient() })
    ).rejects.toThrow(/docId/)
  })
})
