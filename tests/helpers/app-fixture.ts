import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import type { DomindsAppInstallJson } from '@longrun-ai/kernel/app-json';
import { loadAppsResolutionFile, type AppsResolutionEntry } from '../../main/apps/resolution-file';

export async function writeAppText(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

export async function writeAppManifest(
  root: string,
  id: string,
  dependencies: readonly string[] = [],
): Promise<void> {
  await writeAppText(
    path.join(root, '.minds', 'app.yaml'),
    YAML.stringify({
      apiVersion: 'dominds.io/v1alpha1',
      kind: 'DomindsApp',
      id,
      ...(dependencies.length ? { dependencies: dependencies.map((id) => ({ id })) } : {}),
    }),
  );
}

/** Real local package bin; only its provided app JSON is controlled. No registry/host request. */
export async function writeLocalApp(
  root: string,
  id: string,
  options: {
    packageName?: string;
    defaultPort?: number;
    teammatesYamlRelPath?: string;
    dependencies?: readonly string[];
  } = {},
): Promise<DomindsAppInstallJson> {
  const installJson: DomindsAppInstallJson = {
    appId: id,
    package: { name: options.packageName ?? id, version: '0.0.0', rootAbs: root },
    host: { kind: 'node_module', moduleRelPath: 'index.js', exportName: 'main' },
    ...(options.defaultPort === undefined
      ? {}
      : { frontend: { kind: 'http' as const, defaultPort: options.defaultPort } }),
    ...(options.teammatesYamlRelPath === undefined
      ? {}
      : { contributes: { teammatesYamlRelPath: options.teammatesYamlRelPath } }),
  };
  await writeAppText(
    path.join(root, 'package.json'),
    JSON.stringify({ name: installJson.package.name, version: '0.0.0', bin: 'bin.js' }),
  );
  await writeAppText(path.join(root, 'app-json.json'), JSON.stringify(installJson));
  await writeAppText(
    path.join(root, 'bin.js'),
    [
      "'use strict';",
      "if (!process.argv.includes('--dominds-app')) throw new Error('expected app-json protocol flag');",
      "process.stdout.write(require('node:fs').readFileSync(require('node:path').join(__dirname, 'app-json.json')));",
      '',
    ].join('\n'),
  );
  await writeAppManifest(root, id, options.dependencies);
  return installJson;
}

export function resolvedApp(
  installJson: DomindsAppInstallJson,
  assignedPort: number | null = null,
  enabled = true,
): AppsResolutionEntry {
  return {
    id: installJson.appId,
    enabled,
    assignedPort,
    source: { kind: 'local', pathAbs: installJson.package.rootAbs },
    installJson,
  };
}

export async function readAppResolution(root: string) {
  const loaded = await loadAppsResolutionFile({ rtwsRootAbs: root });
  assert.notEqual(loaded.kind, 'error', JSON.stringify(loaded));
  if (loaded.kind === 'error') throw new Error(loaded.errorText);
  return loaded.file;
}
