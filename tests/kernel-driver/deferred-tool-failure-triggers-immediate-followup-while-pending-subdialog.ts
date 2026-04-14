import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromSupdialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';

import {
  createRootDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      memberToolsets: ['codex_style_tools'],
    });

    const language = getWorkLanguage();
    const initialPrompt = 'Start a background tellask and wait for @pangu.';
    const tellaskBody = 'Please investigate in the background and report back later.';
    const pendingSubdialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromSupdialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: tellaskBody,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const interjectPrompt =
      'While waiting for @pangu, record the current plan, even if the first attempt fails.';
    const interjectSaying = 'I will record the current plan while @pangu is still pending.';
    const deferredFailureFollowUp =
      'The update_plan call failed, so I need to correct it later while still waiting for @pangu.';
    const delayedSubdialogResponse = 'Background investigation is complete.';
    const mirroredSubdialogResponse = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList: ['@pangu'],
      tellaskContent: tellaskBody,
      responseBody: delayedSubdialogResponse,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
    });
    const invalidUpdatePlanArgsError = 'Invalid arguments: Field plan does not match expected type';

    await writeMockDb(tmpRoot, [
      {
        message: initialPrompt,
        role: 'user',
        response: 'Starting the background tellask now.',
        funcCalls: [
          {
            id: 'call-root-background-tellask',
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'pangu',
              tellaskContent: tellaskBody,
            },
          },
        ],
      },
      {
        message: interjectPrompt,
        role: 'user',
        response: interjectSaying,
        funcCalls: [
          {
            id: 'call-root-interject-update-plan-invalid',
            name: 'update_plan',
            arguments: {
              explanation: 'Wait for pangu before resuming implementation',
              plan: {
                step: 'This is intentionally invalid because plan must be an array',
                status: 'in_progress',
              },
            },
          },
        ],
      },
      {
        message: invalidUpdatePlanArgsError,
        role: 'tool',
        response: deferredFailureFollowUp,
        contextContains: [interjectSaying],
      },
      {
        message: pendingSubdialogPrompt,
        role: 'user',
        response: delayedSubdialogResponse,
        delayMs: 2_000,
      },
      {
        message: mirroredSubdialogResponse,
        role: 'tool',
        response: 'Acknowledged. I have the background result now.',
      },
    ]);

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(
        initialPrompt,
        'kernel-driver-deferred-tool-failure-pending-subdialog-initial',
      ),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await waitFor(
      async () => {
        const pending = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
        return pending.length === 1;
      },
      3_000,
      'root dialog to enter pending-subdialog wait state',
    );

    await driveDialogStream(
      root,
      makeUserPrompt(
        interjectPrompt,
        'kernel-driver-deferred-tool-failure-pending-subdialog-followup',
      ),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    const rootEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const genStartCount = rootEvents.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount,
      3,
      'deferred tool failure should trigger an immediate post-tool generation while a subdialog is pending',
    );

    const assistantSayings = root.msgs.filter(
      (
        msg,
      ): msg is Extract<(typeof root.msgs)[number], { type: 'saying_msg'; role: 'assistant' }> =>
        msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.equal(
      assistantSayings[assistantSayings.length - 1]?.content,
      deferredFailureFollowUp,
      'interjection drive should immediately follow up on the deferred tool failure before suspending again',
    );

    const pendingAfterInterjection = await DialogPersistence.loadPendingSubdialogs(
      root.id,
      root.status,
    );
    assert.equal(
      pendingAfterInterjection.length,
      1,
      'the original tellask subdialog should still remain pending after the deferred-tool failure follow-up',
    );

    await waitForAllDialogsUnlocked(root, 6_000);
  });

  console.log(
    'kernel-driver deferred-tool-failure-triggers-immediate-followup-while-pending-subdialog: PASS',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver deferred-tool-failure-triggers-immediate-followup-while-pending-subdialog: FAIL\n${message}`,
  );
  process.exit(1);
});
