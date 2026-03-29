import assert from 'node:assert/strict';

import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import { DialogPersistence } from '../../main/persistence';
import {
  recoverPendingReplyTellaskCallsAfterRestart,
  recoverPendingReplyTellaskCallsForDialog,
} from '../../main/recovery/reply-special';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { createRootDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot);

    const root = await createRootDialog('tester');
    const tellaskContent = 'Need a final upstream answer.';
    const targetCallId = 'tellask-back-target';

    const directive: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: root.id.selfId,
      targetCallId,
      tellaskContent,
    };
    await root.persistUserMessage(
      'Reply-tool recovery directive',
      'directive-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      directive,
    );

    await root.persistTellaskSpecialCall(
      'reply-call',
      'replyTellaskBack',
      { replyContent: 'Final answer delivered.' },
      1,
    );

    await recoverPendingReplyTellaskCallsAfterRestart();

    const rootEvents = await DialogPersistence.loadCourseEvents(root.id, 1, 'running');
    const replyFuncResult = rootEvents.find(
      (event) => event.type === 'func_result_record' && event.id === 'reply-call',
    );
    assert(replyFuncResult, 'expected restart recovery to append reply func_result_record');
    assert.match(
      replyFuncResult.content,
      /Reply delivered via `replyTellaskBack`|已通过 `replyTellaskBack` 送达回复/u,
    );

    const replyResolution = rootEvents.find(
      (event) => event.type === 'tellask_reply_resolution_record' && event.callId === 'reply-call',
    );
    assert(replyResolution, 'expected restart recovery to append tellask_reply_resolution_record');

    const deliveredResponse = rootEvents.find(
      (event) =>
        event.type === 'tellask_response_record' &&
        event.callId === targetCallId &&
        event.callName === 'tellaskBack',
    );
    assert(deliveredResponse, 'expected restart recovery to deliver reply to the caller dialog');

    const resolutionOnlyRoot = await createRootDialog('tester');
    const resolutionDirective: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: resolutionOnlyRoot.id.selfId,
      targetCallId: 'tellask-back-target',
      tellaskContent: 'Need a final upstream answer.',
    };
    await resolutionOnlyRoot.persistUserMessage(
      'Reply-tool recovery directive',
      'directive-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      resolutionDirective,
    );
    await resolutionOnlyRoot.persistTellaskSpecialCall(
      'reply-back-call',
      'replyTellaskBack',
      { replyContent: 'Final answer delivered.' },
      1,
    );
    await resolutionOnlyRoot.appendTellaskReplyResolution({
      callId: 'reply-back-call',
      replyCallName: 'replyTellaskBack',
      targetCallId: 'tellask-back-target',
    });

    await recoverPendingReplyTellaskCallsAfterRestart();

    const resolutionEvents = await DialogPersistence.loadCourseEvents(
      resolutionOnlyRoot.id,
      1,
      'running',
    );
    const synthesizedSuccessResult = resolutionEvents.find(
      (event) => event.type === 'func_result_record' && event.id === 'reply-back-call',
    );
    assert(
      synthesizedSuccessResult,
      'expected restart recovery to synthesize success func_result_record when resolution already exists',
    );

    const concurrentRoot = await createRootDialog('tester');
    const concurrentDirective: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: concurrentRoot.id.selfId,
      targetCallId: 'tellask-back-target-concurrent',
      tellaskContent: 'Need only one recovered reply.',
    };
    await concurrentRoot.persistUserMessage(
      'Concurrent reply-tool recovery directive',
      'directive-msg-concurrent',
      'markdown',
      'runtime',
      'en',
      undefined,
      concurrentDirective,
    );
    await concurrentRoot.persistTellaskSpecialCall(
      'reply-back-call-concurrent',
      'replyTellaskBack',
      { replyContent: 'Recovered exactly once.' },
      1,
    );

    await Promise.all([
      recoverPendingReplyTellaskCallsForDialog(concurrentRoot),
      recoverPendingReplyTellaskCallsForDialog(concurrentRoot),
    ]);

    const concurrentEvents = await DialogPersistence.loadCourseEvents(
      concurrentRoot.id,
      1,
      'running',
    );
    assert.equal(
      concurrentEvents.filter(
        (event) => event.type === 'func_result_record' && event.id === 'reply-back-call-concurrent',
      ).length,
      1,
      'expected concurrent recovery to append exactly one func_result_record',
    );
    assert.equal(
      concurrentEvents.filter(
        (event) =>
          event.type === 'tellask_reply_resolution_record' &&
          event.callId === 'reply-back-call-concurrent',
      ).length,
      1,
      'expected concurrent recovery to append exactly one tellask_reply_resolution_record',
    );
    assert.equal(
      concurrentEvents.filter(
        (event) =>
          event.type === 'tellask_response_record' &&
          event.callId === 'tellask-back-target-concurrent' &&
          event.callName === 'tellaskBack',
      ).length,
      1,
      'expected concurrent recovery to deliver exactly one tellask_response_record',
    );
  });

  console.log('recovery reply-special-after-restart: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`recovery reply-special-after-restart: FAIL\n${message}`);
  process.exit(1);
});
