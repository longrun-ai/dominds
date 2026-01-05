#!/usr/bin/env tsx
/**
 * Type C Transient Flow Tests
 *
 * Tests for transient/unregistered subdialog mechanism (Type C: no registry tracking).
 * Type C subdialogs are one-off calls without topicId, not tracked in registry.
 */

import { Dialog, DialogID, RootDialog, SubDialog } from 'dominds/dialog';
import { SubdialogMutex } from 'dominds/dialog-registry';
import { generateDialogID } from 'dominds/utils/id';

// Mock DialogStore for testing
class MockDialogStore implements Dialog['dlgStore'] {
  async createSubDialog(
    supdialog: RootDialog,
    targetAgentId: string,
    headLine: string,
    callBody: string,
  ): Promise<SubDialog> {
    const generatedId = generateDialogID();
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);
    const subdialog = new SubDialog(supdialog, supdialog.taskDocPath, subdialogId, targetAgentId, {
      headLine,
      callBody,
      originRole: 'assistant',
    });
    return subdialog;
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
  async persistPendingSubdialogSummaries(_dialog: Dialog, _summaries: unknown[]): Promise<void> {}
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

// Helper function to assert falsy
function assertFalse(condition: boolean, message?: string): void {
  if (condition) {
    throw new Error(message || 'Assertion failed: expected falsy value');
  }
}

console.log('🧪 Type C Transient Flow Tests');
console.log('================================');

// Test 1: Type C subdialog without topicId
runTest('Type C subdialog without topicId', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  // Type C: transient subdialog with only agentId (no topicId)
  // Not registered in registry - just created and completed
  const subdialog = new SubDialog(
    rootDialog,
    'test-task.md',
    subdialogId,
    'cmdr', // Only agentId, no topicId
    { headLine: 'Quick question', callBody: 'What time is it?' },
  );

  assertTrue(subdialog instanceof SubDialog, 'Should create SubDialog');
  assertTrue(subdialog.supdialog === rootDialog, 'Subdialog should reference supdialog');
  assertTrue(subdialog.topicId === undefined, 'Type C subdialog should not have topicId');

  console.log('Type C subdialog created without topicId');
});

// Test 2: Type C subdialog completion without registry entry
runTest('Type C subdialog completion without registry entry', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  // Initially registry should be empty
  assertEqual(rootDialog.subdialogMutex.size, 0, 'Registry should be empty initially');

  // Create Type C subdialog (no registration in registry)
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialog = new SubDialog(rootDialog, 'test-task.md', subdialogId, 'reviewer', {
    headLine: 'Review this file',
    callBody: 'Check line 42',
  });

  // Registry should still be empty (Type C doesn't register)
  assertEqual(rootDialog.subdialogMutex.size, 0, 'Registry should remain empty for Type C');

  // Simulate subdialog completion
  const summary = 'File reviewed, no issues found.';
  rootDialog.addPendingSubdialogSummary(subdialogId, summary);

  // Pending summaries should have the entry
  const pending = rootDialog.getPendingSubdialogSummaries();
  assertEqual(pending.length, 1, 'Should have 1 pending summary');
  assertEqual(pending[0].summary, summary, 'Summary should match');

  // Take summaries (simulating parent dialog resuming)
  const taken = rootDialog.takePendingSubdialogSummaries();
  assertEqual(taken.length, 1, 'Should have taken 1 summary');
  assertEqual(taken[0].summary, summary, 'Taken summary should match');

  // Registry should still be empty
  assertEqual(rootDialog.subdialogMutex.size, 0, 'Registry should still be empty');

  console.log('Type C completion without registry entry verified');
});

