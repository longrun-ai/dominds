import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import {
  formatContextHealthReminderText,
  formatReminderItemGuide,
} from '../shared/i18n/driver-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import type { ContextHealthSnapshot } from '../shared/types/context-health';
import type { Reminder, ReminderOwner, ReminderUpdateResult } from '../tool';

export const contextHealthReminderOwner: ReminderOwner = {
  name: 'context_health',

  async updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
    if (reminder.owner !== contextHealthReminderOwner) {
      return { treatment: 'keep' };
    }

    const snapshot: ContextHealthSnapshot | undefined = dlg.getLastContextHealth();
    if (!snapshot) {
      return { treatment: 'keep' };
    }

    if (snapshot.kind !== 'available') {
      return {
        treatment: 'update',
        updatedContent: formatContextHealthReminderText(getWorkLanguage(), {
          kind: 'usage_unknown',
        }),
      };
    }

    if (snapshot.promptTokens < snapshot.effectiveOptimalMaxTokens) {
      return { treatment: 'drop' };
    }

    const content = formatContextHealthReminderText(getWorkLanguage(), { kind: 'over_optimal' });
    return {
      treatment: 'update',
      updatedContent: content,
    };
  },

  async renderReminder(dlg: Dialog, reminder: Reminder, index: number): Promise<ChatMessage> {
    if (reminder.owner !== contextHealthReminderOwner) {
      return {
        type: 'transient_guide_msg',
        role: 'assistant',
        content: formatReminderItemGuide(getWorkLanguage(), index + 1, reminder.content),
      };
    }

    const snapshot: ContextHealthSnapshot | undefined = dlg.getLastContextHealth();
    const content =
      snapshot && snapshot.kind === 'available'
        ? formatContextHealthReminderText(getWorkLanguage(), { kind: 'over_optimal' })
        : formatContextHealthReminderText(getWorkLanguage(), { kind: 'usage_unknown' });

    return {
      type: 'transient_guide_msg',
      role: 'assistant',
      content: formatReminderItemGuide(getWorkLanguage(), index + 1, content),
    };
  },
};
