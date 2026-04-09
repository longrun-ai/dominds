import assert from 'node:assert/strict';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeTellaskCalls } from '../../main/llm/kernel-driver/tellask-special';
import { formatAssignmentFromSupdialog } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';
import {
  createRootDialog,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function readNextEventWithTimeout(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent | null> {
  const timer = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  const ev = await Promise.race([ch.read(), timer]);
  if (ev === null || ev === EndOfStream) {
    return null;
  }
  return ev;
}

async function collectEvents(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent[]> {
  const events: TypedDialogEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ev = await readNextEventWithTimeout(ch, 30);
    if (!ev) continue;
    events.push(ev);
  }
  return events;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });
    await writeMockDb(tmpRoot, [
      {
        message: 'Please finalize the upstream reply now.',
        role: 'user',
        response: 'Closing the sideline with the requested reply tool.',
        funcCalls: [
          {
            name: 'replyTellask',
            arguments: {
              replyContent:
                'Acknowledged. I overstepped earlier; no extra action should have been taken.',
            },
          },
        ],
      },
      {
        message: 'Reply delivered via `replyTellask`:',
        role: 'tool',
        response: 'Local follow-up complete.',
      },
    ]);

    const root = await createRootDialog('tester');
    const tellaskContent = 'Please review the current implementation.';
    const callId = 'pending-tellask-call';
    const sessionSlug = 'reply-guidance';
    const subdialog = await root.createSubDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      callerDialogId: root.id.selfId,
      callId,
      sessionSlug,
      collectiveTargets: ['pangu'],
    });

    const directive: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellask',
      targetCallId: callId,
      tellaskContent,
    };
    await subdialog.persistUserMessage(
      formatAssignmentFromSupdialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent,
        language: getWorkLanguage(),
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      'assignment-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      directive,
    );

    const wrongReply = await executeTellaskCalls({
      dlg: subdialog,
      calls: [
        {
          callId: 'wrong-reply-call',
          callName: 'replyTellaskBack',
          replyContent: 'Done.',
        },
      ],
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });
    assert.deepEqual(
      wrongReply.successfulReplyCallIds,
      [],
      'wrong reply tool must not count as delivered',
    );
    assert.equal(wrongReply.toolOutputs.length, 1, 'expected one tool result for wrong reply tool');
    assert.equal(wrongReply.toolOutputs[0]?.type, 'func_result_msg');
    assert.match(
      wrongReply.toolOutputs[0]?.content ?? '',
      /exact reply tool for the current state is `replyTellask`, not `replyTellaskBack`/u,
    );

    await subdialog.appendTellaskReplyResolution({
      callId: 'resolved-reply-call',
      replyCallName: 'replyTellask',
      targetCallId: callId,
    });

    const staleReply = await executeTellaskCalls({
      dlg: subdialog,
      calls: [
        {
          callId: 'stale-reply-call',
          callName: 'replyTellask',
          replyContent: 'Done again.',
        },
      ],
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });
    assert.deepEqual(
      staleReply.successfulReplyCallIds,
      [],
      'resolved reply obligation must not accept another reply delivery',
    );
    assert.equal(staleReply.toolOutputs.length, 1, 'expected one tool result for stale reply call');
    assert.equal(staleReply.toolOutputs[0]?.type, 'func_result_msg');
    assert.match(
      staleReply.toolOutputs[0]?.content ?? '',
      /there is no active inter-dialog reply obligation right now/u,
    );

    const liveDirective: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellask',
      targetCallId: 'live-reply-call',
      tellaskContent: 'Please acknowledge the correction and stop.',
    };
    const liveSubdialog = await root.createSubDialog(
      'pangu',
      ['@pangu'],
      liveDirective.tellaskContent,
      {
        callName: 'tellask',
        originMemberId: 'tester',
        callerDialogId: root.id.selfId,
        callId: liveDirective.targetCallId,
        sessionSlug: 'live-reply-guidance',
        collectiveTargets: ['pangu'],
      },
    );
    await liveSubdialog.persistUserMessage(
      formatAssignmentFromSupdialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: liveDirective.tellaskContent,
        language: getWorkLanguage(),
        sessionSlug: 'live-reply-guidance',
        collectiveTargets: ['pangu'],
      }),
      'live-assignment-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      liveDirective,
    );

    const subdialogEvents = dialogEventRegistry.createSubChan(liveSubdialog.id);
    await driveDialogStream(
      liveSubdialog,
      makeUserPrompt('Please finalize the upstream reply now.', 'live-reply-user-msg'),
      true,
    );
    await waitForAllDialogsUnlocked(root, 2000);
    const liveEvents = await collectEvents(subdialogEvents, 800);

    const funcCallEvt = liveEvents.find(
      (ev): ev is Extract<TypedDialogEvent, { type: 'func_call_requested_evt' }> =>
        ev.type === 'func_call_requested_evt' && ev.funcName === 'replyTellask',
    );
    assert.ok(
      funcCallEvt,
      'expected live subdialog to emit func_call_requested_evt for replyTellask',
    );

    const funcResultEvt = liveEvents.find(
      (ev): ev is Extract<TypedDialogEvent, { type: 'func_result_evt' }> =>
        ev.type === 'func_result_evt' && ev.name === 'replyTellask',
    );
    assert.ok(funcResultEvt, 'expected live subdialog to emit func_result_evt for replyTellask');
    assert.match(funcResultEvt?.content ?? '', /replyTellask/u);
  });

  console.log('kernel-driver reply-tool-dynamic-guidance: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver reply-tool-dynamic-guidance: FAIL\n${message}`);
  process.exit(1);
});
