import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import type { ActiveCalleeDispatchRecord } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { setDialogDisplayState } from '../../main/dialog-display-state';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    const activeReplyObligation = {
      expectedReplyCallName: 'replyTellask' as const,
      targetDialogId: dlg.id.selfId,
      targetCallId: 'idle-with-active-reply-call',
      tellaskContent: 'Please complete the reply after this local work finishes.',
    };
    await DialogPersistence.setActiveTellaskReplyObligation(dlg.id, activeReplyObligation);

    const userPrompt = 'Do one local check and keep going.';
    await writeMockDb(tmpRoot, [
      {
        message: userPrompt,
        role: 'user',
        response: 'Continuing the local check without resolving the reply yet.',
        contextContains: ['[Dominds active reply tool]', userPrompt],
      },
    ]);

    await driveDialogStream(
      dlg,
      makeUserPrompt(userPrompt, 'idle-with-active-reply-obligation'),
      true,
    );

    const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
    assert.ok(latest, 'expected latest dialog state to exist');
    assert.deepEqual(latest.displayState, {
      kind: 'stopped',
      reason: { kind: 'pending_reply_obligation' },
      continueEnabled: true,
    });

    const persistedObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
      dlg.id,
      dlg.status,
    );
    assert.ok(persistedObligation, 'expected active reply obligation to remain active');
    assert.equal(
      persistedObligation.targetCallId,
      activeReplyObligation.targetCallId,
      'expected the same active reply obligation to remain active',
    );

    const debugDir = path.join(tmpRoot, '.dislogs', 'debug');
    const files = await fs.readdir(debugDir).catch((err: unknown) => {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'ENOENT'
      ) {
        return [];
      }
      throw err;
    });
    const debugFiles = files.filter((file) =>
      file.startsWith('kernel-driver-idle-with-active-reply-obligation-'),
    );
    assert.equal(debugFiles.length, 0, 'fixed path should not need an idle-with-active-reply dump');

    await setDialogDisplayState(dlg.id, { kind: 'idle_waiting_user' }, dlg.status);
    const latestAfterDirectIdleSet = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
    assert.deepEqual(
      latestAfterDirectIdleSet?.displayState,
      {
        kind: 'stopped',
        reason: { kind: 'pending_reply_obligation' },
        continueEnabled: true,
      },
      'direct idle displayState writes must be redirected while reply obligation remains active',
    );

    const sideDialog = await dlg.createSideDialog(
      'helper',
      ['@helper'],
      'Please answer after the nested work returns.',
      {
        callName: 'tellaskSessionless',
        originMemberId: dlg.agentId,
        askerDialogId: dlg.id.selfId,
        callId: 'root-to-helper-call',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['helper'],
      },
    );
    const nestedCallee: ActiveCalleeDispatchRecord = {
      calleeDialogId: 'bb/cc/nested-waiting-side-dialog',
      createdAt: formatUnifiedTimestamp(new Date()),
      batchId: 'nested-waiting-side-dialog-batch',
      callName: 'tellaskSessionless',
      mentionList: ['@reviewer'],
      tellaskContent: 'Finish the nested side dialog.',
      targetAgentId: 'reviewer',
      callId: 'nested-waiting-side-dialog-call',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'C',
    };
    await DialogPersistence.appendActiveCalleeDispatch(sideDialog.id, nestedCallee);

    await setDialogDisplayState(sideDialog.id, { kind: 'idle_waiting_user' }, sideDialog.status);
    const latestWaitingSideDialog = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.deepEqual(
      latestWaitingSideDialog?.displayState,
      { kind: 'waiting_side_dialog' },
      'waiting for a side dialog must take precedence over pending reply obligation in run-control projection',
    );
    assert.equal(
      latestWaitingSideDialog?.executionMarker,
      undefined,
      'blocked waiting-side-dialog projection must not keep a stale resumable interruption marker',
    );
  });

  console.log('kernel-driver idle-with-active-reply-obligation-display-state: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver idle-with-active-reply-obligation-display-state: FAIL\n${message}`);
  process.exit(1);
});
