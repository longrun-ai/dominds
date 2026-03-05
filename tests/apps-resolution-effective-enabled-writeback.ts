import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  APPS_RESOLUTION_REL_PATH,
  loadAppsResolutionFile,
  writeAppsResolutionFile,
  type AppsResolutionEntry,
  type AppsResolutionFile,
} from 'dominds/apps/resolution-file';
import { loadEnabledAppsSnapshot } from 'dominds/apps/enabled-apps';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function writeManifest(packageRootAbs: string, contentLines: ReadonlyArray<string>): Promise<void> {
  await writeText(path.join(packageRootAbs, '.minds', 'app.yaml'), `${contentLines.join('\n')}\n`);
}

function makeEntry(params: {
  id: string;
  enabled: boolean;
  userEnabled: boolean;
  packageRootAbs: string;
}): AppsResolutionEntry {
  return {
    id: params.id,
    enabled: params.enabled,
    userEnabled: params.userEnabled,
    source: { kind: 'npx', spec: `${params.id}@0.0.0` },
    assignedPort: null,
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
        defaultPort: 43123,
      },
    },
  };
}

async function readResolutionOrThrow(rtwsRootAbs: string): Promise<AppsResolutionFile> {
  const loaded = await loadAppsResolutionFile({ rtwsRootAbs });
  if (loaded.kind === 'error') {
    throw new Error(`failed to read ${APPS_RESOLUTION_REL_PATH}: ${loaded.errorText}`);
  }
  return loaded.file;
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-effective-enabled-writeback-'));

  const appA = 'app_a';
  const appB = 'app_b';
  const appARootAbs = path.join(tmpRoot, 'pkgs', appA);
  const appBRootAbs = path.join(tmpRoot, 'pkgs', appB);

  try {
    await writeManifest(appARootAbs, [
      'apiVersion: dominds.io/v1alpha1',
      'kind: DomindsApp',
      `id: ${appA}`,
      'dependencies:',
      `  - id: ${appB}`,
    ]);
    await writeManifest(appBRootAbs, [
      'apiVersion: dominds.io/v1alpha1',
      'kind: DomindsApp',
      `id: ${appB}`,
    ]);

    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        `  - id: ${appA}`,
        '',
      ].join('\n'),
    );

    const initialFile: AppsResolutionFile = {
      schemaVersion: 1,
      apps: [
        makeEntry({ id: appA, enabled: true, userEnabled: true, packageRootAbs: appARootAbs }),
        makeEntry({ id: appB, enabled: true, userEnabled: true, packageRootAbs: appBRootAbs }),
      ],
    };
    await writeAppsResolutionFile({ rtwsRootAbs: tmpRoot, file: initialFile });

    const snap1 = await loadEnabledAppsSnapshot({ rtwsRootAbs: tmpRoot });
    assert.deepEqual(
      snap1.enabledApps.map((e) => e.id).sort(),
      [appA, appB],
    );
    assert.equal(snap1.issues.length, 0, `unexpected issues: ${JSON.stringify(snap1.issues)}`);

    const disableBFile: AppsResolutionFile = {
      schemaVersion: 1,
      apps: [
        makeEntry({ id: appA, enabled: true, userEnabled: true, packageRootAbs: appARootAbs }),
        makeEntry({ id: appB, enabled: true, userEnabled: false, packageRootAbs: appBRootAbs }),
      ],
    };
    await writeAppsResolutionFile({ rtwsRootAbs: tmpRoot, file: disableBFile });

    const snap2 = await loadEnabledAppsSnapshot({ rtwsRootAbs: tmpRoot });
    assert.deepEqual(snap2.enabledApps, []);
    assert.ok(
      snap2.issues.some((i) => i.kind === 'required_dependency_disabled'),
      `expected required_dependency_disabled, got: ${JSON.stringify(snap2.issues)}`,
    );
    assert.ok(
      snap2.issues.some(
        (i) =>
          i.kind === 'app_effectively_disabled_due_to_required_dependency' &&
          i.detail['appId'] === appA &&
          i.detail['dependencyId'] === appB,
      ),
      `expected effective-disable issue for ${appA} -> ${appB}, got: ${JSON.stringify(snap2.issues)}`,
    );

    const fileAfterDisable = await readResolutionOrThrow(tmpRoot);
    const appAAfterDisable = fileAfterDisable.apps.find((a) => a.id === appA) ?? null;
    const appBAfterDisable = fileAfterDisable.apps.find((a) => a.id === appB) ?? null;
    assert.ok(appAAfterDisable);
    assert.ok(appBAfterDisable);
    assert.equal(appAAfterDisable?.userEnabled, true);
    assert.equal(appBAfterDisable?.userEnabled, false);
    assert.equal(appAAfterDisable?.enabled, false);
    assert.equal(appBAfterDisable?.enabled, false);

    const recoverBFile: AppsResolutionFile = {
      schemaVersion: 1,
      apps: [
        makeEntry({ id: appA, enabled: false, userEnabled: true, packageRootAbs: appARootAbs }),
        makeEntry({ id: appB, enabled: false, userEnabled: true, packageRootAbs: appBRootAbs }),
      ],
    };
    await writeAppsResolutionFile({ rtwsRootAbs: tmpRoot, file: recoverBFile });

    const snap3 = await loadEnabledAppsSnapshot({ rtwsRootAbs: tmpRoot });
    assert.deepEqual(
      snap3.enabledApps.map((e) => e.id).sort(),
      [appA, appB],
    );
    assert.equal(snap3.issues.length, 0, `unexpected issues after recovery: ${JSON.stringify(snap3.issues)}`);

    const fileAfterRecover = await readResolutionOrThrow(tmpRoot);
    const appAAfterRecover = fileAfterRecover.apps.find((a) => a.id === appA) ?? null;
    const appBAfterRecover = fileAfterRecover.apps.find((a) => a.id === appB) ?? null;
    assert.ok(appAAfterRecover);
    assert.ok(appBAfterRecover);
    assert.equal(appAAfterRecover?.userEnabled, true);
    assert.equal(appBAfterRecover?.userEnabled, true);
    assert.equal(appAAfterRecover?.enabled, true);
    assert.equal(appBAfterRecover?.enabled, true);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

