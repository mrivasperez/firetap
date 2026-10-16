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
    await a.disconnect()

    const b = await createFirebaseYWebrtcAdapter({ docId: docB, firebaseDatabase: createClient() })
    expect(b.ydoc.getText('t').toString()).toBe('')
    await b.disconnect()

    expect(await readRaw(`/documents/${docA}/updates`)).not.toBeNull()
    expect(await readRaw(`/documents/${docB}/updates`)).toBeNull()
  })

  it('rejects an invalid docId before touching Firebase', async () => {
    await expect(
      createFirebaseYWebrtcAdapter({ docId: '../other', firebaseDatabase: createClient() })
    ).rejects.toThrow(/docId/)
  })
})
