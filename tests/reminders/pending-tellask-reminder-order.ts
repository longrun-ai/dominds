import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DialogPersistence } from '../../main/persistence';
import { materializeReminder } from '../../main/tool';
import {
  pendingTellaskReminderOwner,
  syncPendingTellaskReminderState,
} from '../../main/tools/pending-tellask-reminder';
import {
  capturePending,
  pendingHistory,
  pendingMeta,
  pendingReminder,
  withPendingReminderRoot,
} from '../helpers/pending-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-pending-order-');
async function main() {
  for (const language of ['zh', 'en'] as const) {
    await withPendingReminderRoot(language, async (root) => {
      const pendingId = 'pending001';
      root.reminders.push(
        materializeReminder({
          id: pendingId,
          content: 'stale pending tellask reminder',
          owner: pendingTellaskReminderOwner,
          createdAt: '2026-04-16 10:00:00',
          priority: 'medium',
          scope: 'dialog',
          renderMode: 'markdown',
          meta: {
            kind: 'pending_tellask',
            pendingCount: 2,
            pendingSignature: 'stale',
            updatedAt: '2026-04-16 10:00:00',
            update: { altInstruction: 'wait for system refresh' },
            delete: { altInstruction: 'do not delete while pending' },
          },
        }),
      );
      root.reminders.push(
        materializeReminder({
          id: 'daemon001',
          content: 'supplied comparison-status data',
          createdAt: '2026-04-16 10:06:00',
          priority: 'medium',
          scope: 'dialog',
          renderMode: 'markdown',
        }),
      );
      const first = await pendingHistory(root, {
        label: language + '-first',
        createdAt: '2026-04-16 10:01:00',
        lastModified: '2026-04-16 10:03:00',
      });
      const second = await pendingHistory(root, {
        label: language + '-second',
        createdAt: '2026-04-16 10:02:00',
        lastModified: '2026-04-16 10:04:00',
        genseq: 2,
      });
      const records = [first.record, second.record];
      await DialogPersistence.saveActiveCalleeDispatches(root.id, records, undefined, root.status);
      const assertState = async (expectedOrder: string[], activity: string) => {
        const visible = await root.listVisibleReminders();
        assert.deepEqual(
          visible
            .filter((row) => row.id === pendingId || row.id === 'daemon001')
            .map((row) => row.id),
          expectedOrder,
        );
        const reminder = pendingReminder(root);
        assert.equal(reminder.id, pendingId);
        const meta = pendingMeta(reminder);
        assert.equal(meta.pendingCount, 2);
        assert.equal(meta.updatedAt, activity);
        const stored = await DialogPersistence.loadReminderState(root.id, root.status);
        const disk = stored.find((row) => row.id === pendingId);
        assert.ok(disk);
        assert.equal(disk.content, reminder.content);
        assert.deepEqual(disk.meta, reminder.meta);
      };
      assert.equal(await syncPendingTellaskReminderState(root), true);
      await root.processReminderUpdates();
      await assertState(['daemon001', pendingId], '2026-04-16 10:04:00');
      await capturePending({
        id: 'older-than-comparison',
        language,
        scenario:
          'Two declared sessioned pending calls have latest activity10:04, so their updated status sorts behind a supplied10:06 comparison note. The comparison note is fixture data, not a running daemon.',
        root,
        givenData: JSON.stringify(records),
        evidence,
      });
      await DialogPersistence.mutateDialogLatest(
        second.side.id,
        () => ({ kind: 'patch', patch: { lastModified: '2026-04-16 10:07:00' } }),
        second.side.status,
      );
      assert.equal(await syncPendingTellaskReminderState(root), true);
      await root.processReminderUpdates();
      await assertState([pendingId, 'daemon001'], '2026-04-16 10:07:00');
      await capturePending({
        id: 'newest-pending-activity',
        language,
        scenario:
          'The same second call now has declared activity10:07; the same reminder ID moves ahead of the10:06 comparison note and retains the two real persisted pending records.',
        root,
        givenData: JSON.stringify({ records, latestActivity: '2026-04-16 10:07:00' }),
        evidence,
      });
      const file = path.join(
        DialogPersistence.getDialogEventsPath(root.id, root.status),
        'active-callees.json',
      );
      const before = await fs.readFile(file, 'utf8');
      const beforeRecords = await DialogPersistence.loadActiveCalleeDispatches(
        root.id,
        root.status,
      );
      const invalid = [first.record, { ...second.record, sessionSlug: first.record.sessionSlug }];
      let caught: Error | undefined;
      try {
        await DialogPersistence.saveActiveCalleeDispatches(
          root.id,
          invalid,
          undefined,
          root.status,
        );
      } catch (error: unknown) {
        assert.ok(error instanceof Error);
        caught = error;
      }
      assert.ok(caught);
      assert.equal(await fs.readFile(file, 'utf8'), before);
      assert.deepEqual(
        await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status),
        beforeRecords,
      );
      evidence.record({
        id: language + '-duplicate-session-refused',
        scenario:
          'Two different callId/batch/callsite records claim the same worker and sessionSlug; the writer refuses before changing the existing valid persisted active-call file.',
        businessValue:
          'Keep ambiguous session obligations loud and preserve both prior valid work records instead of silently repairing them.',
        context: {
          language,
          invalidInput: JSON.stringify(invalid),
          preservedRecords: JSON.stringify(beforeRecords),
          scopeLimit:
            'Actual persistence writer and file bytes; invalid records are declared boundary data, not a claim that two such sessions were executed.',
        },
        reviewQuestions: [
          'Does the actual diagnostic accurately explain the duplicated session identity and avoid claiming successful persistence or silent repair?',
        ],
        actualText: caught.message,
      });
    });
  }
  await evidence.write();
  console.log('Pending tellask activity order, persistence and duplicate-session refusal: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Pending order case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
