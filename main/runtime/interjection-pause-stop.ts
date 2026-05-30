import type { DialogInterruptionReason } from '@longrun-ai/kernel/types/display-state';

const USER_INTERJECTION_PAUSE_STOP_DETAIL = 'user_interjection_pause_resume_original_task';

// WARNING:
// This special stop reason is only a UI/run-control projection for legacy paused-interjection
// state. New answered-interjection flow depends on pending interjection settlement plus ordinary
// drive rules instead of this stop reason. It is intentionally encoded as `system_stop`, but it
// does NOT mean the same thing as ordinary system-stop failure semantics.
//
// New user interjections should simply complete and the dialog should fall back to its true
// underlying state without showing this legacy resumption panel.
//
// In particular, askHuman answers are NOT "user interjections" for this purpose. A prompt carrying
// a real `q4hAnswerCallId` belongs to the askHuman reply channel and must never be routed through
// this paused-original-task stop semantics.
//
// Do not change this file in isolation. The complete behavior depends on coordinated logic across:
// - `reply-guidance.ts`          suppressing tellasker reply obligation during interjection chat
// - `flow.ts`                   answering locally, then using ordinary continuation rules
// - `dialog-display-state.ts`   preserving legacy paused projection until Continue during recovery
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
      zh: '插话已处理；原任务已暂停。“继续”会重新检查最新任务状态，继续发送新消息则继续这段临时对话。',
      en: 'Interjection handled; the original task is paused. Continue will recheck the latest task state, or send another message to keep this temporary side conversation going.',
    },
  };
}

export function isUserInterjectionPauseStopReason(
  reason: DialogInterruptionReason | undefined,
): boolean {
  return reason?.kind === 'system_stop' && reason.detail === USER_INTERJECTION_PAUSE_STOP_DETAIL;
}