// Test 3: Type C vs Type B distinction
runTest('Type C vs Type B distinction', () => {
  const registry = new SubdialogMutex();
  const rootDialogId = new DialogID(generateDialogID());

  // Type C: @agentId only - not in registry
  const subdialogIdC = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialogC = new SubDialog(
    {} as RootDialog, // Minimal mock
    'test-task.md',
    subdialogIdC,
    'cmdr', // No topicId
  );
  assertTrue(subdialogC.topicId === undefined, 'Type C should have no topicId');

  // Type B: @agentId !topicId - registered in registry
  const subdialogIdB = new DialogID(generateDialogID(), rootDialogId.rootId);
  const entry = registry.lock('reviewer', 'pr-123', subdialogIdB);
  assertEqual(entry.locked, true, 'Type B should be locked');

  // Registry should have Type B but not Type C
  assertEqual(registry.size, 1, 'Registry should have 1 entry (Type B only)');

  // Type C lookup should not be in registry
  assertTrue(registry.lookup('cmdr', 'anything') === null, 'Type C should not be in registry');

  console.log('Type C vs Type B distinction verified');
});

// Test 4: Multiple Type C subdialogs
runTest('Multiple Type C subdialogs', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  // Create multiple Type C subdialogs
  const subdialogIds = [
    new DialogID(generateDialogID(), rootDialogId.rootId),
    new DialogID(generateDialogID(), rootDialogId.rootId),
    new DialogID(generateDialogID(), rootDialogId.rootId),
  ];

  let pendingCount = 0;

  // Each Type C subdialog completion adds to pending summaries
  for (const sdId of subdialogIds) {
    rootDialog.addPendingSubdialogSummary(sdId, `Summary for subdialog ${sdId.selfId.slice(0, 8)}`);
    pendingCount++;
  }

  const pending = rootDialog.getPendingSubdialogSummaries();
  assertEqual(pending.length, 3, 'Should have 3 pending summaries');

  // Registry should still be empty
  assertEqual(rootDialog.subdialogMutex.size, 0, 'Registry should remain empty');

  // Take all summaries
  const taken = rootDialog.takePendingSubdialogSummaries();
  assertEqual(taken.length, 3, 'Should have taken 3 summaries');

  // Verify no registry entries created
  assertEqual(rootDialog.subdialogMutex.size, 0, 'Registry should still be empty');

  console.log('Multiple Type C subdialogs handled correctly');
});

// Test 5: Type C subdialog with supdialog reference
runTest('Type C subdialog with supdialog reference', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialog = new SubDialog(rootDialog, 'test-task.md', subdialogId, 'analyst', {
    headLine: 'Analyze data',
    callBody: 'Process the dataset',
  });

  // Verify supdialog chain
  assertTrue(subdialog.supdialog === rootDialog, 'Subdialog should reference root dialog');
  assertTrue(subdialog.supdialog.supdialog === undefined, 'Root dialog should have no supdialog');

  // Verify dialog IDs
  assertEqual(subdialog.id.rootId, rootDialogId.rootId, 'Subdialog should share root ID');
  assertTrue(
    subdialog.id.selfId !== subdialog.id.rootId,
    'Subdialog selfId should differ from root',
  );

  console.log('Type C supdialog reference verified');
});

// Test 6: Type C flow - no registry persistence needed
runTest('Type C flow - no registry persistence needed', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  // Create Type C subdialog
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialog = new SubDialog(rootDialog, 'test-task.md', subdialogId, 'cmdr', {
    headLine: 'Quick task',
    callBody: 'Do something fast',
  });

  // Type C subdialogs don't need registry.yaml entries
  // They complete and their summary goes directly to parent
  const summary = 'Done!';
  rootDialog.addPendingSubdialogSummary(subdialogId, summary);

  // Check pending summaries (in-memory)
  const pending = rootDialog.getPendingSubdialogSummaries();
  assertEqual(pending.length, 1, 'Should have pending summary');

  // Registry should not have any entries (Type C doesn't use registry)
  assertEqual(rootDialog.subdialogMutex.size, 0, 'Registry should be empty for Type C');

  console.log('Type C flow without registry verified');
});

console.log('\n🎉 All Type C Transient Flow tests passed!');
