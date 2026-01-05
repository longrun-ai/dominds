#!/usr/bin/env tsx
/**
 * Phase 13: SubdialogMutex Flow Tests
 *
 * Tests for CORRECTED mutex-based registry mechanism (Type B: lock/unlock).
 * Phase 13 corrected the registry from status-based (active/done) to mutex-based (locked/unlocked).
 * Type B subdialogs are tracked in registry.yaml with agentId!topicId composite keys.
 * Registry now tracks only mutex state: locked (being driven) vs unlocked (can resume).
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

console.log('🧪 Phase 13: SubdialogMutex Flow Tests (CORRECTED)');
console.log('===============================================');

// Test 1: SubdialogMutex key generation
runTest('SubdialogMutex key generation', () => {
  const key = SubdialogMutex.makeKey('cmdr', 'code-review');
  assertEqual(key, 'cmdr!code-review', 'Key should be agentId!topicId format');

  const key2 = SubdialogMutex.makeKey('reviewer', 'pr-123');
  assertEqual(key2, 'reviewer!pr-123', 'Key should be agentId!topicId format');

  console.log(`Generated keys: "${key}", "${key2}"`);
});

// Test 2: SubdialogMutex lock and lookup
runTest('SubdialogMutex lock and lookup', () => {
  const registry = new SubdialogMutex();
  const rootDialogId = new DialogID(generateDialogID());
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  const entry = registry.lock('cmdr', 'code-review', subdialogId);

  assertTrue(entry !== null, 'Entry should be created');
  assertEqual(entry.key, 'cmdr!code-review', 'Entry key should match');
  assertEqual(entry.subdialogId, subdialogId, 'Entry subdialogId should match');
  assertEqual(entry.locked, true, 'Entry should be locked initially');

  // Lookup should return the same entry
  const lookup = registry.lookup('cmdr', 'code-review');
  assertTrue(lookup !== null, 'Lookup should return entry');
  assertEqual(lookup?.key, 'cmdr!code-review', 'Lookup key should match');
  assertEqual(lookup?.subdialogId, subdialogId, 'Lookup subdialogId should match');

  console.log('SubdialogMutex lock and lookup working correctly');
});

// Test 3: SubdialogMutex lock transition (locked -> unlocked)
runTest('SubdialogMutex lock transition (locked -> unlocked)', () => {
  const registry = new SubdialogMutex();
  const rootDialogId = new DialogID(generateDialogID());
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  registry.lock('reviewer', 'pr-456', subdialogId);

  // Initially should be locked
  let entry = registry.lookup('reviewer', 'pr-456');
  assertEqual(entry?.locked, true, 'Entry should be locked initially');

  // Unlock
  const unlocked = registry.unlock('reviewer', 'pr-456');
  assertTrue(unlocked, 'unlock should return true');
  entry = registry.lookup('reviewer', 'pr-456');
  assertEqual(entry?.locked, false, 'Entry should be unlocked after unlock()');

  console.log('Lock transition from locked to unlocked working correctly');
});

// Test 4: SubdialogMutex isLocked check
runTest('SubdialogMutex isLocked check', () => {
  const registry = new SubdialogMutex();
  const rootDialogId = new DialogID(generateDialogID());
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  // Non-existent entry should not be locked
  assertFalse(registry.isLocked('cmdr', 'nonexistent'), 'Non-existent entry should not be locked');

  // Lock entry
  registry.lock('cmdr', 'code-review', subdialogId);
  assertTrue(registry.isLocked('cmdr', 'code-review'), 'New entry should be locked');

  // Unlock
  registry.unlock('cmdr', 'code-review');
  assertFalse(registry.isLocked('cmdr', 'code-review'), 'Unlocked entry should not be locked');

  console.log('isLocked check working correctly');
});

// Test 5: SubdialogMutex getAll and filtering
runTest('SubdialogMutex getAll and filtering', () => {
  const registry = new SubdialogMutex();
  const rootDialogId = new DialogID(generateDialogID());

  const sd1 = new DialogID(generateDialogID(), rootDialogId.rootId);
  const sd2 = new DialogID(generateDialogID(), rootDialogId.rootId);
  const sd3 = new DialogID(generateDialogID(), rootDialogId.rootId);

  registry.lock('agent1', 'topic1', sd1);
  registry.lock('agent2', 'topic2', sd2);
  registry.lock('agent3', 'topic3', sd3);

  let all = registry.getAll();
  assertEqual(all.length, 3, 'Should have 3 entries');

  // Unlock one
  registry.unlock('agent2', 'topic2');

  all = registry.getAll();
  assertEqual(all.length, 3, 'getAll should return all entries including unlocked');

  const locked = registry.getLockedEntries();
  assertEqual(locked.length, 2, 'getLockedEntries should return 2 locked entries');

  const unlocked = registry.getUnlockedEntries();
  assertEqual(unlocked.length, 1, 'getUnlockedEntries should return 1 unlocked entry');

  console.log('getAll and filtering working correctly');
});

// Test 6: SubdialogMutex remove
runTest('SubdialogMutex remove', () => {
  const registry = new SubdialogMutex();
  const rootDialogId = new DialogID(generateDialogID());
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  registry.lock('cmdr', 'test-topic', subdialogId);
  assertTrue(registry.lookup('cmdr', 'test-topic') !== null, 'Entry should exist');

  const removed = registry.remove('cmdr', 'test-topic');
  assertTrue(removed, 'remove should return true');
  assertTrue(registry.lookup('cmdr', 'test-topic') === null, 'Entry should not exist after remove');

  // Remove non-existent should return false
  const removed2 = registry.remove('nonexistent', 'topic');
  assertFalse(removed2, 'remove should return false for non-existent');

  console.log('Registry remove working correctly');
});

// Test 7: RootDialog registry integration
runTest('RootDialog registry integration', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  // Lock subdialog by topic (Phase 13)
  const entry = rootDialog.registerSubdialogByTopic('cmdr', 'code-review', subdialogId);

  assertEqual(entry.key, 'cmdr!code-review', 'Entry key should match');
  assertEqual(entry.subdialogId, subdialogId, 'Entry subdialogId should match');
  assertEqual(entry.locked, true, 'Entry should be locked');

  // Lookup by topic
  const lookup = rootDialog.lookupSubdialogByTopic('cmdr', 'code-review');
  assertTrue(lookup !== null, 'Lookup should return entry');
  assertEqual(lookup?.subdialogId, subdialogId, 'Lookup subdialogId should match');

  console.log('RootDialog registry integration working correctly');
});

// Test 8: RootDialog unlockMutexByTopic
runTest('RootDialog unlockMutexByTopic', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  rootDialog.registerSubdialogByTopic('reviewer', 'pr-789', subdialogId);

  // Initially locked
  let entry = rootDialog.lookupSubdialogByTopic('reviewer', 'pr-789');
  assertEqual(entry?.locked, true, 'Entry should be locked initially');

  // Unlock
  const unlocked = rootDialog.unlockMutexByTopic('reviewer', 'pr-789');
  assertTrue(unlocked, 'unlockMutexByTopic should return true');
  entry = rootDialog.lookupSubdialogByTopic('reviewer', 'pr-789');
  assertEqual(entry?.locked, false, 'Entry should be unlocked after unlockMutexByTopic');

  console.log('RootDialog unlockMutexByTopic working correctly');
});

// Test 9: Type B flow - createRegisteredSubdialog
runTest('Type B flow - createRegisteredSubdialog', () => {
  const mockStore = new MockDialogStore();
  const rootDialogId = new DialogID(generateDialogID());
  const rootDialog = new RootDialog(mockStore, 'test-task.md', rootDialogId, 'agent-1');

  // Simulate Type B subdialog creation (registered with topic)
  const subdialogId = new DialogID(generateDialogID(), rootDialogId.rootId);

  // Lock in registry (Type B pattern)
  const entry = rootDialog.registerSubdialogByTopic('cmdr', 'persistent-task', subdialogId);

  // Verify entry properties for Type B
  assertEqual(entry.locked, true, 'Type B entry should start locked');
  assertTrue(entry.key.includes('!'), 'Type B key should contain ! separator');

  // Lookup to verify registration
  const lookup = rootDialog.subdialogMutex.lookup('cmdr', 'persistent-task');
  assertTrue(lookup !== null, 'Type B entry should be findable in registry');

  // Unlock (simulating completion)
  rootDialog.subdialogMutex.unlock('cmdr', 'persistent-task');

  // Verify locked state
  const updatedLookup = rootDialog.subdialogMutex.lookup('cmdr', 'persistent-task');
  assertEqual(updatedLookup?.locked, false, 'Type B entry should be unlocked after completion');

  console.log('Type B flow - createRegisteredSubdialog completed successfully');
});

console.log('\n🎉 All Phase 13 SubdialogMutex tests passed!');
