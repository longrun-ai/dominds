/**
 * reminders.json owner/meta persistence regression script
 *
 * Ensures owned reminders survive restarts:
 * - reminder ownerName is persisted and rehydrated
 * - reminder meta is persisted and rehydrated
 */

import { DialogID } from 'dominds/dialog';
import { DialogPersistence } from 'dominds/persistence';
import 'dominds/tools/builtins';
import { getReminderOwner } from 'dominds/tools/registry';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-reminders-persist-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

async function main(): Promise<void> {
  await withTempCwd(async (sandboxDir) => {
    const contextHealthOwner = getReminderOwner('context_health');
    assert.ok(contextHealthOwner, 'Expected context_health ReminderOwner to be registered');
    const shellCmdOwner = getReminderOwner('shellCmd');
    assert.ok(shellCmdOwner, 'Expected shellCmd ReminderOwner to be registered');

    const dialogId = new DialogID('11/22/33334444');
    await DialogPersistence._saveReminderState(dialogId, [
      { content: 'Context health reminder', owner: contextHealthOwner },
      {
        content: 'Daemon reminder',
        owner: shellCmdOwner,
        meta: { type: 'daemon', pid: 123, command: 'sleep 10' },
      },
    ]);

    const remindersPath = path.join(
      sandboxDir,
      '.dialogs',
      'run',
      dialogId.selfId,
      'reminders.json',
    );
    const raw = await fs.readFile(remindersPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    assertRecord(parsed);
    const reminders = parsed['reminders'];
    assert.ok(Array.isArray(reminders));
    assert.equal(reminders.length, 2);

    assertRecord(reminders[0]);
    assert.equal(reminders[0]['ownerName'], 'context_health');

    assertRecord(reminders[1]);
    assert.equal(reminders[1]['ownerName'], 'shellCmd');
    assertRecord(reminders[1]['meta']);
    assert.equal(reminders[1]['meta']['type'], 'daemon');
    assert.equal(reminders[1]['meta']['pid'], 123);

    const loaded = await DialogPersistence.loadReminderState(dialogId);
    assert.equal(loaded.length, 2);
    assert.ok(loaded[0].owner, 'Expected owner to be rehydrated for reminder[0]');
    assert.equal(loaded[0].owner.name, 'context_health');
    assert.ok(loaded[1].owner, 'Expected owner to be rehydrated for reminder[1]');
    assert.equal(loaded[1].owner.name, 'shellCmd');
    assertRecord(loaded[1].meta);
    assert.equal(loaded[1].meta['type'], 'daemon');
    assert.equal(loaded[1].meta['pid'], 123);

    // No backward-compat: old reminders.json data (missing ownerName/meta) is assumed cleared.
    // This script intentionally tests only the current on-disk schema.
  });
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
