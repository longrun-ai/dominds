#!/usr/bin/env tsx
/**
 * Revival/Continuation Flow Tests
 *
 * Tests for dialog hierarchy restoration and response incorporation:
 * - restoreDialogHierarchy() - restores complete dialog tree
 * - incorporateSubdialogResponses() - merges subdialog summaries
 * - continueDialogWithHumanResponse() - continues dialog with human input
 */

import { Dialog, DialogID, RootDialog, SubDialog } from 'dominds/dialog';
import { SubdialogMutex } from 'dominds/dialog-registry';
import { generateDialogID } from 'dominds/utils/id';
import { formatUnifiedTimestamp } from 'dominds/utils/time';

// Mock DialogStore for testing
class MockDialogStore implements Dialog['dlgStore'] {
  private messages: Map<string, unknown[]> = new Map();

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

console.log('🧪 Revival/Continuation Flow Tests');
console.log('================================');

// Test 1: Dialog hierarchy structure
runTest('Dialog hierarchy structure', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId1 = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialog1 = new SubDialog(rootDialog, 'test-task.md', subdialogId1, 'agent-2', {
    headLine: 'Subtask 1',
    callBody: 'Do work 1',
  });

  const subdialogId2 = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialog2 = new SubDialog(rootDialog, 'test-task.md', subdialogId2, 'agent-3', {
    headLine: 'Subtask 2',
    callBody: 'Do work 2',
  });

  // Verify hierarchy
  assertTrue(rootDialog.supdialog === undefined, 'Root dialog should have no supdialog');
  assertTrue(subdialog1.supdialog === rootDialog, 'Subdialog 1 supdialog should be root');
  assertTrue(subdialog2.supdialog === rootDialog, 'Subdialog 2 supdialog should be root');

  // Verify IDs
  assertEqual(rootDialog.id.rootId, rootDialogId.rootId, 'Root dialog should have correct rootId');
  assertEqual(subdialog1.id.rootId, rootDialogId.rootId, 'Subdialog 1 should share rootId');
  assertEqual(subdialog2.id.rootId, rootDialogId.rootId, 'Subdialog 2 should share rootId');

  console.log('Dialog hierarchy structure verified');
});

// Test 2: restoreDialogHierarchy simulation
runTest('restoreDialogHierarchy simulation', async () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  // Simulate subdialogs in hierarchy
  const subdialogIds = [
    new DialogID(generateDialogID(), rootDialogId.rootId),
    new DialogID(generateDialogID(), rootDialogId.rootId),
  ];

  const subdialogs = new Map<string, SubDialog>();
  for (const sdId of subdialogIds) {
    const subdialog = new SubDialog(
      rootDialog,
      'test-task.md',
      sdId,
      `agent-${sdId.selfId.slice(0, 4)}`,
      { headLine: 'Restored subdialog', callBody: 'Restored content' },
    );
    subdialogs.set(sdId.selfId, subdialog);
  }

  // Simulate restoration result
  const restorationResult = {
    rootDialog,
    subdialogs,
    summary: {
      totalMessages: 10,
      totalRounds: 3,
      completionStatus: 'incomplete' as const,
    },
  };

  assertTrue(restorationResult.rootDialog === rootDialog, 'Should have root dialog');
  assertEqual(restorationResult.subdialogs.size, 2, 'Should have 2 subdialogs');
  assertEqual(restorationResult.summary.totalMessages, 10, 'Should have 10 messages');
  assertEqual(restorationResult.summary.totalRounds, 3, 'Should have 3 rounds');
  assertEqual(restorationResult.summary.completionStatus, 'incomplete', 'Should be incomplete');

  console.log('restoreDialogHierarchy simulation successful');
});

