import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: './vitest.setup.ts',
    include: ['src/**/*.{test,spec}.ts', '__tests__/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist', 'client', 'firebase-project'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts', 'index.ts'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/*.d.ts',
        '__tests__/**'
      ]
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
})
