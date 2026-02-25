import path from 'path';
import { defineConfig } from 'vite';

function resolveDevBackendOrigin(command: 'build' | 'serve'): string | null {
  const raw = process.env.DOMINDS_DEV_BACKEND_ORIGIN?.trim();
  if (command === 'serve' && !raw) {
    throw new Error(
      'DOMINDS_DEV_BACKEND_ORIGIN is required in dev serve mode. Set it from outer dev-server.sh.',
    );
  }
  return raw || null;
}

function toWebSocketOrigin(origin: string): string {
  if (origin.startsWith('http://')) {
    return `ws://${origin.slice('http://'.length)}`;
  }
  if (origin.startsWith('https://')) {
    return `wss://${origin.slice('https://'.length)}`;
  }
  if (origin.startsWith('ws://') || origin.startsWith('wss://')) {
    return origin;
  }
  throw new Error(
    `DOMINDS_DEV_BACKEND_ORIGIN must start with http://, https://, ws://, or wss://; got '${origin}'`,
  );
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const backendOrigin = resolveDevBackendOrigin(command);
  const backendWebSocketOrigin = backendOrigin ? toWebSocketOrigin(backendOrigin) : null;

  return {
    appType: 'spa',
    publicDir: 'static',
    server: {
      host: '127.0.0.1',
      strictPort: true,
      open: false,
      fs: {
        // Allow importing small shared TS modules from the Dominds monorepo (e.g. `../main/shared/*`).
        // This keeps certain “shared constants” as a single source of truth across backend + frontend.
        allow: [path.resolve(__dirname, '..')],
      },
      hmr: {
        overlay: true,
      },
      proxy: backendOrigin
        ? {
            '/api': {
              target: backendOrigin,
              changeOrigin: true,
              secure: false,
            },
            '/ws': {
              target: backendWebSocketOrigin!,
              ws: true,
              changeOrigin: true,
              secure: false,
            },
          }
        : undefined,
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
  };
});
