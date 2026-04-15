import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolvePromptReplyGuidance } from '../../main/llm/kernel-driver/reply-guidance';
import { DialogPersistence } from '../../main/persistence';
import { formatAssignmentFromSupdialog } from '../../main/runtime/inter-dialog-format';
import { createRootDialog } from './helpers';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-subdialog-new-course-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const root = await createRootDialog();
    const subdialog = await root.createSubDialog('tester', ['@tester'], 'old tellask body', {
      callName: 'tellask',
      originMemberId: 'tester',
      callerDialogId: root.id.selfId,
      callId: 'call-old',
      sessionSlug: 'build.loop',
    });

    await subdialog.persistUserMessage(
      formatAssignmentFromSupdialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'tester',
        mentionList: ['@tester'],
        tellaskContent: 'old tellask body',
        language: 'en',
        collectiveTargets: ['tester'],
      }),
      'msg-old-assignment',
      'markdown',
      'runtime',
      'en',
      undefined,
      {
        expectedReplyCallName: 'replyTellask',
        targetCallId: 'call-old',
        tellaskContent: 'old tellask body',
      },
    );

    const updatedAssignment = {
      ...subdialog.assignmentFromSup,
      tellaskContent: 'new tellask body',
      callId: 'call-new',
    };
    subdialog.assignmentFromSup = updatedAssignment;
    await DialogPersistence.updateSubdialogAssignment(subdialog.id, updatedAssignment);

    await subdialog.startNewCourse('continue in course two');

    const queuedPrompt = subdialog.peekUpNext();
    assert.ok(queuedPrompt, 'expected startNewCourse to queue a new-course prompt');
    assert.equal(
      queuedPrompt.tellaskReplyDirective?.targetCallId,
      'call-new',
      'new-course prompt must carry the latest assignment callId instead of replaying stale history',
    );
    assert.equal(
      queuedPrompt.tellaskReplyDirective?.tellaskContent,
      'new tellask body',
      'new-course prompt must carry the latest assignment tellask content',
    );
    assert.equal(
      queuedPrompt.subdialogReplyTarget?.callType,
      'B',
      'sessioned tellask new-course prompt must target the Type-B parent pending record',
    );
    assert.equal(
      queuedPrompt.subdialogReplyTarget?.callId,
      'call-new',
      'new-course prompt must target the latest parent pending callId',
    );

    const replyGuidance = await resolvePromptReplyGuidance({
      dlg: subdialog,
      prompt: {
        content: queuedPrompt.prompt,
        msgId: queuedPrompt.msgId,
        grammar: queuedPrompt.grammar ?? 'markdown',
        origin: queuedPrompt.origin,
        userLanguageCode: queuedPrompt.userLanguageCode,
        q4hAnswerCallId: queuedPrompt.q4hAnswerCallId,
        tellaskReplyDirective: queuedPrompt.tellaskReplyDirective,
        skipTaskdoc: queuedPrompt.skipTaskdoc,
        subdialogReplyTarget: queuedPrompt.subdialogReplyTarget,
        runControl: queuedPrompt.runControl,
      },
      language: 'en',
    });
    assert.equal(
      replyGuidance.persistedTellaskReplyDirective?.targetCallId,
      'call-new',
      'reply guidance must stay on the current assignment instead of falling back to stale history',
    );
  });

  console.log('kernel-driver subdialog-new-course-uses-current-assignment-directive: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver subdialog-new-course-uses-current-assignment-directive: FAIL\n${message}`,
  );
  process.exit(1);
});
