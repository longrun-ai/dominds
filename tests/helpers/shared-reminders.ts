import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dialog, MainDialog, SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import type { ToolCallOutput } from '../../main/tool';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';
import { semanticEvidenceCollector } from './semantic-evidence';

type SharedReminderFixture = {
  rtws: string;
  taskDocPath: string;
  otherTaskDocPath: string;
  caller: Team.Member;
  root(agentId?: string, taskDocPath?: string): Promise<MainDialog>;
  side(root: MainDialog, callId: string, agentId?: string): Promise<SideDialog>;
  lock(root: MainDialog): Promise<void>;
};

export async function withSharedReminderFixture(
  language: LanguageCode,
  action: (fixture: SharedReminderFixture) => Promise<void>,
) {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, {
      extraMembers: [
        'mentor',
        'mentor-single',
        'mentor-cross-root',
        'mentor-other-task',
        'other-agent',
      ],
    });
    setWorkLanguage(language);
    const taskDocPath = `shared-reminder-${language}-task.tsk`;
    const otherTaskDocPath = `other-shared-reminder-${language}-task.tsk`;
    for (const task of [taskDocPath, otherTaskDocPath]) {
      const directory = path.join(rtws, task);
      await fs.mkdir(directory, { recursive: true });
      for (const [file, content] of Object.entries({
        'goals.md': 'Preserve the given shared-reminder work state and its intended audience.\n',
        'constraints.md': 'Only fixture-supplied actors and capabilities are available.\n',
        'progress.md': 'The controlled reminder scenario is ready.\n',
      }))
        await fs.writeFile(path.join(directory, file), content);
    }
    const roots: MainDialog[] = [];
    const releases: (() => void)[] = [];
    try {
      await action({
        rtws,
        taskDocPath,
        otherTaskDocPath,
        caller: new Team.Member({ id: 'tester', name: 'Tester' }),
        async root(agentId = 'tester', task = taskDocPath) {
          const root = await createMainDialog(agentId, task);
          root.setLastUserLanguageCode(language);
          globalDialogRegistry.register(root);
          roots.push(root);
          return root;
        },
        async side(root, callId, agentId = 'tester') {
          const side = await root.createSideDialog(
            agentId,
            ['@' + agentId],
            'supplied-assignment-data:' + callId,
            {
              callName: 'tellask',
              originMemberId: root.agentId,
              askerDialogId: root.id.selfId,
              callId,
              callSiteCourse: toCallSiteCourseNo(root.currentCourse),
              callSiteGenseq: toCallSiteGenseqNo(1),
            },
          );
          side.setLastUserLanguageCode(language);
          root.addActiveCalleeDialogs([side.id]);
          return side;
        },
        async lock(root) {
          releases.push(await root.acquire());
        },
      });
    } finally {
      for (const release of releases.reverse()) release();
      for (const root of roots) globalDialogRegistry.unregister(root.id.rootId);
    }
  });
}

export async function sharedReminderFile(
  rtws: string,
  reminderId: string,
): Promise<{ relativePath: string; data: Record<string, unknown> } | undefined> {
  const directory = path.join(rtws, '.dialogs', 'reminders');
  const entries = await fs.readdir(directory, { recursive: true });
  const found = entries.filter((entry) => path.basename(entry) === reminderId + '.json');
  assert.ok(
    found.length <= 1,
    'A shared reminder ID must not be duplicated across storage targets',
  );
  if (found.length === 0) return undefined;
  const data: unknown = JSON.parse(await fs.readFile(path.join(directory, found[0]!), 'utf8'));
  assert.ok(data !== null && typeof data === 'object' && !Array.isArray(data));
  return { relativePath: found[0]!, data: data as Record<string, unknown> };
}

export async function sharedNoticeState(actors: readonly Dialog[]) {
  return Promise.all(
    actors.map(async (dialog) => {
      const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
      assert.ok(latest);
      return {
        id: dialog.id.valueOf(),
        queued: structuredClone(dialog.peekQueuedPrompt()),
        hasQueue: dialog.hasQueuedPrompt(),
        pendingRuntimePrompt: latest.pendingRuntimePrompt,
        nextStep: latest.nextStep,
        rootDriveQueued: globalDialogRegistry.isRootDriveQueued(dialog.id.rootId),
      };
    }),
  );
}

