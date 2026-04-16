import type { ApiMoveDialogsRequest, DialogStatusKind } from '@longrun-ai/kernel/types';
import type { FullRemindersEvent } from '@longrun-ai/kernel/types/dialog';
import type { DialogCreateAction } from './create-dialog-flow';
import type { DialogViewportPanelState } from './dominds-dialog-container.js';

/**
 * Shared contract for all app-scoped custom DOM events.
 * Do not hand-write `new CustomEvent('...')` payload shapes outside this module.
 * Both emitters and listeners must share this single static source of truth.
 */

export type PersistableDialogStatus = Exclude<DialogStatusKind, 'quarantining'>;

export type UiToastKind = 'error' | 'warning' | 'info';

export type ToastHistoryPolicy = 'default' | 'persist' | 'skip';

export type UiToastDetail = {
  message: string;
  kind?: UiToastKind;
  history?: ToastHistoryPolicy;
};

export type SnippetInsertDetail = {
  content: string;
};

export type InputErrorDetail = {
  message: string;
  type?: UiToastKind;
};

export type ReminderTextDetail = {
  index: number;
  content: string;
  renderMode?: 'plain' | 'markdown';
};

export type DialogHierarchyToggleDetail = {
  rootId: string;
  status: PersistableDialogStatus;
};

export type DialogDeleteAction = {
  kind: 'root';
  rootId: string;
  fromStatus: DialogStatusKind;
};

export type DialogDeepLinkDetail = {
  rootId: string;
  selfId: string;
};

export type TeamMembersMentionEventDetail = {
  memberId: string;
  mention: string;
};

export type Q4HCallSiteNavigationDetail = {
  questionId: string;
  dialogId: string;
  rootId: string;
  course: number;
  messageIndex: number;
  callId?: string;
};

export type Q4HSelectQuestionDetail = {
  questionId: string | null;
  dialogId: string;
  rootId: string;
  tellaskContent: string;
};

export type Q4HQuestionExpandedDetail = {
  questionId: string;
};

export type NavigateGenseqEventDetail = {
  rootId: string;
  selfId: string;
  course: number;
  genseq: number;
};

export type NavigateCallsiteEventDetail = {
  rootId: string;
  selfId: string;
  course: number;
  callId: string;
};

export type ForkDialogRequestDetail = {
  rootId: string;
  selfId: string;
  status: PersistableDialogStatus;
  course: number;
  genseq: number;
};

export type ScrollToCallIdDetail = {
  course: number;
  callId: string;
};

export type ScrollToGenseqDetail = {
  course: number;
  genseq: number;
};

export type ScrollToCallSiteDetail =
  | {
      course: number;
      callId: string;
      messageIndex?: undefined;
    }
  | {
      course: number;
      messageIndex: number;
      callId?: undefined;
    };

export type SubdialogCreatedDetail = {
  rootId: string;
  calleeDialogId: string;
};

export type UsersendDetail = {
  content: string;
};

export interface DomindsCustomEventMap {
  'auth-required': CustomEvent<undefined>;
  'dialog-collapse': CustomEvent<DialogHierarchyToggleDetail>;
  'dialog-create-action': CustomEvent<DialogCreateAction>;
  'dialog-delete-action': CustomEvent<DialogDeleteAction>;
  'dialog-expand': CustomEvent<DialogHierarchyToggleDetail>;
  'dialog-open-external': CustomEvent<DialogDeepLinkDetail>;
  'dialog-share-link': CustomEvent<DialogDeepLinkDetail>;
  'dialog-status-action': CustomEvent<ApiMoveDialogsRequest>;
  'dialog-viewport-panel-state': CustomEvent<{ state: DialogViewportPanelState }>;
  'fork-dialog-request': CustomEvent<ForkDialogRequestDetail>;
  'input-error': CustomEvent<InputErrorDetail>;
  'navigate-callsite': CustomEvent<NavigateCallsiteEventDetail>;
  'navigate-genseq': CustomEvent<NavigateGenseqEventDetail>;
  'q4h-navigate-call-site': CustomEvent<Q4HCallSiteNavigationDetail>;
  'q4h-open-external': CustomEvent<Q4HCallSiteNavigationDetail>;
  'q4h-question-expanded': CustomEvent<Q4HQuestionExpandedDetail>;
  'q4h-select-question': CustomEvent<Q4HSelectQuestionDetail>;
  'q4h-share-link': CustomEvent<Q4HCallSiteNavigationDetail>;
  'reminders-update': CustomEvent<{ reminders: FullRemindersEvent['reminders'] }>;
  'reminder-text': CustomEvent<ReminderTextDetail>;
  'scroll-to-call-id': CustomEvent<ScrollToCallIdDetail>;
  'scroll-to-call-site': CustomEvent<ScrollToCallSiteDetail>;
  'scroll-to-genseq': CustomEvent<ScrollToGenseqDetail>;
  'snippet-insert': CustomEvent<SnippetInsertDetail>;
  'subdialog-created': CustomEvent<SubdialogCreatedDetail>;
  'team-member-mention': CustomEvent<TeamMembersMentionEventDetail>;
  'team-members-refresh': CustomEvent<undefined>;
  'ui-toast': CustomEvent<UiToastDetail>;
  usersend: CustomEvent<UsersendDetail>;
}

export type DomindsCustomEventName = keyof DomindsCustomEventMap;

export type DomindsCustomEventDetail<K extends DomindsCustomEventName> =
  DomindsCustomEventMap[K] extends CustomEvent<infer Detail> ? Detail : never;

export function dispatchDomindsEvent<K extends DomindsCustomEventName>(
  target: EventTarget,
  type: K,
  detail: DomindsCustomEventDetail<K>,
  init?: Omit<CustomEventInit<DomindsCustomEventDetail<K>>, 'detail'>,
): boolean {
  return target.dispatchEvent(
    new CustomEvent(type, {
      ...init,
      detail,
    }),
  );
}

declare global {
  interface HTMLElementEventMap extends DomindsCustomEventMap {}
  interface ShadowRootEventMap extends DomindsCustomEventMap {}
}
