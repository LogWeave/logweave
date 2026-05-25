import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/healthz': 'http://localhost:3000',
      '/readyz': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // vite 8 + rolldown requires the function form for manualChunks.
        // The object-form `{ name: [modules] }` was dropped.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/echarts/') || id.includes('echarts-renderer')) return 'echarts'
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/react-router-dom/')
            ) {
              return 'vendor'
            }
            if (id.includes('/@tanstack/')) return 'query'
          }
          return undefined
        },
      },
    },
  },
})
