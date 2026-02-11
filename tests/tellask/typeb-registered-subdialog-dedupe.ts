import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';

import { DialogID, RootDialog } from '../../main/dialog';
import { setDialogRunState } from '../../main/dialog-run-state';
import { setGlobalDialogEventBroadcaster } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/driver-entry';
import { DiskFileDialogStore } from '../../main/persistence';
import { generateDialogID } from '../../main/utils/id';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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
  setGlobalDialogEventBroadcaster(() => {});

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
    const triggerReuseAfterDead = 'Trigger same slug after declaring old sideline dead.';
    await fs.writeFile(
      path.join(tmpRoot, 'mock-db', 'default.yaml'),
      yaml.stringify({
        responses: [
          {
            role: 'user',
            message: trigger,
            response: 'Start.',
            funcCalls: [
              {
                id: 'dupe-typeb-call-1',
                name: 'tellask',
                arguments: {
                  targetAgentId: 'pangu',
                  sessionSlug: 'dupe-session',
                  tellaskContent: 'first call body',
                },
              },
              {
                id: 'dupe-typeb-call-2',
                name: 'tellask',
                arguments: {
                  targetAgentId: 'pangu',
                  sessionSlug: 'dupe-session',
                  tellaskContent: 'second call body',
                },
              },
            ],
          },
          {
            role: 'user',
            message: triggerReuseAfterDead,
            response: 'Continue.',
            funcCalls: [
              {
                id: 'dupe-typeb-call-3',
                name: 'tellask',
                arguments: {
                  targetAgentId: 'pangu',
                  sessionSlug: 'dupe-session',
                  tellaskContent: 'fresh full context',
                },
              },
            ],
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
      if (!('sessionSlug' in parsed) || !('agentId' in parsed)) continue;
      const sessionSlug = (parsed as { sessionSlug?: unknown }).sessionSlug;
      const agentId = (parsed as { agentId?: unknown }).agentId;
      if (sessionSlug === 'dupe-session' && agentId === 'pangu') {
        matching += 1;
      }
    }

    assert.equal(
      matching,
      1,
      `expected exactly 1 registered subdialog for agentId=pangu sessionSlug=dupe-session, got ${matching}`,
    );

    // First round schedules subdialog drives in background.
    await waitForDialogsToUnlock(dlg, 2_000);
    const firstRegistered = dlg.lookupSubdialog('pangu', 'dupe-session');
    assert.ok(firstRegistered, 'expected first registered subdialog for dupe-session');
    await setDialogRunState(firstRegistered.id, {
      kind: 'dead',
      reason: { kind: 'declared_by_user' },
    });

    await driveDialogStream(
      dlg,
      { content: triggerReuseAfterDead, msgId: 'typeb-reuse-after-dead', grammar: 'markdown' },
      true,
    );

    await waitForDialogsToUnlock(dlg, 2_000);
    const secondRegistered = dlg.lookupSubdialog('pangu', 'dupe-session');
    assert.ok(secondRegistered, 'expected registered subdialog after dead-session reuse');
    assert.notEqual(
      secondRegistered.id.selfId,
      firstRegistered.id.selfId,
      'expected a new subdialog id when reusing a slug after the previous one is dead',
    );

    let matchingAfterDeadReuse = 0;
    const metaPathsAfterDeadReuse = await collectDialogYamlPaths(subdialogsDir);
    for (const metaPath of metaPathsAfterDeadReuse) {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const parsed = yaml.parse(raw) as unknown;
      if (!isRecord(parsed)) continue;
      if (!('sessionSlug' in parsed) || !('agentId' in parsed)) continue;
      const sessionSlug = parsed.sessionSlug;
      const agentId = parsed.agentId;
      if (sessionSlug === 'dupe-session' && agentId === 'pangu') {
        matchingAfterDeadReuse += 1;
      }
    }
    assert.equal(
      matchingAfterDeadReuse,
      2,
      `expected 2 subdialogs for agentId=pangu sessionSlug=dupe-session after dead-session reuse, got ${matchingAfterDeadReuse}`,
    );

    const registryPath = path.join(tmpRoot, '.dialogs', 'run', rootId, 'registry.yaml');
    const registryRaw = await fs.readFile(registryPath, 'utf-8');
    const registryParsed = yaml.parse(registryRaw) as unknown;
    assert.ok(isRecord(registryParsed), 'expected registry.yaml to be an object');
    const entries = registryParsed.entries;
    assert.ok(Array.isArray(entries), 'expected registry.yaml entries to be an array');
    let matchingRegistryEntries = 0;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (entry.agentId !== 'pangu' || entry.sessionSlug !== 'dupe-session') continue;
      matchingRegistryEntries += 1;
      assert.equal(
        entry.subdialogId,
        secondRegistered.id.selfId,
        'expected registry entry for dupe-session to point to the fresh subdialog id',
      );
    }
    assert.equal(
      matchingRegistryEntries,
      1,
      `expected exactly 1 registry entry for agentId=pangu sessionSlug=dupe-session, got ${matchingRegistryEntries}`,
    );

    // executeTellaskCall schedules subdialog drives in the background. Keep the test rtws cwd
    // stable until those tasks complete, so the mock DB remains available.
    await waitForDialogsToUnlock(dlg, 2_000);

    console.log('type B registered subdialog dedupe: PASS');
  } finally {
    setGlobalDialogEventBroadcaster(null);
    process.chdir(oldCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`type B registered subdialog dedupe: FAIL\n${message}`);
  process.exit(1);
});
