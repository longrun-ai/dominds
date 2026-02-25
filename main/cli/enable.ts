#!/usr/bin/env node

/**
 * enable subcommand for dominds CLI (Apps)
 *
 * Usage:
 *   dominds enable <appId> [--port <port>]
 */

import {
  INSTALLED_APPS_REL_PATH,
  findInstalledApp,
  loadInstalledAppsFile,
  setAppEnabled,
  setAppRuntimePort,
  writeInstalledAppsFile,
} from '../apps/installed-file';
import { resolveStableAppRuntimePort } from '../apps/runtime-port';

type EnableArgs = Readonly<{
  appId: string;
  port: number | null;
}>;

function printHelp(): void {
  console.log(`Usage:
  dominds enable <appId> [--port <port>]

Options:
  --port <port>        Set frontend port (stored in ${INSTALLED_APPS_REL_PATH})
`);
}

function parseArgs(argv: readonly string[]): EnableArgs {
  const positional: string[] = [];
  let port: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
    if (a === '--port') {
      const v = argv[i + 1];
      if (!v) throw new Error('Missing value for --port');
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new Error(`Invalid --port value: ${v}`);
      }
      port = n;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    positional.push(a);
  }

  if (positional.length !== 1) throw new Error('enable requires exactly one <appId>');
  return { appId: positional[0], port };
}

async function main(): Promise<void> {
  let args: EnableArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    process.exit(1);
    return;
  }

  const rtwsRootAbs = process.cwd();
  const loaded = await loadInstalledAppsFile({ rtwsRootAbs });
  if (loaded.kind === 'error') {
    console.error(`Error: failed to read ${INSTALLED_APPS_REL_PATH}: ${loaded.errorText}`);
    process.exit(1);
    return;
  }

  const found = findInstalledApp(loaded.file, args.appId);
  if (!found) {
    console.error(`Error: app '${args.appId}' not installed`);
    process.exit(1);
    return;
  }

  let next = setAppEnabled({ existing: loaded.file, appId: args.appId, enabled: true });
  if (args.port !== null) {
    next = setAppRuntimePort({ existing: next, appId: args.appId, port: args.port });
  } else {
    const resolvedPort = await resolveStableAppRuntimePort({
      appId: found.id,
      installJson: found.installJson,
      existingApps: loaded.file.apps,
      existingRuntimePort: found.runtime.port,
    });
    if (resolvedPort !== found.runtime.port) {
      next = setAppRuntimePort({
        existing: next,
        appId: args.appId,
        port: resolvedPort,
      });
    }
  }

  await writeInstalledAppsFile({ rtwsRootAbs, file: next });
  console.log(`Enabled app '${args.appId}'`);
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
