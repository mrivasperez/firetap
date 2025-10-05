import type { Database } from 'firebase/database'
import type { DatabasePathsConfig } from '../../src/config'
import type { PeerInfo } from '../../src/cluster'

export const createTestDatabase = (): Database => ({
  app: { name: 'test-app' }
} as unknown as Database)

export const createTestPeerInfo = (overrides?: Partial<PeerInfo>): PeerInfo => ({
  id: 'test-peer-123',
  name: 'Test User',
  connectedAt: Date.now(),
  ...overrides
})

export const createTestDatabasePaths = (overrides?: Partial<DatabasePathsConfig>): DatabasePathsConfig => ({
  structure: 'flat',
  flat: {
    documents: '/test-docs',
    rooms: '/test-rooms',
    snapshots: '/test-snaps',
    signaling: '/test-signals'
  },
  ...overrides
})

export const createCustomDatabasePaths = (prefix: string): DatabasePathsConfig => ({
  structure: 'flat',
  flat: {
    documents: `/${prefix}-docs`,
    rooms: `/${prefix}-rooms`,
    snapshots: `/${prefix}-snaps`,
    signaling: `/${prefix}-signals`
  }
})

export const waitFor = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const generateMockBase64 = (content: string): string => {
  return btoa(content)
}

export const createMockDocumentSnapshot = (overrides?: any) => ({
  update: generateMockBase64('test-update'),
  stateVector: generateMockBase64('state-vector'),
  updatedAt: Date.now(),
  version: 1,
  checksum: 'abc123def456',
  ...overrides
})