export async function captureSharedNotices(args: {
  id: string;
  language: LanguageCode;
  scenario: string;
  updater: Dialog;
  reminderId: string;
  scope: 'task' | 'agent';
  actors: readonly Dialog[];
  recipients: readonly Dialog[];
  receipt?: ToolCallOutput;
  givenData: string;
  evidence: ReturnType<typeof semanticEvidenceCollector>;
}) {
  assert.equal(new Set(args.actors.map((dialog) => dialog.id.valueOf())).size, args.actors.length);
  const received = [];
  for (const dialog of args.actors) {
    const queued = dialog.takeQueuedPrompt();
    if (queued === undefined) continue;
    assert.equal(queued.kind, 'new_course_runtime_guide');
    assert.equal(queued.origin, 'runtime');
    assert.equal(queued.grammar, 'markdown');
    assert.equal(queued.userLanguageCode, args.language);
    assert.equal(queued.skipTaskdoc, true);
    assert.equal(dialog.peekQueuedPrompt(), undefined);
    const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    assert.ok(latest?.pendingRuntimePrompt);
    const pending = latest.pendingRuntimePrompt;
    assert.deepEqual(
      {
        content: pending.content,
        msgId: pending.msgId,
        grammar: pending.grammar,
        origin: pending.origin,
        userLanguageCode: pending.userLanguageCode,
        skipTaskdoc: pending.skipTaskdoc,
      },
      {
        content: queued.prompt,
        msgId: queued.msgId,
        grammar: 'markdown',
        origin: 'runtime',
        userLanguageCode: args.language,
        skipTaskdoc: true,
      },
    );
    const triggers = latest.nextStep.triggers.filter(
      (trigger) => trigger.kind === 'queued_prompt' && trigger.promptId === queued.msgId,
    );
    assert.equal(triggers.length, 1);
    const trigger = triggers[0]!;
    assert.ok(trigger.kind === 'queued_prompt');
    assert.equal(trigger.course, dialog.currentCourse);
    received.push({ recipient: dialog, queued });
  }
  assert.deepEqual(
    received.map(({ recipient }) => recipient.id.valueOf()).sort(),
    args.recipients.map((dialog) => dialog.id.valueOf()).sort(),
  );
  const expectedRoots = new Set(args.recipients.map((dialog) => dialog.id.rootId));
  for (const rootId of new Set(args.actors.map((dialog) => dialog.id.rootId)))
    assert.equal(globalDialogRegistry.isRootDriveQueued(rootId), expectedRoots.has(rootId));
  args.evidence.record({
    id: args.language + '-' + args.id,
    scenario: args.scenario,
    businessValue:
      'Deliver relevant shared-state changes to the intended executing peers without redirecting historical, private or unrelated work.',
    context: {
      language: args.language,
      reminderId: args.reminderId,
      scope: args.scope,
      givenData: args.givenData,
      updaterAgent: args.updater.agentId,
      updaterTask: args.updater.taskDocPath,
      expectedRecipients: JSON.stringify(
        args.recipients.map((dialog) => ({
          agentId: dialog.agentId,
          taskDocPath: dialog.taskDocPath,
          id: dialog.id.valueOf(),
        })),
      ),
      scopeLimit:
        'Real Dialog/registry/queue/disk and scheduled root flags. Notices are pending work, not LLM/backend consumption or restart delivery. Fixture explicitly acknowledges each observed queued notice afterward using production clear APIs.',
    },
    reviewQuestions: [
      'Do the actual receipt and each queued notice accurately describe the observed scope/change/withdrawal and intended recipient, without prescribing private state or claiming the peer already handled it?',
    ],
    actualText: JSON.stringify(
      {
        receipt: args.receipt,
        notices: received.map(({ recipient, queued }) => ({
          recipient: recipient.id.valueOf(),
          agentId: recipient.agentId,
          taskDocPath: recipient.taskDocPath,
          prompt: queued.prompt,
        })),
      },
      null,
      2,
    ),
  });
  // Explicit test acknowledgment keeps later phases independent. This is not a
  // claim that a provider/backend consumed the queued runtime guide.
  for (const { recipient, queued } of received)
    await DialogPersistence.clearPendingRuntimePrompt(recipient.id, queued.msgId, recipient.status);
  for (const rootId of new Set(args.actors.map((dialog) => dialog.id.rootId)))
    globalDialogRegistry.clearRootDriveQueue(rootId);
}
