#!/usr/bin/env tsx
/**
 * parseTeammateCall Tests
 *
 * Tests for teammate call pattern parsing - determines Type B vs Type C:
 * - Type B: @<agentId> !<topicId> - creates/resumes registered subdialog
 * - Type C: @<agentId> - creates transient unregistered subdialog
 */

import { parseTeammateCall, TeammateCallTypeB, TeammateCallTypeC } from 'dominds/llm/driver';

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

console.log('🧪 parseTeammateCall Tests');
console.log('================================');

// Test 1: Type B parsing - agentId with topicId
runTest('Type B parsing - agentId with topicId', () => {
  const result = parseTeammateCall('@cmdr !code-review');

  assertTrue(result.type === 'B', 'Should be Type B');
  assertEqual((result as TeammateCallTypeB).agentId, 'cmdr', 'AgentId should be cmdr');
  assertEqual(
    (result as TeammateCallTypeB).topicId,
    'code-review',
    'TopicId should be code-review',
  );

  console.log(`Parsed: @cmdr !code-review → Type B (${result.type})`);
});

// Test 2: Type C parsing - agentId only (no topicId)
runTest('Type C parsing - agentId only (no topicId)', () => {
  const result = parseTeammateCall('@cmdr');

  assertTrue(result.type === 'C', 'Should be Type C');
  assertEqual((result as TeammateCallTypeC).agentId, 'cmdr', 'AgentId should be cmdr');

  console.log(`Parsed: @cmdr → Type C (${result.type})`);
});

// Test 3: Type B with various agent names
runTest('Type B with various agent names', () => {
  const testCases = [
    { input: '@reviewer !pr-123', agentId: 'reviewer', topicId: 'pr-123' },
    { input: '@analyst !data-analysis', agentId: 'analyst', topicId: 'data-analysis' },
    { input: '@test-agent !feature-x', agentId: 'test-agent', topicId: 'feature-x' },
    { input: '@special1 !topic-1', agentId: 'special1', topicId: 'topic-1' },
    { input: '@Agent123 !Task456', agentId: 'Agent123', topicId: 'Task456' },
  ];

  for (const { input, agentId, topicId } of testCases) {
    const result = parseTeammateCall(input);
    assertTrue(result.type === 'B', `Input "${input}" should be Type B`);
    assertEqual((result as TeammateCallTypeB).agentId, agentId, `AgentId should be ${agentId}`);
    assertEqual((result as TeammateCallTypeB).topicId, topicId, `TopicId should be ${topicId}`);
    console.log(`  ✓ @${agentId} !${topicId}`);
  }
});

// Test 4: Type C with various agent names
runTest('Type C with various agent names', () => {
  const testCases = [
    { input: '@cmdr', agentId: 'cmdr' },
    { input: '@reviewer', agentId: 'reviewer' },
    { input: '@analyst', agentId: 'analyst' },
    { input: '@test-agent', agentId: 'test-agent' },
    { input: '@special1', agentId: 'special1' },
    { input: '@Agent123', agentId: 'Agent123' },
  ];

  for (const { input, agentId } of testCases) {
    const result = parseTeammateCall(input);
    assertTrue(result.type === 'C', `Input "${input}" should be Type C`);
    assertEqual((result as TeammateCallTypeC).agentId, agentId, `AgentId should be ${agentId}`);
    console.log(`  ✓ @${agentId}`);
  }
});

// Test 5: Type B with whitespace variations
runTest('Type B with whitespace variations', () => {
  const testCases = [
    { input: '@cmdr!code-review', agentId: 'cmdr', topicId: 'code-review' },
    { input: '@cmdr !code-review', agentId: 'cmdr', topicId: 'code-review' },
    { input: '@cmdr  !code-review', agentId: 'cmdr', topicId: 'code-review' },
    { input: '@cmdr ! code-review', agentId: 'cmdr', topicId: 'code-review' },
  ];

  for (const { input, agentId, topicId } of testCases) {
    const result = parseTeammateCall(input);
    assertTrue(result.type === 'B', `Input "${input}" should be Type B`);
    assertEqual((result as TeammateCallTypeB).agentId, agentId, `AgentId should be ${agentId}`);
    assertEqual((result as TeammateCallTypeB).topicId, topicId, `TopicId should be ${topicId}`);
    console.log(`  ✓ "${input}" → Type B`);
  }
});

