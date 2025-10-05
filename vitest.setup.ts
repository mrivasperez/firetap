import { vi } from 'vitest'

// Mock Firebase
vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({
    name: 'test-app',
    options: {}
  }))
}))

vi.mock('firebase/database', () => ({
  getDatabase: vi.fn(() => ({})),
  ref: vi.fn(() => ({})),
  onValue: vi.fn(),
  set: vi.fn(() => Promise.resolve()),
  update: vi.fn(() => Promise.resolve()),
  push: vi.fn(() => ({ key: 'test-key' })),
  onDisconnect: vi.fn(() => ({
    remove: vi.fn(() => Promise.resolve()),
    set: vi.fn(() => Promise.resolve())
  })),
  remove: vi.fn(() => Promise.resolve()),
  get: vi.fn(() => Promise.resolve({
    exists: () => false,
    val: () => null
  }))
}))

// Mock simple-peer
vi.mock('simple-peer', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    send: vi.fn(),
    destroy: vi.fn(),
    signal: vi.fn()
  }))
}))

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234')
}))

// Setup global navigator mock if needed
if (!global.navigator) {
  global.navigator = {
    userAgent: 'test',
  } as any
}

// Mock console methods to reduce noise in tests (optional)
global.console = {
  ...console,
  error: vi.fn(),
  warn: vi.fn(),
}