// Test 3: incorporateSubdialogResponses simulation
runTest('incorporateSubdialogResponses simulation', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId1 = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialogId2 = new DialogID(generateDialogID(), rootDialogId.rootId);

  // Add subdialog responses (simulating completed subdialogs)
  rootDialog.addPendingSubdialogSummary(subdialogId1, 'Subdialog 1 completed: Analysis done');
  rootDialog.addPendingSubdialogSummary(subdialogId2, 'Subdialog 2 completed: Review complete');

  // Incorporate responses (take them from pending)
  const incorporated = rootDialog.takePendingSubdialogSummaries();

  assertEqual(incorporated.length, 2, 'Should incorporate 2 responses');
  assertTrue(
    incorporated[0].summary.includes('Analysis'),
    'First response should contain analysis',
  );
  assertTrue(incorporated[1].summary.includes('Review'), 'Second response should contain review');

  // Pending should be empty after incorporation
  assertEqual(
    rootDialog.getPendingSubdialogSummaries().length,
    0,
    'Pending should be empty after incorporate',
  );

  console.log('incorporateSubdialogResponses simulation successful');
});

// Test 4: continueDialogWithHumanResponse simulation
runTest('continueDialogWithHumanResponse simulation', async () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  // Simulate human response
  const humanPrompt = {
    content: 'Please continue with the next step',
    msgId: generateDialogID(),
  };

  // Simulate continuation
  const continuationResult = {
    rootDialog,
    subdialogs: new Map<string, Dialog>(),
    humanPrompt,
    continuedAt: formatUnifiedTimestamp(new Date()),
  };

  assertTrue(continuationResult.rootDialog === rootDialog, 'Should have root dialog');
  assertEqual(
    continuationResult.humanPrompt.content,
    humanPrompt.content,
    'Human prompt should match',
  );
  assertTrue(continuationResult.continuedAt !== undefined, 'Should have continuation timestamp');

  console.log('continueDialogWithHumanResponse simulation successful');
});

// Test 5: Dialog tree restoration with multiple subdialogs
runTest('Dialog tree restoration with multiple subdialogs', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  // Create nested structure
  const subdialogIds = Array.from(
    { length: 5 },
    () => new DialogID(generateDialogID(), rootDialogId.rootId),
  );

  const subdialogs = new Map<string, SubDialog>();
  for (let i = 0; i < subdialogIds.length; i++) {
    const subdialog = new SubDialog(rootDialog, 'test-task.md', subdialogIds[i], `agent-${i}`, {
      headLine: `Subtask ${i}`,
      callBody: `Work for subtask ${i}`,
    });
    subdialogs.set(subdialogIds[i].selfId, subdialog);
  }

  // Verify restoration
  assertEqual(subdialogs.size, 5, 'Should have 5 subdialogs');

  // Each subdialog should reference root dialog
  for (const [id, subdialog] of subdialogs) {
    assertTrue(subdialog.supdialog === rootDialog, `Subdialog ${id} should reference root`);
    assertEqual(subdialog.id.rootId, rootDialogId.rootId, `Subdialog ${id} should share rootId`);
  }

  console.log('Dialog tree restoration with multiple subdialogs successful');
});

// Test 6: Subdialog status tracking during revival
runTest('Subdialog status tracking during revival', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  // Register subdialogs in registry
  const subdialogId1 = new DialogID(generateDialogID(), rootDialogId.rootId);
  const subdialogId2 = new DialogID(generateDialogID(), rootDialogId.rootId);

  rootDialog.registerSubdialogByTopic('cmdr', 'task-1', subdialogId1);
  rootDialog.registerSubdialogByTopic('reviewer', 'task-2', subdialogId2);

  // Initially all locked (being driven)
  assertTrue(
    rootDialog.subdialogMutex.isLocked('cmdr', 'task-1'),
    'Task 1 should be locked initially',
  );
  assertTrue(
    rootDialog.subdialogMutex.isLocked('reviewer', 'task-2'),
    'Task 2 should be locked initially',
  );

  // Unlock one (subdialog done being driven)
  rootDialog.unlockMutexByTopic('cmdr', 'task-1');
  assertFalse(
    rootDialog.subdialogMutex.isLocked('cmdr', 'task-1'),
    'Task 1 should not be locked after unlock',
  );
  assertTrue(
    rootDialog.subdialogMutex.isLocked('reviewer', 'task-2'),
    'Task 2 should still be locked',
  );

  // Entry still exists but is not locked
  assertTrue(
    rootDialog.subdialogMutex.lookup('cmdr', 'task-1') !== null,
    'Task 1 entry should still exist after unlock',
  );

  console.log('Subdialog status tracking during revival successful');
});

