import { describe, it, expect, beforeEach, vi } from 'vitest'
import { announcePresence, stopAnnouncingPresence, cleanupStalePeers, type PeerInfo } from '../src/cluster'
import type { Database } from 'firebase/database'
import type { DatabasePathsConfig } from '../src/config'
import { createTestDatabase, createTestPeerInfo } from './utils/helpers'

vi.mock('firebase/database', async () => {
  const actual = await vi.importActual('firebase/database')
  return {
    ...actual,
    ref: vi.fn((db, path) => ({ _path: path })),
    set: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    get: vi.fn(() => Promise.resolve({ exists: () => false, val: () => null })),
    query: vi.fn((ref) => ref),
    orderByChild: vi.fn(() => ({})),
    endAt: vi.fn(() => ({})),
    onDisconnect: vi.fn(() => ({
      remove: vi.fn(() => Promise.resolve())
    }))
  }
})

describe('Cluster Module', () => {
  let mockDatabase: Database
  const mockDocId = 'test-doc'
  const mockPeer: PeerInfo = createTestPeerInfo({ id: 'peer-123', name: 'Test User' })

  beforeEach(() => {
    mockDatabase = createTestDatabase()
    vi.clearAllMocks()
  })

  describe('announcePresence', () => {
    it('should announce peer presence to Firebase', async () => {
      const { set } = await import('firebase/database')

      await announcePresence(mockDatabase, mockDocId, mockPeer)

      expect(set).toHaveBeenCalled()
    })

    it('should include peer ID in announcement', async () => {
      const { set } = await import('firebase/database')

      await announcePresence(mockDatabase, mockDocId, mockPeer)

      const callArgs = vi.mocked(set).mock.calls[0]
      const peerData = callArgs[1]
      expect(peerData).toHaveProperty('id', mockPeer.id)
    })

    it('should include peer name in announcement', async () => {
      const { set } = await import('firebase/database')

      await announcePresence(mockDatabase, mockDocId, mockPeer)

      const callArgs = vi.mocked(set).mock.calls[0]
      const peerData = callArgs[1]
      expect(peerData).toHaveProperty('name', mockPeer.name)
    })

    it('should add timestamp to peer data', async () => {
      const { set } = await import('firebase/database')
      const beforeTime = Date.now()

      await announcePresence(mockDatabase, mockDocId, mockPeer)

      const callArgs = vi.mocked(set).mock.calls[0]
      const peerData = callArgs[1] as any
      const afterTime = Date.now()

      expect(peerData).toHaveProperty('lastSeen')
      expect(peerData.lastSeen).toBeGreaterThanOrEqual(beforeTime)
      expect(peerData.lastSeen).toBeLessThanOrEqual(afterTime)
    })

    it('should set up disconnect cleanup', async () => {
      const { onDisconnect } = await import('firebase/database')

      await announcePresence(mockDatabase, mockDocId, mockPeer)

      expect(onDisconnect).toHaveBeenCalled()
    })

    it('should use custom database paths when provided', async () => {
      const { ref } = await import('firebase/database')
      const customPaths: DatabasePathsConfig = {
        structure: 'flat',
        flat: {
          documents: '/custom-docs',
          rooms: '/custom-rooms',
          snapshots: '/custom-snaps',
          signaling: '/custom-signals'
        }
      }

      await announcePresence(mockDatabase, mockDocId, mockPeer, customPaths)

      const refCalls = vi.mocked(ref).mock.calls
      const pathUsed = refCalls[0][1]
      expect(pathUsed).toContain('custom-rooms')
    })

    it('should handle errors gracefully', async () => {
      const { set } = await import('firebase/database')
      vi.mocked(set).mockRejectedValueOnce(new Error('Network error'))

      await expect(announcePresence(mockDatabase, mockDocId, mockPeer)).rejects.toThrow('Network error')
    })
  })

  describe('stopAnnouncingPresence', () => {
    it('should remove peer presence from Firebase', async () => {
      const { remove } = await import('firebase/database')

      await stopAnnouncingPresence(mockDatabase, mockDocId, mockPeer.id)

      expect(remove).toHaveBeenCalled()
    })

    it('should target correct peer path', async () => {
      const { ref } = await import('firebase/database')

      await stopAnnouncingPresence(mockDatabase, mockDocId, mockPeer.id)

      const refCalls = vi.mocked(ref).mock.calls
      const pathUsed = refCalls[0][1]
      expect(pathUsed).toContain(mockPeer.id)
    })

    it('should use custom database paths when provided', async () => {
      const { ref } = await import('firebase/database')
      const customPaths: DatabasePathsConfig = {
        structure: 'flat',
        flat: {
          documents: '/custom-docs',
          rooms: '/custom-rooms',
          snapshots: '/custom-snaps',
          signaling: '/custom-signals'
        }
      }

      await stopAnnouncingPresence(mockDatabase, mockDocId, mockPeer.id, customPaths)

      const refCalls = vi.mocked(ref).mock.calls
      const pathUsed = refCalls[0][1]
      expect(pathUsed).toContain('custom-rooms')
    })

    it('should not throw on cleanup errors', async () => {
      const { remove } = await import('firebase/database')
      vi.mocked(remove).mockRejectedValueOnce(new Error('Network error'))

      await expect(stopAnnouncingPresence(mockDatabase, mockDocId, mockPeer.id)).resolves.toBeUndefined()
    })
  })

  describe('cleanupStalePeers', () => {
    it('should query for stale peers', async () => {
      const { query, get } = await import('firebase/database')

      await cleanupStalePeers(mockDatabase, mockDocId)

      expect(query).toHaveBeenCalled()
      expect(get).toHaveBeenCalled()
    })

    it('should not remove anything when no stale peers exist', async () => {
      const { get, remove } = await import('firebase/database')
      vi.mocked(get).mockResolvedValueOnce({
        exists: () => false,
        val: () => null
      } as any)

      await cleanupStalePeers(mockDatabase, mockDocId)

      expect(remove).not.toHaveBeenCalled()
    })

    it('should remove stale peer presence data', async () => {
      const { get, remove } = await import('firebase/database')
      const stalePeer = {
        'stale-peer-1': {
          id: 'stale-peer-1',
          name: 'Stale User',
          connectedAt: Date.now() - 500000,
          lastSeen: Date.now() - 500000
        }
      }

      vi.mocked(get).mockResolvedValueOnce({
        exists: () => true,
        val: () => stalePeer
      } as any)

      await cleanupStalePeers(mockDatabase, mockDocId)

      expect(remove).toHaveBeenCalled()
    })

    it('should remove signaling data for stale peers', async () => {
      const { get, remove, ref } = await import('firebase/database')
      const stalePeer = {
        'stale-peer-1': {
          id: 'stale-peer-1',
          name: 'Stale User',
          connectedAt: Date.now() - 500000,
          lastSeen: Date.now() - 500000
        }
      }

      vi.mocked(get).mockResolvedValueOnce({
        exists: () => true,
        val: () => stalePeer
      } as any)

      await cleanupStalePeers(mockDatabase, mockDocId)

      const refCalls = vi.mocked(ref).mock.calls
      const signalingPath = refCalls.find(call => call[1] && call[1].includes('signaling'))
      expect(signalingPath).toBeDefined()
    })

    it('should handle multiple stale peers', async () => {
      const { get, remove } = await import('firebase/database')
      const stalePeers = {
        'stale-peer-1': {
          id: 'stale-peer-1',
          name: 'Stale User 1',
          connectedAt: Date.now() - 500000,
          lastSeen: Date.now() - 500000
        },
        'stale-peer-2': {
          id: 'stale-peer-2',
          name: 'Stale User 2',
          connectedAt: Date.now() - 600000,
          lastSeen: Date.now() - 600000
        }
      }

      vi.mocked(get).mockResolvedValueOnce({
        exists: () => true,
        val: () => stalePeers
      } as any)

      await cleanupStalePeers(mockDatabase, mockDocId)

      const removeCalls = vi.mocked(remove).mock.calls
      expect(removeCalls.length).toBeGreaterThan(0)
    })

    it('should use custom database paths when provided', async () => {
      const { ref } = await import('firebase/database')
      const customPaths: DatabasePathsConfig = {
        structure: 'flat',
        flat: {
          documents: '/custom-docs',
          rooms: '/custom-rooms',
          snapshots: '/custom-snaps',
          signaling: '/custom-signals'
        }
      }

      await cleanupStalePeers(mockDatabase, mockDocId, customPaths)

      const refCalls = vi.mocked(ref).mock.calls
      const pathUsed = refCalls[0][1]
      expect(pathUsed).toContain('custom-rooms')
    })

    it('should not throw on cleanup errors', async () => {
      const { get } = await import('firebase/database')
      vi.mocked(get).mockRejectedValueOnce(new Error('Network error'))

      await expect(cleanupStalePeers(mockDatabase, mockDocId)).resolves.toBeUndefined()
    })

    it('should order query by lastSeen timestamp', async () => {
      const { orderByChild } = await import('firebase/database')

      await cleanupStalePeers(mockDatabase, mockDocId)

      expect(orderByChild).toHaveBeenCalledWith('lastSeen')
    })

    it('should filter peers by stale threshold', async () => {
      const { endAt } = await import('firebase/database')

      await cleanupStalePeers(mockDatabase, mockDocId)

      expect(endAt).toHaveBeenCalled()
      const threshold = vi.mocked(endAt).mock.calls[0][0]
      expect(threshold).toBeLessThan(Date.now())
    })
  })

  describe('PeerInfo type', () => {
    it('should have required id property', () => {
      const peer: PeerInfo = {
        id: 'test-id',
        name: 'Test',
        connectedAt: Date.now()
      }

      expect(peer.id).toBeDefined()
    })

    it('should have required name property', () => {
      const peer: PeerInfo = {
        id: 'test-id',
        name: 'Test',
        connectedAt: Date.now()
      }

      expect(peer.name).toBeDefined()
    })

    it('should have required connectedAt timestamp', () => {
      const peer: PeerInfo = {
        id: 'test-id',
        name: 'Test',
        connectedAt: Date.now()
      }

      expect(peer.connectedAt).toBeDefined()
      expect(typeof peer.connectedAt).toBe('number')
    })
  })
})
