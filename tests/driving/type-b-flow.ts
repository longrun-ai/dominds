#!/usr/bin/env tsx
/**
 * Type B Subdialog Registry Flow Tests
 *
 * Validates RootDialog's Type B registry behavior (register/lookup/unregister).
 */

import { Dialog, DialogID, RootDialog, SubDialog } from 'dominds/dialog';
import { generateDialogID } from 'dominds/utils/id';

class MockDialogStore implements Dialog['dlgStore'] {
  async createSubDialog(
    supdialog: RootDialog,
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options?: { originRole: 'user' | 'assistant'; originMemberId?: string; topicId?: string },
  ): Promise<SubDialog> {
    const generatedId = generateDialogID();
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);
    return new SubDialog(
      this,
      supdialog,
      supdialog.taskDocPath,
      subdialogId,
      targetAgentId,
      options?.topicId,
      {
        headLine,
        callBody,
        originRole: options?.originRole ?? 'assistant',
        originMemberId: options?.originMemberId,
      },
    );
  }

  async notifyGeneratingStart(_dialog: Dialog): Promise<void> {}
  async notifyGeneratingFinish(_dialog: Dialog): Promise<void> {}
  async loadCurrentRound(_dialogId: DialogID): Promise<number> {
    return 1;
  }
  async getNextSeq(_dialogId: DialogID, _round: number): Promise<number> {
    return 1;
  }
  async persistReminders(_dialog: Dialog, _reminders: unknown[]): Promise<void> {}
  async persistUserMessage(_dialog: Dialog, _content: string, _msgId: string): Promise<void> {}
  async persistAgentMessage(
    _dialog: Dialog,
    _content: string,
    _genseq: number,
    _type: 'thinking_msg' | 'saying_msg',
  ): Promise<void> {}
  async persistFunctionCall(
    _dialog: Dialog,
    _id: string,
    _name: string,
    _args: unknown,
    _genseq: number,
  ): Promise<void> {}
  async startNewRound(_dialog: Dialog): Promise<void> {}
  async streamError(_dialog: Dialog, _error: string): Promise<void> {}
  async receiveFuncResult(_dialog: Dialog, _result: unknown): Promise<void> {}
  async receiveTextingResponse(
    _dialog: Dialog,
    _responderId: string,
    _headLine: string,
    _result: string,
    _status: 'completed' | 'failed',
  ): Promise<void> {}
  async updateQuestions4Human(_dialog: Dialog, _questions: unknown[]): Promise<void> {}
  async codeBlockStart(_dialog: Dialog, _infoLine?: string): Promise<void> {}
  async codeBlockChunk(_dialog: Dialog, _chunk: string): Promise<void> {}
  async codeBlockFinish(_dialog: Dialog, _endQuote?: string): Promise<void> {}
  async callingStart(_dialog: Dialog, _firstMention: string): Promise<void> {}
  async callingHeadlineChunk(_dialog: Dialog, _chunk: string): Promise<void> {}
  async callingHeadlineFinish(_dialog: Dialog): Promise<void> {}
  async callingBodyStart(_dialog: Dialog, _infoLine?: string): Promise<void> {}
  async callingBodyChunk(_dialog: Dialog, _chunk: string): Promise<void> {}
  async callingBodyFinish(_dialog: Dialog, _endQuote?: string): Promise<void> {}
  async callingFinish(_dialog: Dialog): Promise<void> {}
  async funcCallRequested(
    _dialog: Dialog,
    _funcId: string,
    _funcName: string,
    _argsStr: string,
  ): Promise<void> {}
  async persistPendingSubdialogSummaries(_dialog: Dialog, _summaries: unknown[]): Promise<void> {}
  async loadPendingSubdialogSummaries(_dialog: Dialog): Promise<unknown[]> {
    return [];
  }
  async clearPendingSubdialogSummaries(_dialog: Dialog): Promise<void> {}
}

function runTest(name: string, testFn: () => void): void {
  console.log(`\n=== Testing: ${name} ===`);
  try {
    testFn();
    console.log('✅ PASS');
  } catch (error: unknown) {
    console.log(`❌ FAIL: ${(error as Error).message}`);
    process.exit(1);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(condition: boolean, message?: string): void {
  if (!condition) {
    throw new Error(message || 'Assertion failed: expected truthy value');
  }
}

console.log('🧪 Type B Subdialog Registry Flow Tests');
console.log('========================================');

runTest('RootDialog.makeSubdialogKey', () => {
  const key = RootDialog.makeSubdialogKey('cmdr', 'code-review');
  assertEqual(key, 'cmdr!code-review', 'Key should be agentId!topicId format');
});

runTest('register/lookup/unregister', () => {
  const store = new MockDialogStore();
  const rootId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(store, 'task.md', rootId, 'lead');

  const subdialog = new SubDialog(
    store,
    rootDialog,
    rootDialog.taskDocPath,
    new DialogID(generateDialogID(), rootDialog.id.rootId),
    'cmdr',
    'topic-1',
    {
      headLine: 'Test',
      callBody: 'Body',
      originRole: 'assistant',
    },
  );

  rootDialog.registerSubdialog(subdialog);

  const lookup = rootDialog.lookupSubdialog('cmdr', 'topic-1');
  assertTrue(lookup !== undefined, 'Lookup should return the registered subdialog');
  assertEqual(
    lookup?.id.selfId,
    subdialog.id.selfId,
    'Lookup should match the registered subdialog',
  );

  const all = rootDialog.getRegisteredSubdialogs();
  assertEqual(all.length, 1, 'Registry should contain one subdialog');

  const removed = rootDialog.unregisterSubdialog('cmdr', 'topic-1');
  assertTrue(removed, 'unregisterSubdialog should return true for existing entry');
  assertEqual(
    rootDialog.getRegisteredSubdialogs().length,
    0,
    'Registry should be empty after removal',
  );
});

console.log('\n🎉 All Type B registry tests passed!');
