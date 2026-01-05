import { extractMentions } from 'dominds/texting';

// Helper function to compare arrays for equality
function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, index) => val === b[index]);
}

// Helper function to run a test case
function runTest(name: string, input: string, expected: string[]): void {
  console.log(`\n=== Testing: ${name} ===`);
  console.log('Input:');
  console.log(JSON.stringify(input));

  const actual = extractMentions(input);

  console.log('Expected:', JSON.stringify(expected));
  console.log('Actual:', JSON.stringify(actual));

  const passed = arraysEqual(actual, expected);
  console.log(`Result: ${passed ? '✅ PASS' : '❌ FAIL'}`);

  if (!passed) {
    throw new Error(`Test failed: ${name}`);
  }
}

// Main test runner
async function runAllTests(): Promise<void> {
  console.log('🧪 Testing extractMentions with backtick quoting...\n');

  try {
    // Test 1: Basic mentions without backticks
    runTest('Basic mentions without backticks', 'Hello @alice and @bob, how are you?', [
      'alice',
      'bob',
    ]);

    // Test 2: Mentions inside single backticks (should be ignored)
    runTest('Single backtick quoting', 'Check this code: `@alice` and also @bob', ['bob']);

    // Test 3: Mentions inside triple backticks (should be ignored)
    runTest(
      'Triple backtick quoting',
      'Here is some code:\n```\n@alice = "test"\n@bob = "value"\n```\nBut @charlie is real',
      ['charlie'],
    );

    // Test 4: Mixed backticks and mentions
    runTest(
      'Mixed backticks and mentions',
      '@alice says `@bob` and ```@charlie``` but @david is real',
      ['alice', 'david'],
    );

    // Test 5: Nested backticks
    runTest('Nested backticks', '@alice `code with @bob` and @charlie', ['alice', 'charlie']);

    // Test 6: Empty string and edge cases
    runTest('Empty string', '', []);

    // Test 7: Only backticks, no mentions
    runTest('Only backticks, no mentions', '```code block``` and `inline code`', []);

    // Test 8: Multiple single backtick pairs
    runTest('Multiple single backtick pairs', '@alice `@bob` and `@charlie` but @david is real', [
      'alice',
      'david',
    ]);

    // Test 9: Incomplete backticks
    runTest('Incomplete backticks', '@alice `incomplete backtick @bob and @charlie', ['alice']);

    // Test 10: Mentions at line boundaries
    runTest('Mentions at line boundaries', '@alice\n`@bob`\n@charlie', ['alice', 'charlie']);

    console.log('\n🎉 All extractMentions tests passed!');
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  }
}

// Run the tests
runAllTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
