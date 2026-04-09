import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import {
  initAppsRuntime,
  listDynamicAppToolsetsForMember,
  shutdownAppsRuntime,
} from '../main/apps/runtime';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dominds-dynamic-toolsets-host-failure-no-interrupt-'),
  );

  try {
    process.chdir(tmpRoot);

    await writeText(path.join(tmpRoot, '.minds', 'team.yaml'), 'members: {}\n');
    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      YAML.stringify({
        schemaVersion: 1,
        apps: [
          {
            id: '@longrun-ai/broken-web-dev',
            enabled: true,
            assignedPort: 43123,
            source: {
              kind: 'local',
              pathAbs: path.join(tmpRoot, 'dominds-apps', 'broken-web-dev'),
            },
            installJson: {
              appId: '@longrun-ai/broken-web-dev',
              package: {
                name: '@longrun-ai/broken-web-dev',
                version: '0.1.0',
                rootAbs: path.join(tmpRoot, 'dominds-apps', 'broken-web-dev'),
              },
              host: {
                kind: 'node_module',
                moduleRelPath: './src/app.js',
                exportName: 'createDomindsApp',
              },
              contributes: {},
            },
          },
        ],
      }),
    );

    await initAppsRuntime({ rtwsRootAbs: tmpRoot, kernel: { host: '127.0.0.1', port: 0 } });

    const dynamicToolsets = await listDynamicAppToolsetsForMember({
      rtwsRootAbs: tmpRoot,
      taskDocPath: 'task.md',
      memberId: 'fullstack',
    });

    assert.deepEqual(
      dynamicToolsets,
      [],
      'broken apps-host startup should not interrupt dynamic toolset resolution',
    );
  } finally {
    await shutdownAppsRuntime();
    process.chdir(previousCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
