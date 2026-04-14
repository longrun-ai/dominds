import type { DialogInterruptionReason } from '@longrun-ai/kernel/types/display-state';

const USER_INTERJECTION_PAUSE_STOP_DETAIL = 'user_interjection_pause_resume_original_task';

// WARNING:
// This special stop reason is only a UI/run-control projection for "user interjected, and there
// is still an original task parked for explicit Continue". It is intentionally encoded as
// `system_stop`, but it does NOT mean the same thing as ordinary system-stop failure semantics.
//
// Not every user interjection should use this reason. If there is no parked original task to
// resume afterwards, the interjection should simply complete and the dialog should fall back to
// its true underlying state without showing this stopped panel.
//
// Do not change this file in isolation. The complete behavior depends on coordinated logic across:
// - `reply-guidance.ts`          suppressing upstream reply obligation during interjection chat
// - `flow.ts`                   parking after the local reply, then re-running fresh-fact resume
// - `dialog-display-state.ts`   preserving this paused projection until explicit Continue
// - `websocket-handler.ts`      treating Continue as "resume attempt" rather than immediate success
//
// Reading only this stop reason or only `displayState.kind === 'stopped'` gives an incomplete and
// often wrong mental model.
export function buildUserInterjectionPauseStopReason(): Extract<
  DialogInterruptionReason,
  { kind: 'system_stop' }
> {
  return {
    kind: 'system_stop',
    detail: USER_INTERJECTION_PAUSE_STOP_DETAIL,
    i18nStopReason: {
      zh: '插话已处理；原任务已暂停。点击“继续”恢复原任务，继续发送新消息则继续这段临时对话。',
      en: 'Interjection handled; the original task is paused. Click Continue to resume it, or send another message to keep this temporary side conversation going.',
    },
  };
}

export function isUserInterjectionPauseStopReason(
  reason: DialogInterruptionReason | undefined,
): boolean {
  return reason?.kind === 'system_stop' && reason.detail === USER_INTERJECTION_PAUSE_STOP_DETAIL;
}
