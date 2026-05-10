import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import { maybePrepareDiligenceAutoContinuePrompt } from '../../main/llm/kernel-driver/runtime';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';

import { createMainDialog, withTempRtws, writeStandardMinds } from './helpers';

type DialogPersistencePrivate = typeof DialogPersistence & {
  getLatestWriteBackKey(dialogId: { selfId: string; rootId: string }, status: 'running'): string;
  flushLatestWriteBack(key: string): Promise<void>;
};

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('zh');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = false;

    const sideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      'Check the side-dialog Diligence Push state.',
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: 'side-diligence-call',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        sessionSlug: 'side-diligence-session',
        collectiveTargets: ['pangu'],
      },
    );

    const sideDefault = await DialogPersistence.loadDialogLatest(sideDialog.id, 'running');
    assert.ok(sideDefault, 'sideDialog latest.yaml should exist');
    assert.equal(
      sideDefault.disableDiligencePush,
      false,
      'sideDialog Diligence Push must default to enabled',
    );

    await DialogPersistence.mutateDialogLatest(
      sideDialog.id,
      () => ({
        kind: 'patch',
        patch: { disableDiligencePush: true },
      }),
      'running',
    );

    const rootLatest = await DialogPersistence.loadDialogLatest(root.id, 'running');
    const sideLatest = await DialogPersistence.loadDialogLatest(sideDialog.id, 'running');
    assert.ok(rootLatest, 'root latest.yaml should exist');
    assert.ok(sideLatest, 'sideDialog latest.yaml should exist after patch');
    assert.equal(
      rootLatest.disableDiligencePush,
      false,
      'sideDialog Diligence Push patch must not mutate the root dialog',
    );
    assert.equal(
      sideLatest.disableDiligencePush,
      true,
      'sideDialog Diligence Push patch must persist on the sideDialog itself',
    );

    const persistenceInternals = DialogPersistence as DialogPersistencePrivate;
    const latestKey = persistenceInternals.getLatestWriteBackKey(sideDialog.id, 'running');
    await persistenceInternals.flushLatestWriteBack(latestKey);
    const sideLatestPath = path.join(
      tmpRoot,
      '.dialogs',
      'run',
      root.id.selfId,
      'sideDialogs',
      sideDialog.id.selfId,
      'latest.yaml',
    );
    const latestContent = await fs.readFile(sideLatestPath, 'utf-8');
    assert.match(latestContent, /disableDiligencePush:\s*true/);

    globalDialogRegistry.unregister(root.id.rootId);
    const restoredRoot = await getOrRestoreMainDialog(root.id.rootId, 'running');
    assert.ok(restoredRoot, 'main dialog should restore through ensureDialogLoaded');
    const restoredSideDialog = await ensureDialogLoaded(restoredRoot, sideDialog.id, 'running');
    assert.ok(restoredSideDialog, 'sideDialog should restore through ensureDialogLoaded');
    assert.equal(
      restoredSideDialog.disableDiligencePush,
      true,
      'restored sideDialog must read its own persisted Diligence Push state',
    );
    assert.equal(
      root.disableDiligencePush,
      false,
      'restoring a sideDialog must not overwrite the root Diligence Push state',
    );

    restoredSideDialog.disableDiligencePush = false;
    await DialogPersistence.setActiveTellaskReplyObligation(
      restoredSideDialog.id,
      undefined,
      restoredSideDialog.status,
    );
    const noActiveReplyPush = await maybePrepareDiligenceAutoContinuePrompt({
      dlg: restoredSideDialog,
      remainingBudget: 0,
      diligencePushMax: 0,
      ignoreBudgetExhaustion: true,
    });
    assert.equal(
      noActiveReplyPush.kind,
      'disabled',
      'sideDialog recovery push must give up when there is no active reply obligation',
    );

    const replyDirective = {
      expectedReplyCallName: 'replyTellask' as const,
      targetDialogId: root.id.selfId,
      targetCallId: 'side-diligence-call',
      tellaskContent: 'Check the side-dialog Diligence Push state.',
    };
    await DialogPersistence.setActiveTellaskReplyObligation(
      restoredSideDialog.id,
      replyDirective,
      restoredSideDialog.status,
    );
    const activeReplyPush = await maybePrepareDiligenceAutoContinuePrompt({
      dlg: restoredSideDialog,
      remainingBudget: 0,
      diligencePushMax: 0,
      ignoreBudgetExhaustion: true,
    });
    assert.equal(activeReplyPush.kind, 'prompt');
    if (activeReplyPush.kind !== 'prompt') {
      throw new Error(`Expected sideDialog recovery prompt, got ${activeReplyPush.kind}`);
    }
    assert.equal(activeReplyPush.prompt.origin, 'runtime');
    assert.deepEqual(activeReplyPush.prompt.tellaskReplyDirective, replyDirective);
    assert.match(activeReplyPush.prompt.content, /replyTellask\(\{ replyContent \}\)/);
    assert.match(activeReplyPush.prompt.content, /Check the side-dialog Diligence Push state\./);
    assert.doesNotMatch(activeReplyPush.prompt.content, /replyTellaskSessionless/);

    const wrongReplyDirective = {
      ...replyDirective,
      expectedReplyCallName: 'replyTellaskSessionless' as const,
    };
    await DialogPersistence.setActiveTellaskReplyObligation(
      restoredSideDialog.id,
      wrongReplyDirective,
      restoredSideDialog.status,
    );
    await assert.rejects(
      maybePrepareDiligenceAutoContinuePrompt({
        dlg: restoredSideDialog,
        remainingBudget: 0,
        diligencePushMax: 0,
        ignoreBudgetExhaustion: true,
      }),
      /active reply obligation does not match current assignment/,
    );

    const askBackDirective = {
      expectedReplyCallName: 'replyTellaskBack' as const,
      targetDialogId: 'ask-back-target',
      targetCallId: 'ask-back-call',
      tellaskContent: 'Answer the ask-back clarification.',
    };
    await DialogPersistence.setActiveTellaskReplyObligation(
      restoredSideDialog.id,
      askBackDirective,
      restoredSideDialog.status,
    );
    const askBackPush = await maybePrepareDiligenceAutoContinuePrompt({
      dlg: restoredSideDialog,
      remainingBudget: 0,
      diligencePushMax: 0,
      ignoreBudgetExhaustion: true,
    });
    assert.equal(askBackPush.kind, 'prompt');
    if (askBackPush.kind !== 'prompt') {
      throw new Error(`Expected ask-back recovery prompt, got ${askBackPush.kind}`);
    }
    assert.equal(askBackPush.prompt.origin, 'runtime');
    assert.deepEqual(askBackPush.prompt.tellaskReplyDirective, askBackDirective);
    assert.equal(askBackPush.prompt.sideDialogReplyTarget, undefined);
    assert.match(askBackPush.prompt.content, /replyTellaskBack\(\{ replyContent \}\)/);
    assert.match(askBackPush.prompt.content, /Answer the ask-back clarification\./);
  });

  console.log('kernel-driver sideDialog-diligence-push-state: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver sideDialog-diligence-push-state: FAIL\n${message}`);
  process.exit(1);
});
