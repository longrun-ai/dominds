import assert from 'node:assert/strict';

import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { EndOfStream } from '../../main/shared/evt';
import { setWorkLanguage } from '../../main/shared/runtime-language';
import type { TypedDialogEvent } from '../../main/shared/types/dialog';

import {
  createRootDialog,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readNextEventWithTimeout(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent | null> {
  const timer = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  const ev = await Promise.race([ch.read(), timer]);
  if (ev === null || ev === EndOfStream) {
    return null;
  }
  return ev;
}

async function collectEvents(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent[]> {
  const events: TypedDialogEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ev = await readNextEventWithTimeout(ch, 30);
    if (!ev) continue;
    events.push(ev);
  }
  return events;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { memberToolsets: ['codex_style_tools'] });

    const trigger = 'Please record and maintain the current implementation plan.';
    const planStep = 'Reproduce update_plan reminder regression';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'Calling update_plan to store current plan.',
        funcCalls: [
          {
            name: 'update_plan',
            arguments: {
              explanation: 'Reminder regression tracking',
              plan: [
                { step: planStep, status: 'in_progress' },
                { step: 'Ship fix and verify behavior', status: 'pending' },
              ],
            },
          },
        ],
      },
      {
        message: 'Updated',
        role: 'tool',
        response: 'Plan reminder has been synced.',
      },
    ]);

    const dlg = await createRootDialog('tester');
    dlg.disableDiligencePush = true;

    const ch = dialogEventRegistry.createSubChan(dlg.id);

    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'kernel-driver-update-plan-reminder-sync',
        grammar: 'markdown',
      },
      true,
    );

    await waitForAllDialogsUnlocked(dlg, 2000);

    const events = await collectEvents(ch, 800);
    const reminderEvents = events.filter(
      (ev): ev is Extract<TypedDialogEvent, { type: 'full_reminders_update' }> =>
        ev.type === 'full_reminders_update',
    );

    assert.ok(
      reminderEvents.length > 0,
      'Expected full_reminders_update to be emitted after update_plan tool call',
    );

    const sawPlanReminderInEvents = reminderEvents.some((ev) =>
      ev.reminders.some(
        (r) =>
          typeof r.content === 'string' &&
          r.content.includes('Plan (update_plan)') &&
          r.content.includes(planStep),
      ),
    );
    assert.equal(
      sawPlanReminderInEvents,
      true,
      'Expected full_reminders_update payload to include the update_plan reminder content',
    );

    const persistedReminders = await DialogPersistence.loadReminderState(dlg.id, 'running');
    assert.equal(persistedReminders.length, 1, 'Expected exactly one persisted reminder');
    assert.ok(
      persistedReminders[0]?.content.includes('Plan (update_plan)'),
      'Expected persisted reminder content to include plan heading',
    );
    assert.ok(
      persistedReminders[0]?.content.includes(planStep),
      'Expected persisted reminder content to include plan step',
    );

    const meta = persistedReminders[0]?.meta;
    assert.ok(isRecord(meta), 'Expected persisted reminder meta to be an object');
    if (!isRecord(meta)) {
      throw new Error('Expected persisted reminder meta to be an object');
    }
    assert.equal(meta.kind, 'plan', 'Expected persisted reminder meta.kind to be plan');
    assert.equal(
      meta.managedByTool,
      'update_plan',
      'Expected persisted reminder to stay managed by update_plan',
    );
  });

  console.log('kernel-driver update-plan-reminder-sync: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver update-plan-reminder-sync: FAIL\n${message}`);
  process.exit(1);
});
