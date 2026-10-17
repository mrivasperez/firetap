import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['index.ts', 'server.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  external: ['firebase', 'firebase-admin', 'yjs', 'y-protocols', 'lib0'],
})
