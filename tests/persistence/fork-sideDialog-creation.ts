import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  DialogLatestFile,
  MainDialogMetadataFile,
  SideDialogMetadataFile,
} from '@longrun-ai/kernel/types/storage';
import { toRootGenerationAnchor } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID } from '../../main/dialog';
import { forkMainDialogTreeAtGeneration } from '../../main/dialog-fork';
import { DialogPersistence } from '../../main/persistence';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-fork-sideDialog-creation-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function writeLatest(dialogId: DialogID, currentCourse: number): Promise<void> {
  const latest: DialogLatestFile = {
    currentCourse,
    lastModified: formatUnifiedTimestamp(new Date()),
    status: 'active',
    displayState: { kind: 'idle_waiting_user' },
  };
  await DialogPersistence.mutateDialogLatest(dialogId, () => ({ kind: 'replace', next: latest }));
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const rootId = new DialogID('44/55/forkroot');
    const subId = new DialogID('44/55/forksub', rootId.rootId);
    const createdAt = formatUnifiedTimestamp(new Date('2026-04-11T00:00:00.000Z'));

    const rootMeta: MainDialogMetadataFile = {
      id: rootId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/fork.tsk',
      createdAt,
    };
    await DialogPersistence.saveMainDialogMetadata(rootId, rootMeta, 'running');
    await writeLatest(rootId, 1);

    const subMeta: SideDialogMetadataFile = {
      id: subId.selfId,
      agentId: 'scribe',
      taskDocPath: 'plans/fork.tsk',
      createdAt,
      askerDialogId: rootId.selfId,
      assignmentFromAsker: {
        callName: 'tellaskSessionless',
        mentionList: ['@scribe'],
        tellaskContent: 'Investigate this branch.',
        originMemberId: 'tester',
        askerDialogId: rootId.selfId,
        callId: 'call-sub-1',
      },
    };
    await DialogPersistence.ensureSideDialogDirectory(subId, 'running');
    await DialogPersistence.saveSideDialogMetadata(subId, subMeta, 'running');
    await writeLatest(subId, 1);

    await DialogPersistence.appendEvent(rootId, 1, {
      ts: createdAt,
      type: 'gen_start_record',
      genseq: 1,
    });
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: createdAt,
      type: 'sideDialog_created_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
      sideDialogId: subId.selfId,
      askerDialogId: rootId.selfId,
      agentId: 'scribe',
      taskDocPath: 'plans/fork.tsk',
      createdAt,
      assignmentFromAsker: subMeta.assignmentFromAsker,
    });
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: createdAt,
      type: 'gen_finish_record',
      genseq: 1,
    });
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: formatUnifiedTimestamp(new Date('2026-04-11T00:01:00.000Z')),
      type: 'gen_start_record',
      genseq: 2,
    });

    const forked = await forkMainDialogTreeAtGeneration({
      sourceRootId: rootId.selfId,
      sourceStatus: 'running',
      course: 1,
      genseq: 2,
    });
    const forkedRootId = new DialogID(forked.rootId);
    const forkedSubId = new DialogID(subId.selfId, forkedRootId.selfId);
    const forkedSubMeta = await DialogPersistence.loadDialogMetadata(forkedSubId, 'running');

    assert.ok(forkedSubMeta, 'forked sideDialog metadata must exist');
    assert.equal(forkedSubMeta.id, subId.selfId);
    assert.equal(forkedSubMeta.askerDialogId, forkedRootId.selfId);
    const forkedAskerStackState = await DialogPersistence.loadSideDialogAskerStackState(
      forkedSubId,
      'running',
    );
    assert.ok(forkedAskerStackState, 'forked sideDialog asker stack must exist');
    const forkedAskerStackStateTop =
      forkedAskerStackState.askerStack[forkedAskerStackState.askerStack.length - 1];
    assert.ok(
      forkedAskerStackStateTop,
      'forked sideDialog askerDialog stack must have a top frame',
    );
    assert.equal(forkedAskerStackStateTop.askerDialogId, forkedRootId.selfId);
    assert.equal(forkedAskerStackStateTop.assignmentFromAsker?.askerDialogId, forkedRootId.selfId);
    assert.equal(
      forkedAskerStackStateTop.tellaskReplyObligation?.targetDialogId,
      forkedRootId.selfId,
    );

    await new Promise((resolve) => setTimeout(resolve, 700));
  });
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
