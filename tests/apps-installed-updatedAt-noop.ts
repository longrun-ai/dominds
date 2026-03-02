import assert from 'node:assert/strict';

import {
  setAppRuntimePort,
  type InstalledAppEntry,
  type InstalledAppsFile,
} from 'dominds/apps/installed-file';

function makeFile(params: {
  appId: string;
  port: number | null;
  updatedAt: string;
}): InstalledAppsFile {
  const entry: InstalledAppEntry = {
    id: params.appId,
    enabled: true,
    source: { kind: 'npx', spec: 'example@0.0.0' },
    runtime: { port: params.port },
    installJson: {
      schemaVersion: 1,
      appId: params.appId,
      package: {
        name: 'example',
        version: null,
        rootAbs: '/tmp/example',
      },
      host: {
        kind: 'node_module',
        moduleRelPath: 'dist/app.js',
        exportName: 'domindsApp',
      },
    },
    installedAt: '2026-01-01T00:00:00Z',
    updatedAt: params.updatedAt,
  };
  return { schemaVersion: 1, apps: [entry] };
}

async function main(): Promise<void> {
  const file = makeFile({ appId: 'test-app', port: 1234, updatedAt: '2026-01-01T00:00:00Z' });

  const noopMissing = setAppRuntimePort({ existing: file, appId: 'missing-app', port: 1 });
  assert.strictEqual(noopMissing, file);

  const noopSamePort = setAppRuntimePort({ existing: file, appId: 'test-app', port: 1234 });
  assert.strictEqual(noopSamePort, file);
  assert.strictEqual(noopSamePort.apps[0].updatedAt, '2026-01-01T00:00:00Z');

  const changedPort = setAppRuntimePort({ existing: file, appId: 'test-app', port: 4321 });
  assert.notStrictEqual(changedPort, file);
  assert.strictEqual(changedPort.apps[0].runtime.port, 4321);
  assert.notStrictEqual(changedPort.apps[0].updatedAt, file.apps[0].updatedAt);
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
