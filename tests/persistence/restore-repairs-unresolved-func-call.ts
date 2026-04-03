import assert from 'node:assert/strict';

import type { FuncCallRecord, FuncResultRecord } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

import { DialogPersistence } from '../../main/persistence';
import { createRootDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    const dlg = await createRootDialog('tester');

    const call: FuncCallRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'func_call_record',
      genseq: 1,
      id: 'call-crash',
      name: 'shell_cmd',
      arguments: { command: 'echo crash' },
    };
    await DialogPersistence.appendEvent(dlg.id, 1, call, 'running');

    const restored = await DialogPersistence.restoreDialog(dlg.id, 'running');
    assert(restored, 'expected restoreDialog to return state');

    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, 'running');
    const repairedResult = events.find(
      (event) => event.type === 'func_result_record' && event.id === 'call-crash',
    );
    assert(repairedResult, 'expected restore to append repaired func_result_record');
    assert.equal(repairedResult.type, 'func_result_record');
    assert.match(
      repairedResult.content,
      /进程意外退出|exited unexpectedly/,
      'expected repaired result to explain unexpected process exit',
    );

    const restoredResultMsg = restored.messages.find(
      (msg) => msg.type === 'func_result_msg' && msg.id === 'call-crash',
    );
    assert(restoredResultMsg, 'expected restored dialog state to include repaired func_result_msg');

    await dlg.persistTellaskSpecialCall(
      'call-new-special',
      'tellaskSessionless',
      {
        targetAgentId: 'mentor',
        tellaskContent: 'Use the dedicated tellask special record.',
      },
      3,
    );

    const eventsAfterNewSpecialWrite = await DialogPersistence.loadCourseEvents(
      dlg.id,
      1,
      'running',
    );
    const newSpecialRecord = eventsAfterNewSpecialWrite.find(
      (event) => event.type === 'tellask_special_call_record' && event.id === 'call-new-special',
    );
    assert(newSpecialRecord, 'expected tellask-special calls to persist dedicated special record');
    const legacySpecialFuncCall = eventsAfterNewSpecialWrite.find(
      (event) => event.type === 'func_call_record' && event.id === 'call-new-special',
    );
    assert.equal(
      legacySpecialFuncCall,
      undefined,
      'expected tellask-special calls to stop persisting func_call_record on new writes',
    );

    const restoredWithNewSpecialWrite = await DialogPersistence.restoreDialog(dlg.id, 'running');
    assert(
      restoredWithNewSpecialWrite,
      'expected restoreDialog to succeed after new special write',
    );
    const restoredNewSpecialCall = restoredWithNewSpecialWrite.messages.find(
      (msg) => msg.type === 'func_call_msg' && msg.id === 'call-new-special',
    );
    assert(
      restoredNewSpecialCall,
      'expected tellask-special start record to replay back into func_call_msg context',
    );
    const repairedNewSpecialResult = restoredWithNewSpecialWrite.messages.find(
      (msg) => msg.type === 'func_result_msg' && msg.id === 'call-new-special',
    );
    assert.equal(
      repairedNewSpecialResult,
      undefined,
      'expected tellask-special records to stay out of ordinary crash-repair func_result synthesis',
    );

    const orphanedDlg = await createRootDialog('tester');
    const orphanedResult: FuncResultRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'func_result_record',
      genseq: 1,
      id: 'call-orphaned',
      name: 'readonly_shell',
      content: 'Invalid arguments: Unexpected field: timeoutSeconds',
    };
    await DialogPersistence.appendEvent(orphanedDlg.id, 1, orphanedResult, 'running');

    const restoredWithOrphanedResult = await DialogPersistence.restoreDialog(
      orphanedDlg.id,
      'running',
    );
    assert(restoredWithOrphanedResult, 'expected restoreDialog to repair orphaned func_result');

    const orphanedCallIndex = restoredWithOrphanedResult.messages.findIndex(
      (msg) => msg.type === 'func_call_msg' && msg.id === 'call-orphaned',
    );
    const orphanedResultIndex = restoredWithOrphanedResult.messages.findIndex(
      (msg) => msg.type === 'func_result_msg' && msg.id === 'call-orphaned',
    );
    assert.notEqual(
      orphanedCallIndex,
      -1,
      'expected restoreDialog to synthesize missing func_call_msg for orphaned result',
    );
    assert.notEqual(
      orphanedResultIndex,
      -1,
      'expected restored dialog state to retain orphaned func_result_msg',
    );
    assert.equal(
      orphanedCallIndex + 1,
      orphanedResultIndex,
      'expected synthesized func_call_msg to be adjacent to repaired orphaned result',
    );
  });

  console.log('persistence restore-repairs-unresolved-func-call: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`persistence restore-repairs-unresolved-func-call: FAIL\n${message}`);
  process.exit(1);
});
