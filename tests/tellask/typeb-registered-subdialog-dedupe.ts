import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';

import { DialogID, RootDialog } from '../../main/dialog';
import { driveDialogStream } from '../../main/llm/driver-entry';
import { DiskFileDialogStore } from '../../main/persistence';
import { generateDialogID } from '../../main/utils/id';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw err;
  }
}

async function collectDialogYamlPaths(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectDialogYamlPaths(full)));
      continue;
    }
    if (entry.isFile() && entry.name === 'dialog.yaml') {
      out.push(full);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDialogsToUnlock(root: RootDialog, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const locked = root.getAllDialogs().some((d) => d.isLocked());
    if (!locked) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for subdialog background drives to finish');
    }
    await sleep(10);
  }
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-typeb-dedupe-'));

  try {
    process.chdir(tmpRoot);

    await fs.mkdir(path.join(tmpRoot, '.minds'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'mock-db'), { recursive: true });

    await fs.writeFile(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  local-mock:',
        '    name: Local Mock',
        '    apiType: mock',
        '    baseUrl: mock-db',
        '    apiKeyEnvVar: MOCK_API_KEY',
        '    models:',
        '      default:',
        '        name: Default',
        '',
      ].join('\n'),
      'utf-8',
    );

    await fs.writeFile(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: local-mock',
        '  model: default',
        'default_responder: tester',
        'members:',
        '  tester:',
        '    name: Tester',
        '    provider: local-mock',
        '    model: default',
        '  pangu:',
        '    name: Pangu',
        '    provider: local-mock',
        '    model: default',
        '',
      ].join('\n'),
      'utf-8',
    );

    const trigger = 'Trigger duplicate type B tellasks.';
    await fs.writeFile(
      path.join(tmpRoot, 'mock-db', 'default.yaml'),
      yaml.stringify({
        responses: [
          {
            role: 'user',
            message: trigger,
            response: [
              'Start.',
              '!?@pangu !tellaskSession dupe-session',
              '!?first call body',
              'separator',
              '!?@pangu !tellaskSession dupe-session',
              '!?second call body',
              'separator',
              'Done.',
            ].join('\n'),
          },
        ],
      }),
      'utf-8',
    );

    const rootId = generateDialogID();
    const rootDialogId = new DialogID(rootId);
    const store = new DiskFileDialogStore(rootDialogId);
    const dlg = new RootDialog(store, 'task.md', rootDialogId, 'tester');

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'typeb-dedupe-test', grammar: 'markdown' },
      true,
    );

    const subdialogsDir = path.join(tmpRoot, '.dialogs', 'run', rootId, 'subdialogs');
    assert.ok(
      await pathExists(subdialogsDir),
      `expected subdialogs dir to exist: ${subdialogsDir}`,
    );

    let matching = 0;
    const metaPaths = await collectDialogYamlPaths(subdialogsDir);
    for (const metaPath of metaPaths) {
      const raw = await fs.readFile(metaPath, 'utf-8');
      // YAML is untyped runtime data; validate minimal fields without assuming structure.
      const parsed = yaml.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      if (!('tellaskSession' in parsed) || !('agentId' in parsed)) continue;
      const tellaskSession = (parsed as { tellaskSession?: unknown }).tellaskSession;
      const agentId = (parsed as { agentId?: unknown }).agentId;
      if (tellaskSession === 'dupe-session' && agentId === 'pangu') {
        matching += 1;
      }
    }

    assert.equal(
      matching,
      1,
      `expected exactly 1 registered subdialog for agentId=pangu tellaskSession=dupe-session, got ${matching}`,
    );

    // executeTellaskCall schedules subdialog drives in the background. Keep the test rtws cwd
    // stable until those tasks complete, so the mock DB remains available.
    await waitForDialogsToUnlock(dlg, 2_000);

    console.log('type B registered subdialog dedupe: PASS');
  } finally {
    process.chdir(oldCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`type B registered subdialog dedupe: FAIL\n${message}`);
  process.exit(1);
});
