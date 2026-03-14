import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import { formatAssignmentFromSupdialog } from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      memberToolsets: ['codex_style_tools'],
    });

    const trigger = 'Start one round that emits tellask and readonly_shell together.';
    const sessionSlug = 'mixed-tool-suspend';
    const tellaskBody = 'Please ask the human a blocker question before you finish.';
    const language = getWorkLanguage();

    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      callName: 'tellask',
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList: ['@pangu'],
      tellaskContent: tellaskBody,
      language,
      sessionSlug,
      collectiveTargets: ['pangu'],
    });

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'I will ask @pangu and run a readonly inspection first.',
        funcCalls: [
          {
            id: 'call-root-tellask',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: tellaskBody,
            },
          },
          {
            id: 'call-root-readonly',
            name: 'readonly_shell',
            arguments: {
              command: 'echo hello',
              timeout_ms: 2_000,
            },
          },
        ],
      },
      {
        message: expectedSubdialogPrompt,
        role: 'user',
        response: 'I need a human blocker before I can finish.',
        funcCalls: [
          {
            id: 'call-subdialog-q4h',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please answer this blocker later.',
            },
          },
        ],
      },
    ]);

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      {
        content: trigger,
        msgId: 'kernel-driver-subdialog-mixed-tool-round-honors-suspension',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
      { suppressDiligencePush: true },
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const rootEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const genStartCount = rootEvents.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount,
      1,
      'pending subdialogs must stop auto-continue even when the same round already executed a normal tool call',
    );
    assert.ok(
      rootEvents.some(
        (event) => event.type === 'func_call_record' && event.name === 'readonly_shell',
      ),
      'normal tool call should still execute in the original round before suspension',
    );
    assert.ok(
      rootEvents.some(
        (event) => event.type === 'func_result_record' && event.name === 'readonly_shell',
      ),
      'normal tool result should still persist before suspension',
    );

    const assistantSayings = root.msgs.filter(
      (
        msg,
      ): msg is Extract<(typeof root.msgs)[number], { type: 'saying_msg'; role: 'assistant' }> =>
        msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.equal(
      assistantSayings.length,
      1,
      'root dialog must not open a post-tool follow-up assistant round while subdialogs are pending',
    );

    const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
    assert.equal(
      pendingSubdialogs.length,
      1,
      'expected the tellask-created subdialog to remain pending after the round suspends',
    );
  });

  console.log('kernel-driver subdialog-mixed-tool-round-honors-suspension: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-mixed-tool-round-honors-suspension: FAIL\n${message}`);
  process.exit(1);
});
