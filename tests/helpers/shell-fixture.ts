import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { MainDialog } from '../../main/dialog';
import { Team } from '../../main/team';
import { shellCmdReminderOwner, stopDaemonTool } from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';
import { waitFor } from '../kernel-driver/helpers';
import { daemonMeta, processIsRunning } from './daemon-reminders';
import { withManualReminderDialog } from './manual-reminders';

export async function shellDaemons(dialog: MainDialog) {
  return (await dialog.listVisibleReminders()).filter(
    (row) => row.owner?.name === shellCmdReminderOwner.name,
  );
}
export async function withShellDialog(
  language: LanguageCode,
  action: (dialog: MainDialog, caller: Team.Member) => Promise<void>,
) {
  await withManualReminderDialog(language, async (dialog) => {
    const caller = new Team.Member({
      id: 'tester',
      name: 'Tester',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });
    registerReminderOwner(shellCmdReminderOwner);
    try {
      await action(dialog, caller);
    } finally {
      try {
        // Only processes created in this case's owned isolated rtws can appear.
        // An unexpected background transition must still release its process.
        for (const reminder of await shellDaemons(dialog)) {
          const meta = daemonMeta(reminder);
          const stopped = await stopDaemonTool.call(dialog, caller, { pid: meta.pid });
          if (stopped.outcome !== 'success' && (await processIsRunning(meta.pid)))
            throw new Error('Could not stop the case-owned unexpected daemon');
          await waitFor(
            async () => !(await processIsRunning(meta.pid)),
            3_000,
            'case-owned shell process to exit',
          );
        }
      } finally {
        unregisterReminderOwner(shellCmdReminderOwner.name);
      }
    }
  });
}
export async function writeNodeProgram(name: string, source: string) {
  assert.ok(/^[a-z0-9-]+$/.test(name), 'Fixture filename must be a safe basename');
  const file = name + '.cjs';
  await fs.writeFile(file, source);
  return 'node ' + file;
}
/** Extract fixture JSON data; completion labels and natural prose are not parsed. */
export function fixtureJson(content: string, probeId: string): Record<string, unknown> {
  const matches: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'probe' in value &&
      value.probe === probeId
    )
      matches.push(value as Record<string, unknown>);
  }
  assert.equal(
    matches.length,
    1,
    'Exactly one complete fixture data record must survive tool output',
  );
  return matches[0]!;
}
