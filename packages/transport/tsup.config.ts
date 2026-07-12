import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['winston', 'winston-transport'],
  // sqlite-spool.ts uses createRequire(import.meta.url) to lazily load
  // node:sqlite — import.meta is unavailable in the CJS output, so tsup
  // needs to inject its shim for that format.
  shims: true,
})
