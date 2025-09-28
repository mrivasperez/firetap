import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
    'process.env': {},
    'process.version': '"v18.0.0"',
    'process.platform': '"browser"',
  },
  resolve: {
    alias: {
      stream: 'stream-browserify',
      buffer: 'buffer',
      events: 'events',
      util: 'util',
      process: 'process/browser',
    },
  },
  optimizeDeps: {
    include: [
      'simple-peer', 
      'buffer', 
      'stream-browserify',
      'events',
      'util',
      'process'
    ]
  }
})
