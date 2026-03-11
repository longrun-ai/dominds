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
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-dynamic-toolsets-no-host-'));

  try {
    process.chdir(tmpRoot);

    await writeText(path.join(tmpRoot, '.minds', 'team.yaml'), 'members: {}\n');
    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      YAML.stringify({ schemaVersion: 1, apps: [] }),
    );

    const beforeInit = await listDynamicAppToolsetsForMember({
      rtwsRootAbs: tmpRoot,
      taskDocPath: 'task.md',
      memberId: 'tester',
    });
    assert.deepEqual(beforeInit, []);

    await initAppsRuntime({ rtwsRootAbs: tmpRoot, kernel: { host: '127.0.0.1', port: 0 } });

    const afterInit = await listDynamicAppToolsetsForMember({
      rtwsRootAbs: tmpRoot,
      taskDocPath: 'task.md',
      memberId: 'tester',
    });
    assert.deepEqual(afterInit, []);
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