// Test 6: Type B pattern takes precedence (explicit topic wins)
runTest('Type B pattern takes precedence over Type C', () => {
  // When both patterns could match, Type B should be returned
  const result = parseTeammateCall('@cmdr !code-review');
  assertTrue(result.type === 'B', 'Should be Type B when !topicId present');

  // Verify the topicId is captured correctly
  assertEqual((result as TeammateCallTypeB).topicId, 'code-review', 'TopicId should be captured');
});

// Test 7: Type C without any topic marker
runTest('Type C without topic marker', () => {
  const result = parseTeammateCall('@cmdr');
  assertTrue(result.type === 'C', 'Should be Type C when no !topicId');

  // Verify no topicId in Type C
  const typeC = result as TeammateCallTypeC;
  assertTrue(typeC.topicId === undefined, 'Type C should not have topicId');
});

// Test 8: Type discrimination
runTest('Type discrimination', () => {
  const typeBResult = parseTeammateCall('@cmdr !topic');
  const typeCResult = parseTeammateCall('@cmdr');

  assertTrue(typeBResult.type !== typeCResult.type, 'Type B and C should be different');
  assertEqual(typeBResult.type, 'B', 'First should be Type B');
  assertEqual(typeCResult.type, 'C', 'Second should be Type C');
});

// Test 9: Complex real-world examples
runTest('Complex real-world examples', () => {
  const examples = [
    { input: '@code-reviewer !pr-456-changes', expectedType: 'B' as const },
    { input: '@test-runner !regression-test', expectedType: 'B' as const },
    { input: '@analyst', expectedType: 'C' as const },
    { input: '@documentation-writer !readme-update', expectedType: 'B' as const },
    { input: '@cmdr', expectedType: 'C' as const },
  ];

  for (const { input, expectedType } of examples) {
    const result = parseTeammateCall(input);
    assertEqual(result.type, expectedType, `Input "${input}" should be ${expectedType}`);
    console.log(`  ✓ "${input}" → Type ${expectedType}`);
  }
});

// Test 10: Discriminated union type narrowing
runTest('Discriminated union type narrowing', () => {
  const result = parseTeammateCall('@cmdr !code-review');

  if (result.type === 'B') {
    // TypeScript should narrow to TeammateCallTypeB
    assertEqual(result.agentId, 'cmdr', 'AgentId should be cmdr in Type B');
    assertEqual(result.topicId, 'code-review', 'TopicId should be code-review in Type B');
    assertTrue('topicId' in result, 'Type B should have topicId property');
  } else {
    throw new Error('Expected Type B result');
  }

  const resultC = parseTeammateCall('@cmdr');

  if (resultC.type === 'C') {
    // TypeScript should narrow to TeammateCallTypeC
    assertEqual(resultC.agentId, 'cmdr', 'AgentId should be cmdr in Type C');
    assertTrue(!('topicId' in resultC), 'Type C should not have topicId property');
  } else {
    throw new Error('Expected Type C result');
  }
});

// Test 11: Agent ID format validation (must start with letter)
runTest('Agent ID format validation', () => {
  // Valid agent IDs (alphanumeric, underscore, hyphen, must start with letter)
  const validAgents = ['cmdr', 'reviewer', 'test_agent', 'my-agent', 'Agent123'];
  for (const agent of validAgents) {
    const result = parseTeammateCall(`@${agent}`);
    assertTrue(result.type === 'C', `@${agent} should be valid Type C`);
  }

  // Type B with valid agent IDs
  const validTypeB = ['@cmdr !topic', '@reviewer !pr-123', '@test_agent !feature-x'];
  for (const input of validTypeB) {
    const result = parseTeammateCall(input);
    assertTrue(result.type === 'B', `${input} should be valid Type B`);
  }
});

// Test 12: Topic ID format validation
runTest('Topic ID format validation', () => {
  const testCases = [
    { input: '@cmdr !topic1', topicId: 'topic1' },
    { input: '@cmdr !my-topic', topicId: 'my-topic' },
    { input: '@cmdr !test_topic_123', topicId: 'test_topic_123' },
    { input: '@cmdr !Task-456', topicId: 'Task-456' },
  ];

  for (const { input, topicId } of testCases) {
    const result = parseTeammateCall(input);
    assertTrue(result.type === 'B', `Input "${input}" should be Type B`);
    assertEqual((result as TeammateCallTypeB).topicId, topicId, `TopicId should be ${topicId}`);
  }
});

console.log('\n🎉 All parseTeammateCall tests passed!');
