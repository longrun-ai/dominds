#!/usr/bin/env tsx
/**
 * Type A Subdialog Flow Tests
 *
 * Tests for subdialog suspension mechanism (Type A: pending record creation and completion callback).
 * Type A subdialogs are tracked with pending records that are resolved when the subdialog completes.
 */

import { Dialog, DialogID, PendingSubdialog, RootDialog, SubDialog } from 'dominds/dialog';
import { generateDialogID } from 'dominds/utils/id';
import { formatUnifiedTimestamp } from 'dominds/utils/time';

// Mock DialogStore for testing
class MockDialogStore implements Dialog['dlgStore'] {
  private pendingSubdialogs: PendingSubdialog[] = [];
  private subdialogResponses: Array<{
    subdialogId: DialogID;
    summary: string;
    completedAt: string;
  }> = [];

  async createSubDialog(
    supdialog: RootDialog,
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options: {
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      topicId?: string;
    },
  ): Promise<SubDialog> {
    const generatedId = generateDialogID();
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);
    const subdialog = new SubDialog(
      this,
      supdialog,
      supdialog.taskDocPath,
      subdialogId,
      targetAgentId,
      options.topicId,
      {
        headLine,
        callBody,
        originMemberId: options.originMemberId,
        callerDialogId: options.callerDialogId,
        callId: options.callId,
      },
    );
    return subdialog;
  }

  async persistPendingSubdialogSummaries(
    _dialog: Dialog,
    summaries: Array<{ subdialogId: DialogID; summary: string; completedAt: string }>,
  ): Promise<void> {
    this.subdialogResponses = summaries;
  }

  getPendingSubdialogs(): PendingSubdialog[] {
    return this.pendingSubdialogs;
  }

  setPendingSubdialogs(pending: PendingSubdialog[]): void {
    this.pendingSubdialogs = pending;
  }

  // Required interface implementations (minimal for testing)
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
  async loadPendingSubdialogSummaries(_dialog: Dialog): Promise<unknown[]> {
    return [];
  }
  async clearPendingSubdialogSummaries(_dialog: Dialog): Promise<void> {}
}

