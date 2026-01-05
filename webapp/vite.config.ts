import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  appType: 'mpa',
  publicDir: 'static',
  server: {
    port: 5555, // Frontend development server - FIXED PORT, NO FALLBACK
    host: '127.0.0.1',
    strictPort: true, // Force port 5555, no alternative ports
    open: false,
    hmr: {
      overlay: true,
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5556',
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: 'ws://127.0.0.1:5556',
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist/static', // Only used for `vite build` command
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: [],
        },
      },
    },
  },
  optimizeDeps: {
    include: [],
  },
});