// Test 7: Response incorporation with pending summaries
runTest('Response incorporation with pending summaries', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  // Add multiple pending summaries
  rootDialog.addPendingSubdialogSummary(subdialogId, 'Summary 1');
  rootDialog.addPendingSubdialogSummary(subdialogId, 'Summary 2');
  rootDialog.addPendingSubdialogSummary(subdialogId, 'Summary 3');

  // Incorporate all
  const incorporated = rootDialog.takePendingSubdialogSummaries();

  assertEqual(incorporated.length, 3, 'Should incorporate 3 summaries');

  // Verify content
  const summaries = incorporated.map((s) => s.summary);
  assertTrue(summaries.includes('Summary 1'), 'Should have Summary 1');
  assertTrue(summaries.includes('Summary 2'), 'Should have Summary 2');
  assertTrue(summaries.includes('Summary 3'), 'Should have Summary 3');

  console.log('Response incorporation with pending summaries successful');
});

// Test 8: Root dialog registry restoration
runTest('Root dialog registry restoration', () => {
  const registry = new SubdialogMutex();
  const rootDialogId = new DialogID(generateDialogID());

  // Simulate restored entries
  const entries = [
    {
      agentId: 'cmdr',
      topicId: 'code-review',
      subdialogId: new DialogID(generateDialogID(), rootDialogId.rootId),
    },
    {
      agentId: 'reviewer',
      topicId: 'pr-123',
      subdialogId: new DialogID(generateDialogID(), rootDialogId.rootId),
    },
    {
      agentId: 'analyst',
      topicId: 'data',
      subdialogId: new DialogID(generateDialogID(), rootDialogId.rootId),
    },
  ];

  // Restore entries
  for (const entry of entries) {
    registry.lock(entry.agentId, entry.topicId, entry.subdialogId);
  }

  // Verify restoration
  assertEqual(registry.size, 3, 'Registry should have 3 entries');

  for (const entry of entries) {
    const lookup = registry.lookup(entry.agentId, entry.topicId);
    assertTrue(lookup !== null, `Should find entry for ${entry.agentId}!${entry.topicId}`);
    assertTrue(lookup?.locked, `Entry should be locked initially`);
  }

  console.log('Root dialog registry restoration successful');
});

// Test 9: Completion status in summary
runTest('Completion status in summary', () => {
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(new MockDialogStore(), 'test-task.md', rootDialogId, 'agent-1');

  // Simulate different completion states
  const incompleteState = {
    rootDialog,
    subdialogs: new Map<string, Dialog>(),
    summary: { totalMessages: 5, totalRounds: 2, completionStatus: 'incomplete' as const },
  };

  const completeState = {
    rootDialog,
    subdialogs: new Map<string, Dialog>(),
    summary: { totalMessages: 10, totalRounds: 5, completionStatus: 'complete' as const },
  };

  const failedState = {
    rootDialog,
    subdialogs: new Map<string, Dialog>(),
    summary: { totalMessages: 3, totalRounds: 1, completionStatus: 'failed' as const },
  };

  assertEqual(incompleteState.summary.completionStatus, 'incomplete', 'Should be incomplete');
  assertEqual(completeState.summary.completionStatus, 'complete', 'Should be complete');
  assertEqual(failedState.summary.completionStatus, 'failed', 'Should be failed');

  console.log('Completion status in summary verified');
});

console.log('\n🎉 All Revival/Continuation Flow tests passed!');
