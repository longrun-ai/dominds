/**
 * reminders.json owner/meta persistence regression script
 *
 * Ensures owned reminders survive restarts:
 * - reminder ownerName is persisted and rehydrated
 * - reminder meta is persisted and rehydrated
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DialogID } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { materializeReminder, type ReminderOwner } from '../../main/tool';
import { buildAppReminderOwnerRegistryName } from '../../main/tools/app-reminders';
import '../../main/tools/builtins';
import { getReminderOwner, registerReminderOwner } from '../../main/tools/registry';

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
    const appId = '@longrun-ai/web-dev';
    const mcpLeaseOwner = getReminderOwner('mcpLease');
    assert.ok(mcpLeaseOwner, 'Expected mcpLease ReminderOwner to be registered');
    const shellCmdOwner = getReminderOwner('shellCmd');
    assert.ok(shellCmdOwner, 'Expected shellCmd ReminderOwner to be registered');
    const appOwnerName = buildAppReminderOwnerRegistryName(appId, 'playwright_interactive_manual');
    const appReminderOwner: ReminderOwner = {
      name: appOwnerName,
      async updateReminder() {
        return { treatment: 'keep' };
      },
      async renderReminder(_dlg, reminder) {
        return {
          type: 'transient_guide_msg',
          role: 'assistant',
          content: reminder.content,
        };
      },
    };
    registerReminderOwner(appReminderOwner);
    const registeredAppOwner = getReminderOwner(appOwnerName);
    assert.ok(registeredAppOwner, 'Expected app reminder owner to be registered');

    const dialogId = new DialogID('11/22/33334444');
    // This test writes reminder state directly for a synthetic dialog id without going through
    // the normal dialog persistence bootstrap. Create the fixture directory explicitly here;
    // production reminder persistence must not recreate missing dialog directories on demand.
    await fs.mkdir(DialogPersistence.getDialogEventsPath(dialogId), { recursive: true });
    await DialogPersistence._saveReminderState(dialogId, [
      materializeReminder({ content: 'MCP lease reminder', owner: mcpLeaseOwner }),
      materializeReminder({
        content: 'Daemon reminder',
        owner: shellCmdOwner,
        meta: { kind: 'daemon', pid: 123, command: 'sleep 10' },
      }),
      materializeReminder({
        content: 'App tool reminder',
        owner: appReminderOwner,
        meta: {
          kind: 'app_reminder_owner',
          appId,
          ownerRef: 'playwright_interactive_manual',
          manager: {
            tool: 'playwright_interactive_manual',
          },
          update: {
            altInstruction: 'playwright_interactive_manual({})',
          },
          workflow: 'playwright_interactive_manual',
        },
        renderMode: 'plain',
      }),
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
    assert.equal(reminders.length, 3);

    assertRecord(reminders[0]);
    assert.equal(reminders[0]['ownerName'], 'mcpLease');

    assertRecord(reminders[1]);
    assert.equal(reminders[1]['ownerName'], 'shellCmd');
    assertRecord(reminders[1]['meta']);
    assert.equal(reminders[1]['meta']['kind'], 'daemon');
    assert.equal(reminders[1]['meta']['pid'], 123);

    assertRecord(reminders[2]);
    assert.equal(reminders[2]['ownerName'], appOwnerName);
    assert.equal(reminders[2]['renderMode'], 'plain');
    assertRecord(reminders[2]['meta']);
    assert.equal(reminders[2]['meta']['appId'], appId);
    assert.equal(reminders[2]['meta']['ownerRef'], 'playwright_interactive_manual');
    assertRecord(reminders[2]['meta']['manager']);
    assert.equal(reminders[2]['meta']['manager']['tool'], 'playwright_interactive_manual');
    assertRecord(reminders[2]['meta']['update']);
    assert.equal(
      reminders[2]['meta']['update']['altInstruction'],
      'playwright_interactive_manual({})',
    );

    const loaded = await DialogPersistence.loadReminderState(dialogId);
    assert.equal(loaded.length, 3);
    assert.ok(loaded[0].owner, 'Expected owner to be rehydrated for reminder[0]');
    assert.equal(loaded[0].owner.name, 'mcpLease');
    assert.ok(loaded[1].owner, 'Expected owner to be rehydrated for reminder[1]');
    assert.equal(loaded[1].owner.name, 'shellCmd');
    assertRecord(loaded[1].meta);
    assert.equal(loaded[1].meta['kind'], 'daemon');
    assert.equal(loaded[1].meta['pid'], 123);
    assert.ok(loaded[2].owner, 'Expected owner to be rehydrated for reminder[2]');
    assert.equal(loaded[2].owner.name, appOwnerName);
    assert.equal(loaded[2].renderMode, 'plain');
    assertRecord(loaded[2].meta);
    assert.equal(loaded[2].meta['appId'], appId);
    assert.equal(loaded[2].meta['ownerRef'], 'playwright_interactive_manual');
    assertRecord(loaded[2].meta['manager']);
    assert.equal(loaded[2].meta['manager']['tool'], 'playwright_interactive_manual');
    assertRecord(loaded[2].meta['update']);
    assert.equal(loaded[2].meta['update']['altInstruction'], 'playwright_interactive_manual({})');

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
