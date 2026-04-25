/**
 * Module: server
 *
 * HTTP/WebSocket server for both development and production modes:
 * - Serves static files with MIME detection and SPA fallback (production)
 * - Provides `/api/*` endpoints and `/ws` WebSocket communication
 * - CLI bootstrap with optional cwd/port/host/mode parameters
 * - Development mode: `tsx --watch src/server.ts -p <port> --mode dev`
 * - Production mode: `node dist/server.js` (default port behavior: 5666-)
 */
import * as path from 'path';
import { WebSocket } from 'ws';
import { initAppsRuntime } from './apps/runtime';
import { reconcileDisplayStatesAfterRestart } from './dialog-display-state';
import { runBackendDriver } from './llm/kernel-driver';
import { createLogger } from './log';
import { startMcpSupervisor } from './mcp/supervisor';
import { recoverPendingReplyTellaskCallsAfterRestart } from './recovery/reply-special';
import { getWorkLanguage, resolveWorkLanguage, setWorkLanguage } from './runtime/work-language';
import { AuthConfig, computeAuthConfig } from './server/auth';
import { configureDomindsSelfUpdate } from './server/dominds-self-update';
import {
  buildWebuiPortCandidates,
  DEFAULT_WEBUI_PORT,
  formatWebuiPortScanBound,
  parseWebuiPortSpec,
  type WebuiPortAutoDirection,
} from './server/port-selection';
import { createHttpServer, HttpServerCore, ServerConfig } from './server/server-core';
import { setupWebSocketServer } from './server/websocket-handler';
import './tools/builtins';

const log = createLogger('server');

// Setup unhandled rejection handler to capture crashes
process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', undefined, { promise });
  log.error('Reason:', reason instanceof Error ? reason : new Error(String(reason)));
  log.error(
    'Stack trace:',
    undefined,
    (reason instanceof Error && reason.stack) || 'No stack trace available',
  );

  // Optionally, we could exit the process here with code 1
  // But in development, we might want to keep running
});

// Setup uncaught exception handler
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
  log.error('Stack trace:', undefined, error.stack);

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
    if (a.startsWith('--port=')) {
      out['p'] = a.slice('--port='.length);
      continue;
    }
    if (a === '-H' || a === '--host') {
      out['H'] = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--host=')) {
      out['H'] = a.slice('--host='.length);
      continue;
    }
    if (a === '--mode') {
      out['mode'] = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--mode=')) {
      out['mode'] = a.slice('--mode='.length);
      continue;
    }
  }
  return out;
}

export type ServerOptions = {
  port?: number;
  host?: string;
  mode?: 'dev' | 'prod';
  startBackendDriver?: boolean;
  strictPort?: boolean;
  portAutoDirection?: WebuiPortAutoDirection;
};

export type StartedServer = {
  httpServer: HttpServerCore;
  auth: AuthConfig;
  host: string;
  port: number;
  mode: 'dev' | 'prod';
};

function getErrnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const withCode = error as Error & { code?: unknown };
  return typeof withCode.code === 'string' ? withCode.code : undefined;
}

