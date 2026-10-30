import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { Dialog, MainDialog } from '../../dialog';
import {
  formatAgentFacingCriticalUserInterjectionRemediationGuide,
  isAgentFacingCriticalUserInterjectionRemediationGuideContent,
} from '../../runtime/driver-messages';
import { consumeCriticalCountdown, resolveCriticalCountdownRemaining } from './context-health';

export type UserMessageIngressPrompt = {
  content: string;
  msgId: string;
  grammar: 'markdown';
  userLanguageCode?: LanguageCode;
};

export function wrapCriticalUserInterjectionPromptAtIngress<T extends UserMessageIngressPrompt>(
  dialog: Dialog,
  prompt: T,
): T {
  if (isAgentFacingCriticalUserInterjectionRemediationGuideContent(prompt.content)) {
    return prompt;
  }
  const snapshot = dialog.getLastContextHealth();
  if (snapshot?.kind !== 'available' || snapshot.level !== 'critical') {
    return prompt;
  }
  const remaining = resolveCriticalCountdownRemaining(dialog.id.key(), snapshot);
  if (remaining <= 0) {
    return prompt;
  }
  const language = prompt.userLanguageCode ?? dialog.getLastUserLanguageCode();
  const dialogScope = dialog instanceof MainDialog ? 'mainDialog' : 'sideDialog';
  const prefix = formatAgentFacingCriticalUserInterjectionRemediationGuide(language, {
    dialogScope,
    promptsRemainingAfterThis: consumeCriticalCountdown(dialog.id.key()),
  });
  return {
    ...prompt,
    content: `${prefix}\n\n${prompt.content}`,
  };
}
