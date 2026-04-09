import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadEnabledAppsSnapshot } from '../main/apps/enabled-apps';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dominds-apps-resolution-default-local-'),
  );
  const appId = 'example_app';
  const defaultPort = 43111;

  try {
    // Root (rtws) app manifest: declares the dependency.
    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        `  - id: ${appId}`,
        '',
      ].join('\n'),
    );

    // Local app package under default local root: dominds-apps/<appId>/
    const packageRootAbs = path.join(tmpRoot, 'dominds-apps', appId);
    await writeText(
      path.join(packageRootAbs, 'package.json'),
      JSON.stringify(
        {
          name: appId,
          version: '0.0.0',
          bin: 'bin.js',
        },
        null,
        2,
      ),
    );
    await writeText(
      path.join(packageRootAbs, 'bin.js'),
      [
        "'use strict';",
        "if (!process.argv.includes('--dominds-app')) {",
        "  throw new Error('expected --dominds-app');",
        '}',
        'const appId = process.env.DOMINDS_TEST_APP_ID ?? null;',
        "if (!appId) throw new Error('missing DOMINDS_TEST_APP_ID');",
        'const defaultPortRaw = process.env.DOMINDS_TEST_APP_DEFAULT_PORT ?? null;',
        'const defaultPort = defaultPortRaw ? Number(defaultPortRaw) : 0;',
        'if (!Number.isInteger(defaultPort) || defaultPort <= 0) {',
        "  throw new Error('invalid DOMINDS_TEST_APP_DEFAULT_PORT');",
        '}',
        'const json = {',
        '  appId,',
        '  package: {',
        '    name: appId,',
        '    version: null,',
        '    rootAbs: process.cwd(),',
        '  },',
        "  host: { kind: 'node_module', moduleRelPath: 'index.js', exportName: 'main' },",
        `  frontend: { kind: 'http', defaultPort },`,
        '};',
        'process.stdout.write(JSON.stringify(json));',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(packageRootAbs, '.minds', 'app.yaml'),
      ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', `id: ${appId}`, ''].join('\n'),
    );

    // The default local strategy resolves local apps by executing the package bin with `--dominds-app`.
    // Pass required fields through environment variables to keep the file content deterministic.
    process.env.DOMINDS_TEST_APP_ID = appId;
    process.env.DOMINDS_TEST_APP_DEFAULT_PORT = String(defaultPort);

    const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: tmpRoot });
    const ids = snapshot.enabledApps.map((e) => e.id).sort();
    assert.deepEqual(ids, [appId]);
    assert.equal(snapshot.enabledApps[0]?.runtimePort, defaultPort);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