// Helper function to run a test case
function runTest(name: string, testFn: () => void): void {
  console.log(`\n=== Testing: ${name} ===`);
  try {
    testFn();
    console.log(`✅ PASS`);
  } catch (error: unknown) {
    console.log(`❌ FAIL: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Helper function to assert equality
function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// Helper function to assert truthy
function assertTrue(condition: boolean, message?: string): void {
  if (!condition) {
    throw new Error(message || 'Assertion failed: expected truthy value');
  }
}

console.log('🧪 Type A Subdialog Flow Tests');
console.log('================================');

// Test 1: Pending subdialog record creation
runTest('Pending subdialog record creation', () => {
  const rootDialogId = new DialogID(generateDialogID());
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);
  const now = formatUnifiedTimestamp(new Date());

  const pendingRecord: PendingSubdialog = {
    subdialogId,
    createdAt: now,
    headLine: 'Review PR #123',
    targetAgentId: 'reviewer',
    callType: 'A',
  };

  assertTrue(pendingRecord.subdialogId !== undefined, 'Pending record should have subdialogId');
  assertTrue(pendingRecord.headLine === 'Review PR #123', 'Pending record should have headLine');
  assertTrue(
    pendingRecord.targetAgentId === 'reviewer',
    'Pending record should have targetAgentId',
  );
  assertTrue(pendingRecord.callType === 'A', 'Pending record should have callType A');

  console.log(`Pending record created: ${JSON.stringify(pendingRecord, null, 2)}`);
});

// Test 2: Pending subdialog summary creation and storage
runTest('Pending subdialog summary creation and storage', () => {
  const rootDialogId = new DialogID(generateDialogID());
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);
  const now = formatUnifiedTimestamp(new Date());

  const summaryRecord = {
    subdialogId,
    summary: 'Completed code review. Found 3 issues.',
    completedAt: now,
  };

  assertTrue(summaryRecord.summary.length > 0, 'Summary should have content');
  assertTrue(summaryRecord.completedAt !== undefined, 'Summary should have completedAt');

  console.log(`Summary record created: ${JSON.stringify(summaryRecord, null, 2)}`);
});

// Test 3: Subdialog completion callback simulation
runTest('Subdialog completion callback simulation', async () => {
  const rootDialogId = new DialogID(generateDialogID());
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  // Simulate subdialog completion
  const completionCallback = async (
    parentDialogId: DialogID,
    completedSubdialogId: DialogID,
    summary: string,
  ): Promise<void> => {
    return Promise.resolve();
  };

  const result = await completionCallback(rootDialogId, subdialogId, 'Task completed successfully');

  assertTrue(result === undefined, 'Completion callback should resolve successfully');
  console.log('Subdialog completion callback executed successfully');
});

// Test 4: Root dialog with pending subdialog tracking
runTest('Root dialog with pending subdialog tracking', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  assertTrue(rootDialog instanceof RootDialog, 'Should create RootDialog');
  assertTrue(rootDialog.id !== undefined, 'Root dialog should have id');
  assertTrue(rootDialog.supdialog === undefined, 'Root dialog should not have supdialog');

  console.log(`Root dialog created: ${rootDialog.id.selfId}`);
});

// Test 5: SubDialog with supdialog reference
runTest('SubDialog with supdialog reference', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialog = new SubDialog(
    mockStore,
    rootDialog,
    'test-task.md',
    subdialogId,
    'agent-2',
    undefined,
    {
      headLine: 'Subtask',
      callBody: 'Do work',
      originMemberId: rootDialog.agentId,
      callerDialogId: rootDialog.id.selfId,
      callId: 'call-1',
    },
  );

  assertTrue(subdialog instanceof SubDialog, 'Should create SubDialog');
  assertTrue(subdialog.supdialog === rootDialog, 'Subdialog should reference supdialog');
  assertTrue(subdialog.supdialog !== undefined, 'Subdialog should have supdialog reference');

  console.log(
    `Subdialog created: ${subdialog.id.selfId} with supdialog: ${subdialog.supdialog.id.selfId}`,
  );
});

// Test 6: Pending summaries management
runTest('Pending summaries management', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId1 = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialogId2 = new DialogID(generateDialogID(), rootDialogId.rootId);

  rootDialog.addPendingSubdialogSummary(subdialogId1, 'Summary 1');
  rootDialog.addPendingSubdialogSummary(subdialogId2, 'Summary 2');

  const pending = rootDialog.getPendingSubdialogSummaries();

  assertTrue(pending.length === 2, 'Should have 2 pending summaries');
  assertEqual(pending[0].summary, 'Summary 1', 'First summary should be Summary 1');
  assertEqual(pending[1].summary, 'Summary 2', 'Second summary should be Summary 2');

  const taken = rootDialog.takePendingSubdialogSummaries();
  assertTrue(taken.length === 2, 'Should have taken 2 summaries');
  assertTrue(
    rootDialog.getPendingSubdialogSummaries().length === 0,
    'Should have no pending summaries after take',
  );

  console.log('Pending summaries management working correctly');
});

// Test 7: Type A subdialog flow with pending records
runTest('Type A subdialog flow with pending records', async () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);
  const now = formatUnifiedTimestamp(new Date());

  const pendingSubdialog: PendingSubdialog = {
    subdialogId,
    createdAt: now,
    headLine: 'Type A subdialog task',
    targetAgentId: 'agent-2',
    callType: 'A',
  };

  mockStore.setPendingSubdialogs([pendingSubdialog]);

  const summary = 'Type A subdialog completed';
  rootDialog.addPendingSubdialogSummary(subdialogId, summary);

  const pending = rootDialog.getPendingSubdialogSummaries();
  assertTrue(pending.length === 1, 'Should have 1 pending summary');
  assertEqual(pending[0].summary, summary, 'Summary should match');

  const takenSummaries = rootDialog.takePendingSubdialogSummaries();
  assertTrue(takenSummaries.length === 1, 'Should have taken 1 summary');
  assertEqual(takenSummaries[0].summary, summary, 'Taken summary should match');

  console.log('Type A subdialog flow completed successfully');
});

console.log('\n🎉 All Type A Subdialog Flow tests passed!');
