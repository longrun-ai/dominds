#!/usr/bin/env tsx
/**
 * Pending Subdialog Revival Flow Tests
 *
 * Validates pending subdialog tracking on Dialog and RootDialog.
 */

import { Dialog, DialogID, RootDialog } from 'dominds/dialog';
import { generateDialogID } from 'dominds/utils/id';

class MockDialogStore implements Dialog['dlgStore'] {
  async createSubDialog(
    _supdialog: RootDialog,
    _targetAgentId: string,
    _headLine: string,
    _callBody: string,
    _options: {
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      topicId?: string;
    },
  ): Promise<never> {
    throw new Error('Not implemented for this test');
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

console.log('🧪 Pending Subdialog Tracking Tests');
console.log('===================================');

runTest('add/remove/clear pending subdialogs', () => {
  const store = new MockDialogStore();
  const rootId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(store, 'task.md', rootId, 'lead');

  const sub1 = new DialogID(generateDialogID(), rootDialog.id.rootId);
  const sub2 = new DialogID(generateDialogID(), rootDialog.id.rootId);

  rootDialog.addPendingSubdialogs([sub1, sub2]);
  assertEqual(rootDialog.pendingSubdialogIds.length, 2, 'Should track two pending subdialogs');

  rootDialog.removePendingSubdialog(sub1);
  assertEqual(rootDialog.pendingSubdialogIds.length, 1, 'Should remove one pending subdialog');

  rootDialog.clearPendingSubdialogs();
  assertEqual(rootDialog.pendingSubdialogIds.length, 0, 'Pending list should be cleared');
});

console.log('\n🎉 Pending subdialog tracking tests passed!');
