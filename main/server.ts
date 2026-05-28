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
import { initAppsRuntime, shutdownAppsRuntime } from './apps/runtime';
import { reconcileDisplayStatesAfterRestart } from './dialog-display-state';
import { runBackendDriver } from './llm/kernel-driver';
import { createLogger } from './log';
import { startMcpSupervisor } from './mcp/supervisor';
import { recoverOpenGenerationAfterRestart } from './recovery/open-generation-recovery';
import { recoverPendingReplyDeliveryAfterRestart } from './recovery/reply-delivery-recovery';
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
  returnAfterListen?: boolean;
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

type PostListenStartupToken = {
  canceled: boolean;
};

function attachPostListenStartupCancellation(
  httpServer: HttpServerCore,
  token: PostListenStartupToken,
): HttpServerCore {
  const originalStop = httpServer.stop.bind(httpServer);
  httpServer.stop = async (): Promise<void> => {
    token.canceled = true;
    await originalStop();
  };
  return httpServer;
}

function getErrnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const withCode = error as Error & { code?: unknown };
  return typeof withCode.code === 'string' ? withCode.code : undefined;
}

async function runPostListenStartup(params: {
  rtwsRootAbs: string;
  kernel: Readonly<{ host: string; port: number }>;
  startBackendDriver: boolean;
  token: PostListenStartupToken;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  if (params.token.canceled) return;
  // Apps host is optional for server boot: app failures must stay loud, but they must not block WebUI startup.
  try {
    await initAppsRuntime({ rtwsRootAbs: params.rtwsRootAbs, kernel: params.kernel });
  } catch (error: unknown) {
    if (params.token.canceled) return;
    log.warn(
      'Apps runtime initialization failed during server startup; continuing without app runtime capabilities until the app issue is fixed',
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  if (params.token.canceled) return;
  // Crash recovery: persisted in-flight generations are re-queued; stale non-generating queues
  // are surfaced as blocked/resumable from durable facts.
  await reconcileDisplayStatesAfterRestart();
  if (params.token.canceled) return;
  await recoverPendingReplyDeliveryAfterRestart();
  if (params.token.canceled) return;
  await recoverOpenGenerationAfterRestart();

  if (params.token.canceled) return;
  // Tests may opt out so the process can shut down cleanly without a driver stop API.
  if (params.startBackendDriver) {
    void runBackendDriver();
  }
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
  const returnAfterListen = opts.returnAfterListen === true;
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

  const postListenStartupToken: PostListenStartupToken = { canceled: false };
  const httpServer = attachPostListenStartupCancellation(startedCore, postListenStartupToken);
  try {
    const rtwsRootAbs = process.cwd();
    configureDomindsSelfUpdate({
      host,
      port: boundPort,
      mode: serverMode,
      closeWebSocketClients: () => {
        if (clients.size === 0) return;
        log.info(`Closing ${clients.size} WebSocket client(s) for Dominds restart`);
        for (const ws of clients) {
          try {
            ws.close(1012, 'server_restart');
          } catch (error: unknown) {
            log.warn('Failed to close WebSocket client for Dominds restart', error);
          }
        }
      },
      stopServer: async () => {
        await httpServer.stop();
      },
    });

    // MCP is best-effort: startup must not be blocked by MCP config/server issues.
    try {
      startMcpSupervisor();
    } catch (error: unknown) {
      log.warn(
        'MCP supervisor startup failed during server startup; continuing without MCP runtime capabilities until the MCP issue is fixed',
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    const postListenStartup = runPostListenStartup({
      rtwsRootAbs,
      kernel: { host, port: boundPort },
      startBackendDriver,
      token: postListenStartupToken,
    });
    if (returnAfterListen) {
      void postListenStartup.catch((error: unknown) => {
        log.error(
          'Post-listen server startup failed; WebUI remains reachable, but runtime recovery/driver startup did not complete',
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    } else {
      await postListenStartup;
    }
  } catch (error: unknown) {
    if (!returnAfterListen) {
      await httpServer.stop();
      await shutdownAppsRuntime();
    }
    throw error;
  }

  return { httpServer, auth, host, port: boundPort, mode };
}

// Main function for CLI execution
async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));

  // Handle working directory change from -C flag
  const wsDir = cliArgs['C'] as string;
  if (wsDir) {
    if (!path.isAbsolute(wsDir)) {
      throw new Error(`-C requires an absolute directory path: ${wsDir}`);
    }
    try {
      process.chdir(wsDir);
    } catch (err) {
      throw new Error(
        `Failed to change working directory to ${wsDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  await startServer({ port, host, mode, strictPort, portAutoDirection, returnAfterListen: true });
}

// Start server if this file is run directly
if (require.main === module) {
  main().catch((error) => {
    log.error('Web UI startup failed', error);
    process.exit(1);
  });
}
