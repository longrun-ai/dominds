#!/usr/bin/env node

/**
 * WebUI subcommand for dominds CLI
 *
 * Usage:
 *   dominds webui [options]
 *
 * Options:
 *   -p, --port <port>    Port to listen on (default: 5666)
 *   -h, --host <host>    Host to bind to (default: localhost)
 *   --nobrowser          Do not open a browser (opt-out)
 *   -h, --help           Show help
 */

import { spawn } from 'child_process';
import { createLogger } from '../log';
import { startServer } from '../server';
import { formatAutoAuthUrl } from '../server/auth';
import { getWorkLanguage, resolveWorkLanguage, setWorkLanguage } from '../shared/runtime-language';

const log = createLogger('webui');

function printHelp(): void {
  console.log(`
WebUI Server for dominds

Usage:
  dominds webui [options]

Note:
  rtws (runtime workspace) directory is \`process.cwd()\`. Use 'dominds -C <dir> webui' to run in another rtws.

Options:
  -p, --port <port>    Port to listen on (default: 5666)
  -h, --host <host>    Host to bind to (default: localhost)
  --mode <dev|prod>    Server mode (default: prod; dev if NODE_ENV=dev)
  --nobrowser          Do not open a browser (opt-out)
  --help               Show this help message

Examples:
  dominds webui                   # Start on default port 5666
  dominds webui -p 8888           # Start on port 8888
  dominds webui --mode dev        # Start in dev mode
  dominds webui --nobrowser       # Start without opening a browser
`);
}

function openInBrowser(url: string): void {
  // Best-effort cross-platform open.
  // We intentionally do not await; failures should not crash the server.
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = 5666;
  let host = 'localhost';
  let mode: 'dev' | 'prod' = process.env.NODE_ENV === 'dev' ? 'dev' : 'prod';
  let shouldOpen = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-p' || arg === '--port') {
      const next = args[i + 1];
      if (!next || isNaN(parseInt(next))) {
        console.error('Error: --port requires a valid port number');
        printHelp();
        process.exit(1);
      }
      port = parseInt(next);
      i++;
    } else if (arg === '-h' || arg === '--host') {
      const next = args[i + 1];
      if (!next) {
        console.error('Error: --host requires a hostname');
        printHelp();
        process.exit(1);
      }
      host = next;
      i++;
    } else if (arg === '--mode') {
      const next = args[i + 1];
      if (next !== 'dev' && next !== 'prod') {
        console.error(`Error: --mode must be 'dev' or 'prod'`);
        printHelp();
        process.exit(1);
      }
      mode = next;
      i++;
    } else if (arg === '--nobrowser') {
      shouldOpen = false;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Error: Unknown option '${arg}'`);
      printHelp();
      process.exit(1);
    }
  }

  log.info('Starting Dominds WebUI…');

  try {
    const { language: resolvedLanguage, source } = resolveWorkLanguage({ env: process.env });
    setWorkLanguage(resolvedLanguage);
    log.info(`working language: ${getWorkLanguage()} (source: ${source})`);

    const started = await startServer({ port, host, mode });
    const httpServer = started.httpServer;
    const auth = started.auth;

    const baseUrl = `http://${started.host}:${started.port}`;
    log.info(`WebUI ready: ${baseUrl}`);
    log.debug(`WebSocket endpoint: ws://${started.host}:${started.port}/ws`);

    if (auth.kind === 'enabled') {
      const autoAuthUrl = formatAutoAuthUrl({
        host: started.host,
        port: started.port,
        authKey: auth.key,
      });
      log.info(`auto auth url (sensitive): ${autoAuthUrl}`);
      if (shouldOpen) {
        log.debug(`Opening browser: ${autoAuthUrl}`);
        openInBrowser(autoAuthUrl);
      }
    } else {
      log.info('auth: disabled');
      if (shouldOpen) {
        const url = `${baseUrl}/`;
        log.debug(`Opening browser: ${url}`);
        openInBrowser(url);
      }
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      log.info('Shutting down WebUI server...');
      httpServer.stop().then(() => {
        log.info('WebUI server stopped');
        process.exit(0);
      });
    });

    process.on('SIGTERM', () => {
      log.info('Shutting down WebUI server...');
      httpServer.stop().then(() => {
        log.info('WebUI server stopped');
        process.exit(0);
      });
    });
  } catch (err) {
    console.error('Failed to start WebUI server:', err);
    process.exit(1);
  }
}

// Export main function for use by CLI
export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
