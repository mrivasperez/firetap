import { vi } from 'vitest'

export const setupPersistenceMocks = () => {
  const mocks = {
    startPeriodicPersistence: vi.fn(() => vi.fn()),
    loadDocumentFromFirebase: vi.fn(() => Promise.resolve(null)),
    persistDocument: vi.fn(() => Promise.resolve())
  }
  
  vi.mock('../../src/persistence', () => mocks)
  
  return mocks
}

export const setupClusterMocks = () => {
  const mocks = {
    announcePresence: vi.fn(() => vi.fn()),
    stopAnnouncingPresence: vi.fn(),
    cleanupStalePeers: vi.fn(() => Promise.resolve())
  }
  
  vi.mock('../../src/cluster', () => mocks)
  
  return mocks
}

export const setupSimplePeerMock = () => {
  const mockPeerInstance = {
    on: vi.fn(),
    send: vi.fn(),
    destroy: vi.fn(),
    signal: vi.fn()
  }
  
  const SimplePeerMock = vi.fn(() => mockPeerInstance)
  
  vi.mock('simple-peer', () => ({
    default: SimplePeerMock
  }))
  
  return { SimplePeerMock, mockPeerInstance }
}

export const setupUuidMock = () => {
  const v4Mock = vi.fn(() => 'test-uuid-1234')
  
  vi.mock('uuid', () => ({
    v4: v4Mock
  }))
  
  return { v4Mock }
}
