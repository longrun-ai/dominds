import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import {
  clearInstalledGlobalDialogEventBroadcaster,
  installRecordingGlobalDialogEventBroadcaster,
} from '../../main/bootstrap/global-dialog-event-broadcaster';
import { DialogID, MainDialog } from '../../main/dialog';
import { setDialogDisplayState } from '../../main/dialog-display-state';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';
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

async function waitForDialogsToUnlock(root: MainDialog, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const locked = root.getAllDialogs().some((d) => d.isLocked());
    if (!locked) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for sideDialog background drives to finish');
    }
    await sleep(10);
  }
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-typeb-dedupe-'));
  installRecordingGlobalDialogEventBroadcaster({
    label: 'tests/typeb-registered-sideDialog-dedupe',
  });

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
    const mainDialogId = new DialogID(rootId);
    const store = new DiskFileDialogStore(mainDialogId);
    const dlg = new MainDialog(store, 'task.md', mainDialogId, 'tester');
    const createdAt = formatUnifiedTimestamp(new Date());
    await DialogPersistence.saveDialogMetadata(dlg.id, {
      id: dlg.id.selfId,
      agentId: dlg.agentId,
      taskDocPath: dlg.taskDocPath,
      createdAt,
    });
    await DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: createdAt,
        status: 'active',
        messageCount: 0,
        functionCallCount: 0,
        sideDialogCount: 0,
        displayState: { kind: 'idle_waiting_user' },
        disableDiligencePush: false,
        diligencePushRemainingBudget: 0,
      },
    }));

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'typeb-dedupe-test', grammar: 'markdown', origin: 'user' },
      true,
    );

    const sideDialogsDir = path.join(tmpRoot, '.dialogs', 'run', rootId, 'sideDialogs');
    assert.ok(
      await pathExists(sideDialogsDir),
      `expected sideDialogs dir to exist: ${sideDialogsDir}`,
    );

    let matching = 0;
    const metaPaths = await collectDialogYamlPaths(sideDialogsDir);
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
      `expected exactly 1 registered sideDialog for agentId=pangu sessionSlug=dupe-session, got ${matching}`,
    );

    // First round schedules sideDialog drives in background.
    await waitForDialogsToUnlock(dlg, 2_000);
    const firstRegistered = dlg.lookupSideDialog('pangu', 'dupe-session');
    assert.ok(firstRegistered, 'expected first registered sideDialog for dupe-session');
    await setDialogDisplayState(firstRegistered.id, {
      kind: 'dead',
      reason: { kind: 'declared_by_user' },
    });

    await driveDialogStream(
      dlg,
      {
        content: triggerReuseAfterDead,
        msgId: 'typeb-reuse-after-dead',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
    );

    await waitForDialogsToUnlock(dlg, 2_000);
    const secondRegistered = dlg.lookupSideDialog('pangu', 'dupe-session');
    assert.ok(secondRegistered, 'expected registered sideDialog after dead-session reuse');
    assert.notEqual(
      secondRegistered.id.selfId,
      firstRegistered.id.selfId,
      'expected a new sideDialog id when reusing a slug after the previous one is dead',
    );

    let matchingAfterDeadReuse = 0;
    const metaPathsAfterDeadReuse = await collectDialogYamlPaths(sideDialogsDir);
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
      `expected 2 sideDialogs for agentId=pangu sessionSlug=dupe-session after dead-session reuse, got ${matchingAfterDeadReuse}`,
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
        entry.sideDialogId,
        secondRegistered.id.selfId,
        'expected registry entry for dupe-session to point to the fresh sideDialog id',
      );
    }
    assert.equal(
      matchingRegistryEntries,
      1,
      `expected exactly 1 registry entry for agentId=pangu sessionSlug=dupe-session, got ${matchingRegistryEntries}`,
    );

    // executeTellaskCall schedules sideDialog drives in the background. Keep the test rtws cwd
    // stable until those tasks complete, so the mock DB remains available.
    await waitForDialogsToUnlock(dlg, 2_000);

    console.log('type B registered sideDialog dedupe: PASS');
  } finally {
    clearInstalledGlobalDialogEventBroadcaster();
    // Background sideDialog work may still consult process.cwd() briefly after the final await.
    // This script exits immediately afterwards, so restoring cwd here is riskier than helpful.
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`type B registered sideDialog dedupe: FAIL\n${message}`);
  process.exit(1);
});
