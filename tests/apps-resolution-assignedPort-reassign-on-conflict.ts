import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadEnabledAppsSnapshot } from '../main/apps/enabled-apps';
import {
  APPS_RESOLUTION_REL_PATH,
  loadAppsResolutionFile,
  writeAppsResolutionFile,
  type AppsResolutionEntry,
  type AppsResolutionFile,
} from '../main/apps/resolution-file';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function writeManifest(packageRootAbs: string, appId: string): Promise<void> {
  await writeText(
    path.join(packageRootAbs, '.minds', 'app.yaml'),
    [`apiVersion: dominds.io/v1alpha1`, 'kind: DomindsApp', `id: ${appId}`, ''].join('\n'),
  );
}

function makeEntry(params: {
  id: string;
  packageRootAbs: string;
  assignedPort: number;
}): AppsResolutionEntry {
  return {
    id: params.id,
    enabled: true,
    source: { kind: 'npx', spec: `${params.id}@0.0.0` },
    assignedPort: params.assignedPort,
    installJson: {
      schemaVersion: 1,
      appId: params.id,
      package: {
        name: params.id,
        version: null,
        rootAbs: params.packageRootAbs,
      },
      host: {
        kind: 'node_module',
        moduleRelPath: 'dist/app.js',
        exportName: 'domindsApp',
      },
      frontend: {
        kind: 'http',
        defaultPort: params.assignedPort,
      },
    },
  };
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-port-reassign-'));
  const appA = 'app_port_a';
  const appB = 'app_port_b';
  const conflictPort = 49876;

  try {
    const appARootAbs = path.join(tmpRoot, 'pkgs', appA);
    const appBRootAbs = path.join(tmpRoot, 'pkgs', appB);
    await writeManifest(appARootAbs, appA);
    await writeManifest(appBRootAbs, appB);

    const resolutionFile: AppsResolutionFile = {
      schemaVersion: 1,
      apps: [
        makeEntry({ id: appA, packageRootAbs: appARootAbs, assignedPort: conflictPort }),
        makeEntry({ id: appB, packageRootAbs: appBRootAbs, assignedPort: conflictPort }),
      ],
    };
    await writeAppsResolutionFile({ rtwsRootAbs: tmpRoot, file: resolutionFile });

    const snap = await loadEnabledAppsSnapshot({ rtwsRootAbs: tmpRoot });
    assert.equal(
      snap.enabledApps.length,
      2,
      `expected 2 enabled apps, got ${snap.enabledApps.length}`,
    );

    const runtimePorts = snap.enabledApps.map((e) => e.runtimePort);
    assert.ok(runtimePorts.every((p) => typeof p === 'number' && p > 0));
    const uniquePorts = new Set<number>(runtimePorts.filter((p): p is number => p !== null));
    assert.equal(
      uniquePorts.size,
      2,
      `expected unique runtime ports, got: ${JSON.stringify(runtimePorts)}`,
    );

    assert.ok(
      snap.issues.some((i) => i.kind === 'assigned_port_reassigned'),
      `expected assigned_port_reassigned issue, got: ${JSON.stringify(snap.issues)}`,
    );

    const loaded = await loadAppsResolutionFile({ rtwsRootAbs: tmpRoot });
    if (loaded.kind === 'error') {
      throw new Error(`failed to read ${APPS_RESOLUTION_REL_PATH}: ${loaded.errorText}`);
    }
    const writtenPorts = loaded.file.apps
      .map((a) => a.assignedPort)
      .filter((p): p is number => typeof p === 'number')
      .sort((a, b) => a - b);
    assert.equal(writtenPorts.length, 2);
    assert.notEqual(writtenPorts[0], writtenPorts[1]);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