export async function startServer(opts: ServerOptions = {}): Promise<StartedServer> {
  const { language: resolvedLanguage, source } = resolveWorkLanguage({ env: process.env });
  setWorkLanguage(resolvedLanguage);

  // Get port and host from options
  const mode = opts.mode || 'prod';
  const preferredPort = opts.port ?? DEFAULT_WEBUI_PORT;
  const strictPort = opts.strictPort ?? opts.port !== undefined;
  const portAutoDirection = opts.portAutoDirection ?? 'down';
  const host = opts.host || '127.0.0.1';
  const startBackendDriver = opts.startBackendDriver ?? true;
  const portCandidates = buildWebuiPortCandidates({
    preferredPort,
    strictPort,
    direction: portAutoDirection,
  });

  log.info(
    `Starting server in ${mode} mode on ${host}:${preferredPort} (${strictPort ? 'strict port' : `auto port ${portAutoDirection}`}; working language: ${getWorkLanguage()} from ${source})`,
  );

  // WebSocket clients set
  const clients = new Set<WebSocket>();
  const serverMode = mode === 'dev' ? 'development' : 'production';
  const auth = computeAuthConfig({
    mode: serverMode,
    env: process.env,
  });

  let startedCore: HttpServerCore | null = null;
  let boundPort: number | null = null;

  for (const candidatePort of portCandidates) {
    const config: ServerConfig = {
      mode: serverMode,
      staticRoot: 'webapp/dist',
      host,
      port: candidatePort,
      clients,
      auth,
    };

    const candidateServer = createHttpServer(config);

    try {
      boundPort = await candidateServer.start();
      setupWebSocketServer(
        candidateServer.getHttpServer(),
        clients,
        auth,
        getWorkLanguage(),
        config.mode,
      );
      startedCore = candidateServer;
      break;
    } catch (error: unknown) {
      if (!strictPort && getErrnoCode(error) === 'EADDRINUSE') {
        const nextDirection = portAutoDirection === 'down' ? 'lower' : 'higher';
        log.warn(
          `WebUI port ${candidatePort} is already in use; trying the next ${nextDirection} port`,
        );
        continue;
      }
      if (boundPort !== null && startedCore === null) {
        await candidateServer.stop();
      }
      throw error;
    }
  }

  if (startedCore === null || boundPort === null) {
    const boundText = formatWebuiPortScanBound({
      preferredPort,
      direction: portAutoDirection,
    });
    throw new Error(
      `Failed to start WebUI: no available port found from ${preferredPort} ${boundText}`,
    );
  }

  if (!strictPort && boundPort !== preferredPort) {
    log.warn(`WebUI preferred port ${preferredPort} was unavailable; listening on ${boundPort}`);
  }

  try {
    configureDomindsSelfUpdate({
      host,
      port: boundPort,
      mode: serverMode,
      stopServer: async () => {
        await startedCore.stop();
      },
    });

    // MCP is best-effort: startup must not be blocked by MCP config/server issues.
    startMcpSupervisor();

    // Apps host is optional for server boot: app failures must stay loud, but they must not block WebUI startup.
    try {
      await initAppsRuntime({ rtwsRootAbs: process.cwd(), kernel: { host, port: boundPort } });
    } catch (error: unknown) {
      log.warn(
        'Apps runtime initialization failed during server startup; continuing without app runtime capabilities until the app issue is fixed',
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    // Crash recovery: any dialogs left in "proceeding" state are surfaced as interrupted/resumable.
    await reconcileDisplayStatesAfterRestart();
    await recoverPendingReplyTellaskCallsAfterRestart();

    // Tests may opt out so the process can shut down cleanly without a driver stop API.
    if (startBackendDriver) {
      void runBackendDriver();
    }
  } catch (error: unknown) {
    await startedCore.stop();
    throw error;
  }

  return { httpServer: startedCore, auth, host, port: boundPort, mode };
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
  }

  // Get port, host, and mode from CLI args
  const portSpecRaw = cliArgs['p'];
  const parsedPort = typeof portSpecRaw === 'string' ? parseWebuiPortSpec(portSpecRaw) : undefined;
  if (portSpecRaw !== undefined && parsedPort === null) {
    throw new Error(
      'Invalid --port value: expected a port number, optionally suffixed with + or -',
    );
  }
  const port = parsedPort?.port;
  const strictPort = parsedPort?.strictPort;
  const portAutoDirection = parsedPort?.portAutoDirection;
  const host = (cliArgs['H'] as string) || undefined;
  const mode = (cliArgs['mode'] as 'dev' | 'prod') || undefined;

  await startServer({ port, host, mode, strictPort, portAutoDirection });
}

// Start server if this file is run directly
if (require.main === module) {
  main().catch((error) => {
    log.error('Web UI startup failed', error);
    process.exit(1);
  });
}
