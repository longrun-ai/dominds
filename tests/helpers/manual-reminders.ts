import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { MainDialog } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import type { Reminder } from '../../main/tool';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

export const reminderCaller = new Team.Member({ id: 'tester', name: 'Tester' });

export async function withManualReminderDialog(
  language: LanguageCode,
  action: (dialog: MainDialog) => Promise<void>,
) {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    setWorkLanguage(language);
    const dialog = await createMainDialog();
    dialog.setLastUserLanguageCode(language);
    await dialog.processReminderUpdates();
    await action(dialog);
  });
}

export function reminderData(reminders: readonly Reminder[]) {
  return structuredClone(
    reminders.map((reminder) => ({
      id: reminder.id,
      content: reminder.content,
      meta: reminder.meta,
      scope: reminder.scope,
      renderMode: reminder.renderMode,
      createdAt: reminder.createdAt,
      priority: reminder.priority,
      echoback: reminder.echoback,
      owner: reminder.owner?.name,
    })),
  );
}

export async function manualReminderSnapshot(dialog: MainDialog) {
  return {
    remindersVer: dialog.remindersVer,
    updatedAt: dialog.updatedAt,
    memory: reminderData(dialog.reminders),
    disk: reminderData(await DialogPersistence.loadReminderState(dialog.id, dialog.status)),
  };
}
