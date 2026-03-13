#!/usr/bin/env node

import {
  loadAppsConfigurationFile,
  setAppDisabledInConfiguration,
  writeAppsConfigurationFileIfChanged,
} from '../apps/configuration-file';
import { hasRtwsDeclaredAppDependency } from '../apps/manifest';
import { refreshAppsDerivedState } from '../apps/workspace-app-state';
import { formatDoctorGuidance, formatMutationBoundaryNote } from './apps-cli-hints';

type EnableArgs = Readonly<{ appId: string }>;

function printHelp(): void {
  console.log(`Usage:
  dominds enable <appId>

Notes:
  - enable only removes the app from .apps/configuration.yaml.disabledApps and refreshes derived state.
  - ${formatMutationBoundaryNote({
    commandName: 'enable',
    layerDescription: '.apps/configuration.yaml.disabledApps',
  })}
`);
}

function parseArgs(argv: readonly string[]): EnableArgs {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new Error('enable requires exactly one <appId>');
  return { appId: positional[0] };
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
  if (!(await hasRtwsDeclaredAppDependency({ rtwsRootAbs, appId: args.appId }))) {
    console.error(`Error: app '${args.appId}' is not declared in .minds/app.yaml dependencies`);
    console.error(formatDoctorGuidance({ appId: args.appId }));
    process.exit(1);
    return;
  }

  const loadedConfig = await loadAppsConfigurationFile({ rtwsRootAbs });
  if (loadedConfig.kind === 'error') {
    console.error(`Error: failed to read .apps/configuration.yaml: ${loadedConfig.errorText}`);
    console.error(formatDoctorGuidance({ appId: args.appId }));
    process.exit(1);
    return;
  }

  const nextConfig = setAppDisabledInConfiguration({
    existing: loadedConfig.file,
    appId: args.appId,
    disabled: false,
  });
  await writeAppsConfigurationFileIfChanged({ rtwsRootAbs, file: nextConfig });
  await refreshAppsDerivedState({ rtwsRootAbs });
  console.log(
    `Enabled app '${args.appId}' in .apps/configuration.yaml and refreshed derived state.`,
  );
  console.log(
    formatMutationBoundaryNote({
      commandName: 'enable',
      layerDescription: '.apps/configuration.yaml.disabledApps',
      appId: args.appId,
    }),
  );
}

export { main };

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
