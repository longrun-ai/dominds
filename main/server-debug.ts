#!/usr/bin/env node

import { extractGlobalRtwsChdir } from './bootstrap/rtws-cli';
import { createLogger } from './log';
import { startServer } from './server';
import { parseWebuiPortSpec } from './server/port-selection';

const log = createLogger('server-debug');

type ParsedServerDebugArgs = Readonly<{
  chdir?: string;
  argv: readonly string[];
}>;

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--port') {
      out['p'] = argv[i + 1] ?? '';
      i++;
      continue;
    }
    if (arg.startsWith('--port=')) {
      out['p'] = arg.slice('--port='.length);
      continue;
    }
    if (arg === '-H' || arg === '--host' || arg === '-h') {
      out['H'] = argv[i + 1] ?? '';
      i++;
      continue;
    }
    if (arg.startsWith('--host=')) {
      out['H'] = arg.slice('--host='.length);
      continue;
    }
    if (arg === '--mode') {
      out['mode'] = argv[i + 1] ?? '';
      i++;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      out['mode'] = arg.slice('--mode='.length);
      continue;
    }
  }
  return out;
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedServerDebugArgs;
  try {
    parsed = extractGlobalRtwsChdir({ argv });
    if (parsed.chdir !== undefined) {
      process.chdir(parsed.chdir);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to apply server debug cwd: ${message}`);
  }

  const cliArgs = parseArgs(parsed.argv);
  const portSpecRaw = cliArgs['p'];
  const parsedPort = typeof portSpecRaw === 'string' ? parseWebuiPortSpec(portSpecRaw) : undefined;
  if (portSpecRaw !== undefined && parsedPort === null) {
    throw new Error(
      'Invalid --port value: expected a port number, optionally suffixed with + or -',
    );
  }
  const modeRaw = cliArgs['mode'];
  if (modeRaw !== undefined && modeRaw !== 'dev' && modeRaw !== 'prod') {
    throw new Error("Invalid --mode value: expected 'dev' or 'prod'");
  }
  await startServer({
    port: parsedPort?.port,
    host: typeof cliArgs['H'] === 'string' && cliArgs['H'] !== '' ? cliArgs['H'] : undefined,
    mode: modeRaw,
    strictPort: parsedPort?.strictPort,
    portAutoDirection: parsedPort?.portAutoDirection,
    returnAfterListen: true,
  });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    log.error('Web UI debug startup failed', error);
    process.exit(1);
  });
}
