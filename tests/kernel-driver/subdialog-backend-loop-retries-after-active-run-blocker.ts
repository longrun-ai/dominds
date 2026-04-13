import assert from 'node:assert/strict';

import { clearActiveRun, createActiveRun } from '../../main/dialog-display-state';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { runBackendDriver } from '../../main/llm/kernel-driver/loop';
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
    const sessionSlug = 'backend-loop-active-run-retry';
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
    const rootFinalResponse = 'Ack: backend loop retried after active-run blocker.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'Starting the sideline.',
        funcCalls: [
          {
            id: 'root-call-pangu-backend-loop-retry',
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
        delayMs: 300,
      },
      {
        message: mirroredSubdialogResponse,
        role: 'tool',
        response: rootFinalResponse,
      },
    ]);

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);
    void runBackendDriver();

    await driveDialogStream(
      root,
      makeUserPrompt(trigger, 'kernel-driver-subdialog-backend-loop-active-run-blocker'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await waitFor(
      async () => root.lookupSubdialog('pangu', sessionSlug) !== undefined,
      3_000,
      'registered sideline to exist before simulating the active-run blocker',
    );
    createActiveRun(root.id);

    await waitFor(
      async () => {
        const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
        return latest?.needsDrive === true;
      },
      3_000,
      'root revive to queue while the synthetic active run is still present',
    );
    await waitFor(
      async () => globalDialogRegistry.hasPendingActiveRunClearedWake(root.id.rootId),
      3_000,
      'backend loop to record that the queued root revive was deferred by the synthetic active run',
    );
    clearActiveRun(root.id);

    await waitFor(
      async () =>
        globalDialogRegistry.getLastDriveTrigger(root.id.rootId)?.action === 'active_run_cleared',
      3_000,
      'clearing the synthetic blocker to emit an active_run_cleared wake event',
    );

    await waitFor(
      async () => lastAssistantSaying(root) === rootFinalResponse,
      3_000,
      'backend loop to retry the queued root revive after the active-run blocker clears',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latest?.needsDrive,
      false,
      'queued root revive should be fully consumed after backend-loop retry',
    );
  });

  console.log('kernel-driver subdialog-backend-loop-retries-after-active-run-blocker: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver subdialog-backend-loop-retries-after-active-run-blocker: FAIL\n${message}`,
  );
  process.exit(1);
});
