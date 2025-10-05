import { describe, it, expect } from 'vitest'
import {
  buildDatabasePaths,
  DEFAULT_DATABASE_PATHS,
  DEFAULT_CONFIG,
  createSimpleConfig,
  createWorkspaceConfig,
  createAdapterConfig,
  validateConfig,
  generateUserId,
  type DatabasePathsConfig
} from './config'

describe('Config Module', () => {
  describe('buildDatabasePaths', () => {
    it('should build nested paths with document ID', () => {
      const paths = buildDatabasePaths(DEFAULT_DATABASE_PATHS, 'test-doc')

      expect(paths.documents).toBe('/documents/test-doc/documents')
      expect(paths.rooms).toBe('/documents/test-doc/rooms')
      expect(paths.snapshots).toBe('/documents/test-doc/snapshots')
      expect(paths.signaling).toBe('/documents/test-doc/signaling')
    })

    it('should build flat paths when structure is flat', () => {
      const flatConfig: DatabasePathsConfig = {
        structure: 'flat',
        flat: {
          documents: '/docs',
          rooms: '/rooms',
          snapshots: '/snaps',
          signaling: '/signals'
        }
      }

      const paths = buildDatabasePaths(flatConfig, 'test-doc')

      expect(paths.documents).toBe('/docs')
      expect(paths.rooms).toBe('/rooms')
      expect(paths.snapshots).toBe('/snaps')
      expect(paths.signaling).toBe('/signals')
    })

    it('should handle workspace paths', () => {
      const workspaceConfig: DatabasePathsConfig = {
        structure: 'nested',
        nested: {
          basePath: '/workspace-1/documents',
          subPaths: {
            documents: 'documents',
            rooms: 'rooms',
            snapshots: 'snapshots',
            signaling: 'signaling'
          }
        }
      }

      const paths = buildDatabasePaths(workspaceConfig, 'doc-1')

      expect(paths.documents).toBe('/workspace-1/documents/doc-1/documents')
      expect(paths.signaling).toBe('/workspace-1/documents/doc-1/signaling')
    })

    it('should throw error for flat structure without flat config', () => {
      const invalidConfig: DatabasePathsConfig = {
        structure: 'flat'
      }

      expect(() => buildDatabasePaths(invalidConfig, 'test-doc')).toThrow('Flat structure requires flat config')
    })

    it('should throw error for nested structure without nested config', () => {
      const invalidConfig: DatabasePathsConfig = {
        structure: 'nested'
      }

      expect(() => buildDatabasePaths(invalidConfig, 'test-doc')).toThrow('Nested structure requires nested config')
    })
  })

  describe('createSimpleConfig', () => {
    it('should create a valid simple configuration', () => {
      const config = createSimpleConfig('doc-1', { name: 'Test User' })

      expect(config.docId).toBe('doc-1')
      expect(config.user.name).toBe('Test User')
      expect(config.maxDirectPeers).toBe(6)
      expect(config.syncIntervalMs).toBe(15000)
      expect(config.databasePaths).toBeDefined()
      expect(config.databasePaths?.structure).toBe('nested')
    })

    it('should not include firebaseDatabase', () => {
      const config = createSimpleConfig('doc-1', { name: 'Test User' })
      
      expect(config).not.toHaveProperty('firebaseDatabase')
    })
  })

  describe('createWorkspaceConfig', () => {
    it('should create workspace configuration with custom base path', () => {
      const config = createWorkspaceConfig('doc-1', 'workspace-1', { name: 'Test User' })

      expect(config.docId).toBe('doc-1')
      expect(config.user.name).toBe('Test User')
      expect(config.databasePaths?.structure).toBe('nested')
      
      if (config.databasePaths?.structure === 'nested') {
        expect(config.databasePaths.nested?.basePath).toBe('/workspace-1/documents')
      }
    })

    it('should generate correct paths for workspace', () => {
      const config = createWorkspaceConfig('doc-1', 'my-workspace', { name: 'Test User' })
      
      if (config.databasePaths) {
        const paths = buildDatabasePaths(config.databasePaths, 'doc-1')
        expect(paths.documents).toContain('my-workspace')
      }
    })
  })

  describe('createAdapterConfig', () => {
    it('should merge with default config', () => {
      const config = createAdapterConfig({
        docId: 'test-doc',
        user: { name: 'Custom User' }
      })

      expect(config.docId).toBe('test-doc')
      expect(config.user.name).toBe('Custom User')
      expect(config.maxDirectPeers).toBe(DEFAULT_CONFIG.maxDirectPeers)
      expect(config.syncIntervalMs).toBe(DEFAULT_CONFIG.syncIntervalMs)
    })

    it('should allow overriding defaults', () => {
      const config = createAdapterConfig({
        docId: 'test-doc',
        user: { name: 'User' },
        maxDirectPeers: 10,
        syncIntervalMs: 30000
      })

      expect(config.maxDirectPeers).toBe(10)
      expect(config.syncIntervalMs).toBe(30000)
    })

    it('should use provided database paths', () => {
      const customPaths: DatabasePathsConfig = {
        structure: 'flat',
        flat: {
          documents: '/custom-docs',
          rooms: '/custom-rooms',
          snapshots: '/custom-snaps',
          signaling: '/custom-signals'
        }
      }

      const config = createAdapterConfig({
        docId: 'test-doc',
        user: { name: 'User' },
        databasePaths: customPaths
      })

      expect(config.databasePaths).toEqual(customPaths)
    })
  })

  describe('validateConfig', () => {
    it('should return empty array for valid configuration', () => {
      const errors = validateConfig({
        docId: 'test-doc',
        user: { name: 'Test User' },
        maxDirectPeers: 6,
        syncIntervalMs: 15000
      })

      expect(errors).toEqual([])
    })

    it('should error on empty document ID', () => {
      const errors = validateConfig({
        docId: '   ',
        user: { name: 'Test User' }
      })

      expect(errors).toContain('Document ID cannot be empty')
    })

    it('should error on empty user name', () => {
      const errors = validateConfig({
        docId: 'test-doc',
        user: { name: '   ' }
      })

      expect(errors).toContain('User name cannot be empty')
    })

    it('should error on invalid direct peers count', () => {
      const errors = validateConfig({
        docId: 'test-doc',
        user: { name: 'Test User' },
        maxDirectPeers: -1  // Negative number
      })

      expect(errors).toContain('Max direct peers must be between 1 and 20')
    })

    it('should error on too many direct peers', () => {
      const errors = validateConfig({
        docId: 'test-doc',
        user: { name: 'Test User' },
        maxDirectPeers: 100
      })

      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain('Max direct peers must be between')
    })

    it('should error on sync interval too low', () => {
      const errors = validateConfig({
        docId: 'test-doc',
        user: { name: 'Test User' },
        syncIntervalMs: 500
      })

      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain('Sync interval must be at least')
    })

    it('should return multiple errors when multiple issues exist', () => {
      const errors = validateConfig({
        docId: '   ',  // Empty when trimmed
        user: { name: '   ' },  // Empty when trimmed
        maxDirectPeers: -5,  // Negative (invalid)
        syncIntervalMs: 100  // Too low
      })

      expect(errors.length).toBeGreaterThanOrEqual(2)
      expect(errors).toContain('Document ID cannot be empty')
      expect(errors).toContain('User name cannot be empty')
    })
  })

  describe('generateUserId', () => {
    it('should generate a valid user ID', () => {
      const userId = generateUserId()
      
      expect(userId).toBeDefined()
      expect(typeof userId).toBe('string')
      expect(userId).toMatch(/^user-\d+-[a-z0-9]+$/)
    })

    it('should generate unique IDs', () => {
      const id1 = generateUserId()
      const id2 = generateUserId()
      
      expect(id1).not.toBe(id2)
    })

    it('should start with "user-" prefix', () => {
      const userId = generateUserId()
      expect(userId).toMatch(/^user-/)
    })
  })

  describe('DEFAULT_DATABASE_PATHS', () => {
    it('should have nested structure', () => {
      expect(DEFAULT_DATABASE_PATHS.structure).toBe('nested')
    })

    it('should have all required nested subPaths', () => {
      expect(DEFAULT_DATABASE_PATHS.nested).toBeDefined()
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty('documents')
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty('rooms')
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty('snapshots')
      expect(DEFAULT_DATABASE_PATHS.nested?.subPaths).toHaveProperty('signaling')
    })

    it('should have basePath defined', () => {
      expect(DEFAULT_DATABASE_PATHS.nested?.basePath).toBe('/documents')
    })
  })

  describe('DEFAULT_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_CONFIG.docId).toBe('default-doc')
      expect(DEFAULT_CONFIG.user.name).toBe('Anonymous User')
      expect(DEFAULT_CONFIG.maxDirectPeers).toBeGreaterThan(0)
      expect(DEFAULT_CONFIG.syncIntervalMs).toBeGreaterThan(0)
      expect(DEFAULT_CONFIG.autoReconnect).toBe(true)
    })

    it('should have connection settings', () => {
      expect(DEFAULT_CONFIG.connectionTimeout).toBeGreaterThan(0)
      expect(DEFAULT_CONFIG.heartbeatInterval).toBeGreaterThan(0)
    })

    it('should have UI settings', () => {
      expect(DEFAULT_CONFIG.placeholder).toBeDefined()
      expect(typeof DEFAULT_CONFIG.showConnectionStatus).toBe('boolean')
      expect(typeof DEFAULT_CONFIG.showPeerCount).toBe('boolean')
    })
  })
})

