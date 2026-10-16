import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Requires the Realtime Database emulator; run with `npm run test:emulator` from the repo root.
        test: {
          name: 'emulator',
          include: ['test/emulator/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 20_000,
          // Tests share one emulator, so run files one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
})
