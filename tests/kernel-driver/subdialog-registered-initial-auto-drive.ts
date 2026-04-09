import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromSupdialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createRootDialog,
  lastAssistantSaying,
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
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Start the registered sideline now.';
    const mentionList = ['@pangu'];
    const tellaskBody = 'Please answer 1+1 with exactly `2`.';
    const sessionSlug = 'sticky-session';
    const language = getWorkLanguage();

    const expectedSubdialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromSupdialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList,
        tellaskContent: tellaskBody,
        language,
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
    });
    const subdialogFinalResponse = '2';
    const mirroredSubdialogResponse = formatTellaskResponseContent({
      callName: 'tellask',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList,
      tellaskContent: tellaskBody,
      responseBody: subdialogFinalResponse,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      language,
      sessionSlug,
    });
    const rootFinalResponse = 'Ack: final registered sideline result received.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'Starting the sideline.',
        funcCalls: [
          {
            id: 'root-call-pangu-sticky',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: tellaskBody,
            },
          },
        ],
      },
      {
        message: expectedSubdialogPrompt,
        role: 'user',
        response: subdialogFinalResponse,
      },
      {
        message: mirroredSubdialogResponse,
        role: 'tool',
        response: rootFinalResponse,
      },
    ]);

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(trigger, 'kernel-driver-subdialog-registered-initial-auto-drive'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => lastAssistantSaying(root) === rootFinalResponse,
      3_000,
      'registered subdialog to auto-drive and deliver its final response',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const subdialog = root.lookupSubdialog('pangu', sessionSlug);
    assert.ok(subdialog, 'expected registered subdialog to exist after tellask completion');

    const events = await DialogPersistence.loadCourseEvents(
      subdialog.id,
      subdialog.currentCourse,
      subdialog.status,
    );
    assert.ok(
      events.some((event) => event.type === 'gen_start_record'),
      'expected registered subdialog to start a generation automatically',
    );
    assert.ok(
      events.some(
        (event) => event.type === 'tellask_call_anchor_record' && event.anchorRole === 'response',
      ),
      'expected registered subdialog to emit a response anchor after auto-drive',
    );
  });

  console.log('kernel-driver subdialog-registered-initial-auto-drive: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-registered-initial-auto-drive: FAIL\n${message}`);
  process.exit(1);
});
