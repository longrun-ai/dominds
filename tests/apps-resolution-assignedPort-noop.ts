import assert from 'node:assert/strict';

import {
  removeResolvedApp,
  setResolvedAppAssignedPort,
  setResolvedAppEnabled,
  type AppsResolutionEntry,
  type AppsResolutionFile,
} from '../main/apps/resolution-file';

function makeFile(params: {
  appId: string;
  enabled: boolean;
  assignedPort: number | null;
}): AppsResolutionFile {
  const entry: AppsResolutionEntry = {
    id: params.appId,
    enabled: params.enabled,
    source: { kind: 'npx', spec: 'example@0.0.0' },
    assignedPort: params.assignedPort,
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
      frontend: {
        kind: 'http',
        defaultPort: 43001,
      },
    },
  };
  return { schemaVersion: 1, apps: [entry] };
}

async function main(): Promise<void> {
  const file = makeFile({ appId: 'test-app', enabled: true, assignedPort: 43001 });

  const noopMissingEnabled = setResolvedAppEnabled({
    existing: file,
    appId: 'missing-app',
    enabled: false,
  });
  assert.strictEqual(noopMissingEnabled, file);

  const noopSameEnabled = setResolvedAppEnabled({
    existing: file,
    appId: 'test-app',
    enabled: true,
  });
  assert.strictEqual(noopSameEnabled, file);

  const noopMissingAssigned = setResolvedAppAssignedPort({
    existing: file,
    appId: 'missing-app',
    assignedPort: 50000,
  });
  assert.strictEqual(noopMissingAssigned, file);

  const noopSameAssigned = setResolvedAppAssignedPort({
    existing: file,
    appId: 'test-app',
    assignedPort: 43001,
  });
  assert.strictEqual(noopSameAssigned, file);

  const noopMissingRemove = removeResolvedApp({ existing: file, appId: 'missing-app' });
  assert.strictEqual(noopMissingRemove, file);

  const changedAssigned = setResolvedAppAssignedPort({
    existing: file,
    appId: 'test-app',
    assignedPort: 43002,
  });
  assert.notStrictEqual(changedAssigned, file);
  assert.strictEqual(changedAssigned.apps[0].assignedPort, 43002);

  const removed = removeResolvedApp({ existing: file, appId: 'test-app' });
  assert.notStrictEqual(removed, file);
  assert.strictEqual(removed.apps.length, 0);
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
