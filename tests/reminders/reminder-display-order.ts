import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import { materializeReminder, type Reminder } from '../../main/tool';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const older = new Date('2026-04-16T10:00:00.000Z');
    const newer = new Date('2026-04-16T10:01:00.000Z');
    const input = (id: string, createdAt: string, updatedAt?: string): Reminder =>
      materializeReminder({
        id,
        content: 'supplied-order-data:' + id,
        createdAt,
        ...(updatedAt === undefined ? {} : { meta: { updatedAt } }),
        scope: 'dialog',
        renderMode: 'markdown',
      });
    const cases = [
      {
        reminders: [
          input('updated-a', older.toISOString(), '2026-04-16T10:07:00.000Z'),
          input('updated-b', '2026-04-16T10:06:00.000Z'),
        ],
        expected: ['updated-a', 'updated-b'],
      },
      {
        reminders: [
          input('malformed-a', older.toISOString(), 'not-a-timestamp'),
          input('malformed-b', newer.toISOString()),
        ],
        expected: ['malformed-b', 'malformed-a'],
      },
      {
        reminders: [
          input('mixed-iso', newer.toISOString()),
          input('mixed-unified', formatUnifiedTimestamp(older)),
        ],
        expected: ['mixed-iso', 'mixed-unified'],
      },
    ];
    for (const row of cases) {
      const dialog = await createMainDialog();
      // Seed declared historical reminder data; ordering is observed through the actual
      // visible-dialog API, including its normal merge/sort path, not the comparator alone.
      dialog.reminders.push(...row.reminders);
      const ownIds = new Set(row.reminders.map((reminder) => reminder.id));
      const visible = await dialog.listVisibleReminders();
      assert.deepEqual(
        visible.filter((reminder) => ownIds.has(reminder.id)).map((reminder) => reminder.id),
        row.expected,
      );
    }
  });
  console.log('Visible reminder ordering by actual timestamps: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Reminder order case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
