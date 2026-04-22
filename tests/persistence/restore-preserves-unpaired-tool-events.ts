import assert from 'node:assert/strict';

import type { FuncCallRecord, FuncResultRecord } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

import { buildOpenAiRequestInputWrapper } from '../../main/llm/gen/openai';
import {
  findFirstToolCallAdjacencyViolation,
  sanitizeToolContextForProvider,
} from '../../main/llm/gen/tool-call-context';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    const dlg = await createMainDialog('tester');

    const call: FuncCallRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'func_call_record',
      genseq: 1,
      id: 'call-crash',
      name: 'shell_cmd',
      rawArgumentsText: '{"command":"echo crash"}',
    };
    await DialogPersistence.appendEvent(dlg.id, 1, call, 'running');

    const restored = await DialogPersistence.restoreDialog(dlg.id, 'running');
    assert(restored, 'expected restoreDialog to return state');

    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, 'running');
    const repairedResult = events.find(
      (event) => event.type === 'func_result_record' && event.id === 'call-crash',
    );
    assert.equal(
      repairedResult,
      undefined,
      'expected restore to stop appending repaired func_result_record for unresolved calls',
    );

    const restoredCallMsg = restored.messages.find(
      (msg) => msg.type === 'func_call_msg' && msg.id === 'call-crash',
    );
    assert(restoredCallMsg, 'expected restored dialog state to preserve unresolved func_call_msg');
    const restoredResultMsg = restored.messages.find(
      (msg) => msg.type === 'func_result_msg' && msg.id === 'call-crash',
    );
    assert.equal(
      restoredResultMsg,
      undefined,
      'expected restored dialog state to avoid synthesizing func_result_msg for unresolved calls',
    );
    const sanitizedUnresolved = sanitizeToolContextForProvider(restored.messages);
    assert.equal(
      sanitizedUnresolved.droppedViolations.length,
      1,
      'expected provider sanitization to drop one unresolved tool call',
    );
    assert.equal(
      sanitizedUnresolved.droppedViolations[0]?.kind,
      'unresolved_call',
      'expected unresolved tool call violation to be reported',
    );
    assert.equal(
      findFirstToolCallAdjacencyViolation(sanitizedUnresolved.messages),
      null,
      'expected sanitized unresolved-call context to be provider-safe',
    );
    await buildOpenAiRequestInputWrapper(sanitizedUnresolved.messages);

    await dlg.persistTellaskCall(
      'call-new-special',
      'tellaskSessionless',
      '{"targetAgentId":"mentor","tellaskContent":"Use the dedicated tellask special record."}',
      3,
    );

    const eventsAfterNewSpecialWrite = await DialogPersistence.loadCourseEvents(
      dlg.id,
      1,
      'running',
    );
    const newSpecialRecord = eventsAfterNewSpecialWrite.find(
      (event) => event.type === 'tellask_call_record' && event.id === 'call-new-special',
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
      'expected direct tellask call persistence to avoid implicit func_result synthesis',
    );

    const orphanedDlg = await createMainDialog('tester');
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
    assert(
      restoredWithOrphanedResult,
      'expected restoreDialog to keep orphaned func_result without repairing it',
    );

    const orphanedCallIndex = restoredWithOrphanedResult.messages.findIndex(
      (msg) => msg.type === 'func_call_msg' && msg.id === 'call-orphaned',
    );
    const orphanedResultIndex = restoredWithOrphanedResult.messages.findIndex(
      (msg) => msg.type === 'func_result_msg' && msg.id === 'call-orphaned',
    );
    assert.equal(
      orphanedCallIndex,
      -1,
      'expected restoreDialog to stop synthesizing missing func_call_msg for orphaned result',
    );
    assert.notEqual(
      orphanedResultIndex,
      -1,
      'expected restored dialog state to retain orphaned func_result_msg',
    );
    const sanitizedOrphaned = sanitizeToolContextForProvider(restoredWithOrphanedResult.messages);
    assert.equal(
      sanitizedOrphaned.droppedViolations.length,
      1,
      'expected provider sanitization to drop one orphaned tool result',
    );
    assert.equal(
      sanitizedOrphaned.droppedViolations[0]?.kind,
      'orphaned_result',
      'expected orphaned tool result violation to be reported',
    );
    assert.equal(
      findFirstToolCallAdjacencyViolation(sanitizedOrphaned.messages),
      null,
      'expected sanitized orphaned-result context to be provider-safe',
    );
    await buildOpenAiRequestInputWrapper(sanitizedOrphaned.messages);

    const replySpecialDlg = await createMainDialog('tester');
    await replySpecialDlg.persistTellaskCall(
      'reply-special-call',
      'replyTellaskBack',
      '{"replyContent":"Final answer delivered."}',
      1,
    );
    await replySpecialDlg.receiveFuncResult({
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'reply-special-call',
      name: 'replyTellaskBack',
      content: 'Reply delivered via `replyTellaskBack`: Final answer delivered.',
    });

    const restoredReplySpecial = await DialogPersistence.restoreDialog(
      replySpecialDlg.id,
      'running',
    );
    assert(restoredReplySpecial, 'expected restoreDialog to preserve tellask special results');
    assert.equal(
      restoredReplySpecial.messages.filter(
        (msg) => msg.type === 'func_call_msg' && msg.id === 'reply-special-call',
      ).length,
      1,
      'expected tellask special result restore to avoid synthesizing a duplicate func_call_msg',
    );
    assert.equal(
      restoredReplySpecial.messages.filter(
        (msg) => msg.type === 'func_result_msg' && msg.id === 'reply-special-call',
      ).length,
      1,
      'expected tellask special result restore to replay exactly one func_result_msg',
    );

    const malformedTellaskDlg = await createMainDialog('tester');
    await malformedTellaskDlg.persistTellaskCall(
      'malformed-reply-call',
      'replyTellaskBack',
      '{"replyContent":',
      1,
      { deliveryMode: 'func_call_requested' },
    );
    await malformedTellaskDlg.receiveFuncResult({
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'malformed-reply-call',
      name: 'replyTellaskBack',
      content:
        "Invalid arguments for tellask special function 'replyTellaskBack': arguments must be valid JSON: Unexpected end of JSON input",
    });

    const malformedEvents = await DialogPersistence.loadCourseEvents(
      malformedTellaskDlg.id,
      1,
      'running',
    );
    const malformedCall = malformedEvents.find(
      (event) => event.type === 'tellask_call_record' && event.id === 'malformed-reply-call',
    );
    assert(malformedCall, 'expected malformed tellask call to persist tellask_call_record');
    assert.equal(
      malformedCall.type,
      'tellask_call_record',
      'expected malformed tellask call to stay in tellask persistence family',
    );
    assert.equal(malformedCall.rawArgumentsText, '{"replyContent":');
    assert.equal(malformedCall.deliveryMode, 'func_call_requested');
    assert.equal(
      malformedEvents.some(
        (event) => event.type === 'func_call_record' && event.id === 'malformed-reply-call',
      ),
      false,
      'expected malformed tellask call to avoid falling back to func_call_record',
    );

    const restoredMalformedTellask = await DialogPersistence.restoreDialog(
      malformedTellaskDlg.id,
      'running',
    );
    assert(restoredMalformedTellask, 'expected restoreDialog to preserve malformed tellask pair');
    const restoredMalformedCall = restoredMalformedTellask.messages.find(
      (msg) => msg.type === 'func_call_msg' && msg.id === 'malformed-reply-call',
    );
    assert(restoredMalformedCall, 'expected restored malformed tellask func_call_msg');
    assert.equal(
      restoredMalformedCall.type,
      'func_call_msg',
      'expected malformed tellask call to replay into func_call_msg',
    );
    assert.equal(
      restoredMalformedCall.arguments,
      '{"replyContent":',
      'expected malformed tellask call to preserve original raw arguments in restored context',
    );
    const restoredMalformedResult = restoredMalformedTellask.messages.find(
      (msg) => msg.type === 'func_result_msg' && msg.id === 'malformed-reply-call',
    );
    assert(restoredMalformedResult, 'expected restored malformed tellask func_result_msg');
  });

  console.log('persistence restore-preserves-unpaired-tool-events: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`persistence restore-preserves-unpaired-tool-events: FAIL\n${message}`);
  process.exit(1);
});
