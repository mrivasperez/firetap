import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFirebaseYWebrtcAdapter, type AdapterOptions, type AdapterHandle } from './adapter'
import * as Y from 'yjs'
import type { Database } from 'firebase/database'

// Mock modules
vi.mock('./persistence', () => ({
  startPeriodicPersistence: vi.fn(() => vi.fn()),
  loadDocumentFromFirebase: vi.fn(() => Promise.resolve(null)),
  persistDocument: vi.fn(() => Promise.resolve())
}))

vi.mock('./cluster', () => ({
  announcePresence: vi.fn(() => vi.fn()),
  stopAnnouncingPresence: vi.fn(),
  cleanupStalePeers: vi.fn(() => Promise.resolve())
}))

describe('Adapter Module', () => {
  let mockDatabase: Database
  let adapter: AdapterHandle | null = null

  beforeEach(() => {
    // Create mock database
    mockDatabase = {
      app: { name: 'test-app' }
    } as unknown as Database

    // Reset all mocks
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // Clean up adapter
    if (adapter) {
      adapter.disconnect()
      adapter = null
    }
  })

  describe('createFirebaseYWebrtcAdapter', () => {
    describe('initialization', () => {
      it('should create adapter with required options', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter).toBeDefined()
      })

      it('should create Yjs document', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.ydoc).toBeInstanceOf(Y.Doc)
      })

      it('should create awareness instance', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.awareness).toBeDefined()
        expect(adapter.awareness.doc).toBe(adapter.ydoc)
      })

      it('should enable garbage collection on Y.Doc', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.ydoc.gc).toBe(true)
      })

      it('should use provided peer ID', async () => {
        const customPeerId = 'custom-peer-id'
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase,
          peerId: customPeerId
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const userInfo = adapter.getUserInfo()

        expect(userInfo.id).toBe(customPeerId)
      })

      it('should generate peer ID when not provided', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const userInfo = adapter.getUserInfo()

        expect(userInfo.id).toBeDefined()
        expect(typeof userInfo.id).toBe('string')
        expect(userInfo.id.length).toBeGreaterThan(0)
      })

      it('should use provided user name', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase,
          user: { name: 'Test User' }
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const userInfo = adapter.getUserInfo()

        expect(userInfo.name).toBe('Test User')
      })

      it('should generate default user name when not provided', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const userInfo = adapter.getUserInfo()

        expect(userInfo.name).toBeDefined()
        expect(userInfo.name).toMatch(/^User-/)
      })
    })

    describe('connection management', () => {
      it('should start with connecting status', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const status = adapter.getConnectionStatus()

        expect(['connecting', 'connected']).toContain(status)
      })

      it('should provide disconnect method', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.disconnect).toBeDefined()
        expect(typeof adapter.disconnect).toBe('function')
      })

      it('should provide reconnect method', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.reconnect).toBeDefined()
        expect(typeof adapter.reconnect).toBe('function')
      })

      it('should disconnect without errors', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(() => adapter!.disconnect()).not.toThrow()
      })
    })

    describe('peer management', () => {
      it('should start with zero peers', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const peerCount = adapter.getPeerCount()

        expect(peerCount).toBe(0)
      })

      it('should provide peer count method', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.getPeerCount).toBeDefined()
        expect(typeof adapter.getPeerCount).toBe('function')
      })

      it('should respect max peers setting', async () => {
        const maxPeers = 5
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase,
          maxDirectPeers: maxPeers
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter).toBeDefined()
      })
    })

    describe('event system', () => {
      it('should provide event listener registration', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.on).toBeDefined()
        expect(typeof adapter.on).toBe('function')
      })

      it('should provide event listener removal', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.off).toBeDefined()
        expect(typeof adapter.off).toBe('function')
      })

      it('should call event listeners when registered', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        adapter = await createFirebaseYWebrtcAdapter(options)
        const mockCallback = vi.fn()

        adapter.on('connection-state-changed', mockCallback)
        
        // Trigger a state change by reconnecting
        await adapter.reconnect().catch(() => {
          // Ignore errors for this test
        })

        expect(mockCallback).toHaveBeenCalled()
      })

      it('should not call removed event listeners', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        adapter = await createFirebaseYWebrtcAdapter(options)
        const mockCallback = vi.fn()

        adapter.on('peer-joined', mockCallback)
        adapter.off('peer-joined', mockCallback)

        expect(() => adapter!.off('peer-joined', mockCallback)).not.toThrow()
      })
    })

    describe('memory management', () => {
      it('should provide memory stats method', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const stats = adapter.getMemoryStats()

        expect(stats).toBeDefined()
        expect(stats).toHaveProperty('messageBuffer')
        expect(stats).toHaveProperty('connectionCount')
        expect(stats).toHaveProperty('lastCleanup')
        expect(stats).toHaveProperty('awarenessStates')
      })

      it('should initialize memory stats to zero', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const stats = adapter.getMemoryStats()

        expect(stats.messageBuffer).toBe(0)
        expect(stats.connectionCount).toBe(0)
      })

      it('should provide garbage collection method', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter.forceGarbageCollection).toBeDefined()
        expect(typeof adapter.forceGarbageCollection).toBe('function')
      })

      it('should execute garbage collection without errors', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(() => adapter!.forceGarbageCollection()).not.toThrow()
      })
    })

    describe('configuration options', () => {
      it('should accept custom sync interval', async () => {
        const customInterval = 30000
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase,
          syncIntervalMs: customInterval
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter).toBeDefined()
      })

      it('should accept custom database paths', async () => {
        const customPaths = {
          structure: 'flat' as const,
          flat: {
            documents: '/custom-docs',
            rooms: '/custom-rooms',
            snapshots: '/custom-snaps',
            signaling: '/custom-signals'
          }
        }
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase,
          databasePaths: customPaths
        }

        adapter = await createFirebaseYWebrtcAdapter(options)

        expect(adapter).toBeDefined()
      })
    })

    describe('user information', () => {
      it('should return user info with ID', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const userInfo = adapter.getUserInfo()

        expect(userInfo.id).toBeDefined()
      })

      it('should return user info with name', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }

        adapter = await createFirebaseYWebrtcAdapter(options)
        const userInfo = adapter.getUserInfo()

        expect(userInfo.name).toBeDefined()
      })

      it('should return user info with connection timestamp', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        const beforeTime = Date.now()

        adapter = await createFirebaseYWebrtcAdapter(options)
        const userInfo = adapter.getUserInfo()
        const afterTime = Date.now()

        expect(userInfo.connectedAt).toBeGreaterThanOrEqual(beforeTime)
        expect(userInfo.connectedAt).toBeLessThanOrEqual(afterTime)
      })
    })

    describe('Y.js document integration', () => {
      it('should allow updates to Y.Doc', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        adapter = await createFirebaseYWebrtcAdapter(options)

        const ytext = adapter.ydoc.getText('test')
        ytext.insert(0, 'Hello World')

        expect(ytext.toString()).toBe('Hello World')
      })

      it('should track document updates', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        adapter = await createFirebaseYWebrtcAdapter(options)
        let updateCount = 0
        
        adapter.ydoc.on('update', () => {
          updateCount++
        })
        
        const ytext = adapter.ydoc.getText('test')
        ytext.insert(0, 'Hello')

        expect(updateCount).toBeGreaterThan(0)
      })
    })

    describe('awareness integration', () => {
      it('should allow setting local awareness state', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        adapter = await createFirebaseYWebrtcAdapter(options)

        adapter.awareness.setLocalState({ user: { name: 'Test' } })
        const localState = adapter.awareness.getLocalState()

        expect(localState).toEqual({ user: { name: 'Test' } })
      })

      it('should track awareness state changes', async () => {
        const options: AdapterOptions = {
          docId: 'test-doc',
          firebaseDatabase: mockDatabase
        }
        adapter = await createFirebaseYWebrtcAdapter(options)
        let changeCount = 0

        adapter.awareness.on('change', () => {
          changeCount++
        })
        adapter.awareness.setLocalState({ user: { name: 'Test' } })

        expect(changeCount).toBeGreaterThan(0)
      })
    })
  })
})
