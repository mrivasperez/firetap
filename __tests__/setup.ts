import { beforeEach } from 'vitest'
import { vi } from 'vitest'

// Setup Firebase mocks for all tests
export const mockFirebase = {
  ref: vi.fn((db, path) => ({ _path: path })),
  set: vi.fn(() => Promise.resolve()),
  get: vi.fn(() => Promise.resolve({
    exists: () => false,
    val: () => null
  })),
  remove: vi.fn(() => Promise.resolve()),
  update: vi.fn(() => Promise.resolve()),
  push: vi.fn(() => ({ key: 'test-key' })),
  query: vi.fn((ref) => ref),
  orderByChild: vi.fn(() => ({})),
  endAt: vi.fn(() => ({})),
  onValue: vi.fn(),
  off: vi.fn(),
  onDisconnect: vi.fn(() => ({
    remove: vi.fn(() => Promise.resolve()),
    set: vi.fn(() => Promise.resolve())
  })),
  serverTimestamp: vi.fn(() => ({ '.sv': 'timestamp' }))
}

// Auto-clear mocks before each test
beforeEach(() => {
  vi.clearAllMocks()
})
