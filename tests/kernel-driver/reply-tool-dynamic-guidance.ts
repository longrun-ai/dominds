import assert from 'node:assert/strict';

import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import { executeTellaskSpecialCalls } from '../../main/llm/kernel-driver/tellask-special';
import { formatAssignmentFromSupdialog } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';
import { createRootDialog, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

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

    const wrongReply = await executeTellaskSpecialCalls({
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

    const staleReply = await executeTellaskSpecialCalls({
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
  });

  console.log('kernel-driver reply-tool-dynamic-guidance: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver reply-tool-dynamic-guidance: FAIL\n${message}`);
  process.exit(1);
});
