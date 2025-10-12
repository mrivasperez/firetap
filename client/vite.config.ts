import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Force a single instance of yjs to prevent constructor check failures
      'yjs': path.resolve(__dirname, './node_modules/yjs'),
      'y-protocols': path.resolve(__dirname, './node_modules/y-protocols'),
      'lib0': path.resolve(__dirname, './node_modules/lib0'),
    },
    // Deduplicate these packages to prevent multiple instances
    dedupe: ['yjs', 'y-protocols', 'lib0']
  },
})
