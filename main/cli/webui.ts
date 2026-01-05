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
 *   -C, --cwd <dir>      Change to workspace directory
 *   -h, --help           Show help
 */

import { WebSocket } from 'ws';
import { createLogger } from '../log';
import { createHttpServer } from '../server/server-core';
import { setupWebSocketServer } from '../server/websocket-handler';

const log = createLogger('webui');

function printHelp(): void {
  console.log(`
WebUI Server for dominds

Usage:
  dominds webui [options]

Options:
  -p, --port <port>    Port to listen on (default: 5666)
  -h, --host <host>    Host to bind to (default: localhost)
  -C, --cwd <dir>      Change to workspace directory before starting
  --help               Show this help message

Examples:
  dominds webui                   # Start on default port 5666
  dominds webui -p 8888           # Start on port 8888
  dominds webui -C ./my-workspace # Start in specific workspace
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = 5666;
  let host = 'localhost';
  let cwd: string | undefined;

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
    } else if (arg === '-C' || arg === '--cwd') {
      const next = args[i + 1];
      if (!next) {
        console.error('Error: -C requires a directory path');
        printHelp();
        process.exit(1);
      }
      cwd = next;
      i++;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Error: Unknown option '${arg}'`);
      printHelp();
      process.exit(1);
    }
  }

  // Change to workspace directory if specified
  if (cwd) {
    try {
      process.chdir(cwd);
      log.info(`Changed to workspace directory: ${cwd}`);
    } catch (err) {
      console.error(`Error: failed to change directory to '${cwd}':`, err);
      process.exit(1);
    }
  }

  log.info(`Starting WebUI server on ${host}:${port}`);

  try {
    const httpServer = createHttpServer({
      port,
      host,
      mode: 'production',
      staticRoot: process.env.NODE_ENV === 'dev' ? undefined : 'dist/static',
    });

    // Setup WebSocket server
    const clients = new Set<WebSocket>();
    setupWebSocketServer(httpServer.getHttpServer(), clients);

    await httpServer.start();

    log.info(`WebUI server listening on http://${host}:${port}`);
    log.info(`WebSocket endpoint: ws://${host}:${port}/ws`);

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
