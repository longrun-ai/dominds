/**
 * Module: server
 *
 * HTTP/WebSocket server for both development and production modes:
 * - Serves static files with MIME detection and SPA fallback (production)
 * - Provides `/api/*` endpoints and `/ws` WebSocket communication
 * - CLI bootstrap with optional cwd/port/host/mode parameters
 * - Development mode: `tsx --watch src/server.ts -p 5556 --mode dev`
 * - Production mode: `node dist/server.js` (default port 5666)
 */
import * as path from 'path';
import { WebSocket } from 'ws';
import { runBackendDriver } from './llm/driver';
import { createLogger } from './log';
import { DialogPersistence } from './persistence';
import { computeAuthConfig } from './server/auth';
import { createHttpServer, ServerConfig } from './server/server-core';
import { setupWebSocketServer } from './server/websocket-handler';

const log = createLogger('server');

// Setup unhandled rejection handler to capture crashes
process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise);
  log.error('Reason:', reason instanceof Error ? reason : new Error(String(reason)));
  log.error(
    'Stack trace:',
    (reason instanceof Error && reason.stack) || 'No stack trace available',
  );

  // Optionally, we could exit the process here with code 1
  // But in development, we might want to keep running
});

// Setup uncaught exception handler
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
  log.error('Stack trace:', error.stack);

  // Optionally, exit with code 1
  // process.exit(1);
});

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-C' || a === '--chdir') {
      out['C'] = argv[i + 1];
      i++;
      continue;
    }
    if (a === '-p' || a === '--port') {
      out['p'] = argv[i + 1];
      i++;
      continue;
    }
    if (a === '-H' || a === '--host') {
      out['H'] = argv[i + 1];
      i++;
      continue;
    }
    if (a === '--mode') {
      out['mode'] = argv[i + 1];
      i++;
      continue;
    }
  }
  return out;
}

export type ServerOptions = {
  port?: number;
  host?: string;
  mode?: 'dev' | 'prod';
};

export async function startServer(opts: ServerOptions = {}) {
  // Get port and host from options
  const port = opts.port || (opts.mode === 'dev' ? 5556 : 5666);
  const host = opts.host || '127.0.0.1';
  const mode = opts.mode || 'prod';

  log.info(`Starting server in ${mode} mode on ${host}:${port}`);

  // WebSocket clients set
  const clients = new Set<WebSocket>();

  // Create server configuration
  const config: ServerConfig = {
    mode: mode === 'dev' ? 'development' : 'production',
    staticRoot: 'dist/static',
    host,
    port,
    clients,
    auth: computeAuthConfig({
      mode: mode === 'dev' ? 'development' : 'production',
      env: process.env,
    }),
  };

  // Create HTTP server
  const httpServer = createHttpServer(config);

  // Setup WebSocket server
  setupWebSocketServer(httpServer.getHttpServer(), clients, config.auth ?? { kind: 'disabled' });

  // Start backend driver loop (non-blocking)
  void runBackendDriver();

  // Start listening
  await httpServer.start();

  return httpServer.getHttpServer();
}

// Main function for CLI execution
async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));

  // Handle working directory change from -C flag
  const wsDir = cliArgs['C'] as string;
  if (wsDir) {
    // Resolve to absolute path before changing directory
    const absoluteWsDir = path.isAbsolute(wsDir) ? wsDir : path.resolve(process.cwd(), wsDir);
    try {
      process.chdir(wsDir);
    } catch (err) {
      log.warn(`Failed to change working directory to ${wsDir}:`, err);
    }
    // Set workspace root for persistence modules (uses absolute path)
    DialogPersistence.setWorkspaceRoot(absoluteWsDir);
  } else {
    // Still set workspace root even without -C flag for consistency
    DialogPersistence.setWorkspaceRoot(process.cwd());
  }

  // Get port, host, and mode from CLI args
  const port = cliArgs['p'] ? Number(cliArgs['p']) : undefined;
  const host = (cliArgs['H'] as string) || undefined;
  const mode = (cliArgs['mode'] as 'dev' | 'prod') || undefined;

  await startServer({ port, host, mode });
}

// Start server if this file is run directly
if (require.main === module) {
  main().catch((error) => {
    log.error('Web UI startup failed', error);
    process.exit(1);
  });
}
