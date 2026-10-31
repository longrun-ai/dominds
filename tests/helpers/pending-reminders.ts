import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import {
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  type ActiveCalleeDispatchRecord,
} from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import type { MainDialog } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Reminder } from '../../main/tool';
import { pendingTellaskReminderOwner } from '../../main/tools/pending-tellask-reminder';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';
import { semanticEvidenceCollector } from './semantic-evidence';

export async function withPendingReminderRoot(
  language: LanguageCode,
  action: (root: MainDialog) => Promise<void>,
) {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { extraMembers: ['worker'] });
    setWorkLanguage(language);
    const root = await createMainDialog();
    root.setLastUserLanguageCode(language);
    await root.processReminderUpdates();
    await action(root);
  });
}

export async function pendingHistory(
  root: MainDialog,
  options: { label: string; createdAt: string; lastModified: string; genseq?: number },
) {
  const callId = 'pending-call-' + options.label;
  const sessionSlug = 'pending-session-' + options.label;
  const tellaskContent = 'Follow the current assignment: ' + options.label;
  const callSiteCourse = toCallSiteCourseNo(root.currentCourse);
  const callSiteGenseq = toCallSiteGenseqNo(options.genseq ?? 1);
  const side = await root.createSideDialog('worker', ['@worker'], tellaskContent, {
    callName: 'tellask',
    originMemberId: root.agentId,
    askerDialogId: root.id.selfId,
    callId,
    callSiteCourse,
    callSiteGenseq,
    sessionSlug,
    collectiveTargets: ['worker'],
  });
  await DialogPersistence.saveSideDialogMetadata(
    side.id,
    {
      id: side.id.selfId,
      agentId: 'worker',
      taskDocPath: root.taskDocPath,
      createdAt: options.createdAt,
    },
    side.status,
  );
  await DialogPersistence.mutateDialogLatest(
    side.id,
    () => ({ kind: 'patch', patch: { lastModified: options.lastModified } }),
    side.status,
  );
  const record: ActiveCalleeDispatchRecord = {
    calleeDialogId: side.id.selfId,
    createdAt: options.createdAt,
    batchId: callId + '-batch',
    callName: 'tellask',
    mentionList: ['@worker'],
    tellaskContent,
    targetAgentId: 'worker',
    callId,
    callSiteCourse,
    callSiteGenseq,
    callType: 'B',
    sessionSlug,
  };
  return { side, record };
}

export function pendingReminder(root: MainDialog): Reminder {
  const matches = root.reminders.filter(
    (reminder) => reminder.owner?.name === pendingTellaskReminderOwner.name,
  );
  assert.equal(matches.length, 1);
  return matches[0]!;
}

export function pendingMeta(reminder: Reminder) {
  const meta = reminder.meta;
  assert.ok(meta !== null && typeof meta === 'object' && !Array.isArray(meta));
  assert.equal(meta.kind, 'pending_tellask');
  return meta;
}

export async function capturePending(args: {
  id: string;
  language: LanguageCode;
  scenario: string;
  root: MainDialog;
  givenData: string;
  evidence: ReturnType<typeof semanticEvidenceCollector>;
}) {
  const reminder = pendingReminder(args.root);
  const rendered = await pendingTellaskReminderOwner.renderReminder(args.root, reminder);
  assert.ok(rendered.type === 'environment_msg');
  args.evidence.record({
    id: args.language + '-' + args.id,
    scenario: args.scenario,
    businessValue:
      'Expose the current dialog tellask obligations accurately without inventing global execution state, blocking real work or suppressing a legitimate human wait.',
    context: {
      language: args.language,
      reminderId: reminder.id,
      rootId: args.root.id.rootId,
      selfId: args.root.id.selfId,
      agentId: args.root.agentId,
      taskDocPath: args.root.taskDocPath,
      givenData: args.givenData,
      scopeLimit:
        'Actual owner/sync reads actual persisted active-call history and side latest records, with real Dialog/store. Historical timestamps/assignments and optional human-question state are declared fixture input; no provider execution, actual human exchange, UI or process restart is established.',
    },
    reviewQuestions: [
      'Do the actual state note, maintenance directions and rendered environment message fit the declared pending calls and other wait conditions without promoting stale work, inventing control capabilities or forbidding valid waiting?',
    ],
    actualText: JSON.stringify(
      { reminderBody: reminder.content, meta: reminder.meta, rendered },
      null,
      2,
    ),
  });
}
