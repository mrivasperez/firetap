import { vi } from 'vitest'

export const createMockDatabase = () => ({
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
})

export const setupFirebaseMocks = () => {
  const mocks = createMockDatabase()
  
  vi.mock('firebase/database', async () => {
    const actual = await vi.importActual('firebase/database')
    return {
      ...actual,
      ...mocks
    }
  })
  
  return mocks
}

export const createMockFirebaseApp = () => ({
  app: { name: 'test-app' }
})
