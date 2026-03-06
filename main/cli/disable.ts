#!/usr/bin/env node

import {
  loadAppsConfigurationFile,
  setAppDisabledInConfiguration,
  writeAppsConfigurationFileIfChanged,
} from '../apps/configuration-file';
import { hasRtwsDeclaredAppDependency } from '../apps/manifest';
import { refreshAppsDerivedState } from '../apps/workspace-app-state';

type DisableArgs = Readonly<{ appId: string }>;

function printHelp(): void {
  console.log(`Usage:
  dominds disable <appId>
`);
}

function parseArgs(argv: readonly string[]): DisableArgs {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new Error('disable requires exactly one <appId>');
  return { appId: positional[0] };
}

async function main(): Promise<void> {
  let args: DisableArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    process.exit(1);
    return;
  }

  const rtwsRootAbs = process.cwd();
  if (!(await hasRtwsDeclaredAppDependency({ rtwsRootAbs, appId: args.appId }))) {
    console.error(`Error: app '${args.appId}' is not declared in .minds/app.yaml dependencies`);
    process.exit(1);
    return;
  }

  const loadedConfig = await loadAppsConfigurationFile({ rtwsRootAbs });
  if (loadedConfig.kind === 'error') {
    console.error(`Error: failed to read .apps/configuration.yaml: ${loadedConfig.errorText}`);
    process.exit(1);
    return;
  }

  const nextConfig = setAppDisabledInConfiguration({
    existing: loadedConfig.file,
    appId: args.appId,
    disabled: true,
  });
  await writeAppsConfigurationFileIfChanged({ rtwsRootAbs, file: nextConfig });
  await refreshAppsDerivedState({ rtwsRootAbs });
  console.log(`Disabled app '${args.appId}'`);
}

export { main };

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
