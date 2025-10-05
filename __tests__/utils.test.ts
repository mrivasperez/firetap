import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateUserId } from '../src/config'

describe('Utility Functions', () => {
  describe('generateUserId', () => {
    it('should generate a valid user ID with correct format', () => {
      const userId = generateUserId()
      
      expect(userId).toBeDefined()
      expect(typeof userId).toBe('string')
      expect(userId).toMatch(/^user-\d+-[a-z0-9]+$/)
    })

    it('should generate unique IDs on subsequent calls', () => {
      const id1 = generateUserId()
      const id2 = generateUserId()
      const id3 = generateUserId()
      
      expect(id1).not.toBe(id2)
      expect(id2).not.toBe(id3)
      expect(id1).not.toBe(id3)
    })

    it('should start with "user-" prefix', () => {
      const userId = generateUserId()
      expect(userId.startsWith('user-')).toBe(true)
    })

    it('should contain timestamp component', () => {
      const beforeTime = Date.now()
      const userId = generateUserId()
      const afterTime = Date.now()
      
      // Extract timestamp from user-{timestamp}-{random}
      const parts = userId.split('-')
      const timestamp = parseInt(parts[1])
      
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime)
      expect(timestamp).toBeLessThanOrEqual(afterTime)
    })
  })
})
