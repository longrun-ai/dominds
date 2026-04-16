import assert from 'node:assert/strict';

import { compareReminderDisplayOrder, materializeReminder } from '../../main/tool';

(() => {
  const pendingReminder = materializeReminder({
    id: 'pending001',
    content: 'pending',
    createdAt: '2026-04-16 10:00:00',
    meta: {
      kind: 'pending_tellask',
      updatedAt: '2026-04-16 10:07:00',
    },
  });
  const daemonReminder = materializeReminder({
    id: 'daemon001',
    content: 'daemon',
    createdAt: '2026-04-16 10:06:00',
  });
  assert.ok(
    compareReminderDisplayOrder(pendingReminder, daemonReminder) < 0,
    'Expected reminder updatedAt to outrank an older daemon createdAt',
  );
})();

(() => {
  const malformedMetaReminder = materializeReminder({
    id: 'badmeta001',
    content: 'bad meta',
    createdAt: '2026-04-16T10:00:00.000Z',
    meta: {
      updatedAt: 'not-a-timestamp',
    },
  });
  const newerReminder = materializeReminder({
    id: 'newer001',
    content: 'newer',
    createdAt: '2026-04-16T10:01:00.000Z',
  });
  assert.ok(
    compareReminderDisplayOrder(malformedMetaReminder, newerReminder) > 0,
    'Expected malformed meta.updatedAt to be ignored for reminder ordering',
  );
})();

(() => {
  const isoReminder = materializeReminder({
    id: 'iso001',
    content: 'iso',
    createdAt: '2026-04-16T10:01:00.000Z',
  });
  const unifiedReminder = materializeReminder({
    id: 'unified001',
    content: 'unified',
    createdAt: '2026-04-16 10:00:00',
  });
  assert.ok(
    compareReminderDisplayOrder(isoReminder, unifiedReminder) < 0,
    'Expected reminder ordering to compare mixed timestamp formats by actual time, not raw string',
  );
})();

console.log('OK');
