import { TextingEventsReceiver, TextingStreamParser } from 'dominds/texting';

type RecordedEvent = { type: string; data: unknown };

// Mock TextingEventsReceiver that collects all events
class MockTextingEventsReceiver implements TextingEventsReceiver {
  public events: RecordedEvent[] = [];

  async markdownStart(): Promise<void> {
    this.events.push({ type: 'markdownStart', data: null });
  }

  async markdownChunk(chunk: string): Promise<void> {
    this.events.push({ type: 'markdownChunk', data: chunk });
  }

  async markdownFinish(): Promise<void> {
    this.events.push({ type: 'markdownFinish', data: null });
  }

  async callStart(firstMention: string): Promise<void> {
    this.events.push({ type: 'callStart', data: { firstMention } });
  }

  async callHeadLineChunk(chunk: string): Promise<void> {
    this.events.push({ type: 'callHeadLineChunk', data: chunk });
  }

  async callHeadLineFinish(): Promise<void> {
    this.events.push({ type: 'callHeadLineFinish', data: null });
  }

  async callBodyStart(infoLine?: string): Promise<void> {
    this.events.push({ type: 'callBodyStart', data: infoLine !== undefined ? { infoLine } : {} });
  }

  async callBodyChunk(chunk: string): Promise<void> {
    this.events.push({ type: 'callBodyChunk', data: chunk });
  }

  async callBodyFinish(endQuote?: string): Promise<void> {
    this.events.push({ type: 'callBodyFinish', data: endQuote !== undefined ? { endQuote } : {} });
  }

  async callFinish(callId: string): Promise<void> {
    this.events.push({ type: 'callFinish', data: callId });
  }

  async codeBlockStart(infoLine: string): Promise<void> {
    this.events.push({ type: 'codeBlockStart', data: { infoLine } });
  }

  async codeBlockChunk(chunk: string): Promise<void> {
    this.events.push({ type: 'codeBlockChunk', data: chunk });
  }

  async codeBlockFinish(endQuote: string): Promise<void> {
    this.events.push({ type: 'codeBlockFinish', data: { endQuote } });
  }
}

let totalCnt = 0,
  failedCnt = 0;

const STREAM_CHUNK = 10; // Must match TextingStreamParser.CHUNK_THRESHOLD

// Helper function to run a test case
async function runTest(
  name: string,
  input: string,
  expectedEvents: RecordedEvent[],
): Promise<void> {
  totalCnt++;
  console.log(`\n=== Testing: ${name} ===`);
  console.log('Input:');
  console.log(JSON.stringify(input, null, 2));

  const receiver = new MockTextingEventsReceiver();
  const parser = new TextingStreamParser(receiver);

  // Process the input in chunks to test streaming behavior
  for (let i = 0; i < input.length; i += STREAM_CHUNK) {
    const chunk = input.substring(i, i + STREAM_CHUNK);
    await parser.takeUpstreamChunk(chunk);
  }

  // Finalize the parser
  await parser.finalize();

  const collectCallsFromEvents = (
    events: RecordedEvent[],
  ): Array<{ firstMention: string; headLine: string; body: string; callId?: string }> => {
    const calls: Array<{ firstMention: string; headLine: string; body: string; callId?: string }> =
      [];
    let current: { firstMention: string; headLine: string; body: string; callId?: string } | null =
      null;

    for (const ev of events) {
      if (ev.type === 'callHeadLineChunk') {
        if (!current) current = { firstMention: '', headLine: '', body: '' };
        current.headLine += String(ev.data);
        continue;
      }
      if (ev.type === 'callStart') {
        if (!current) current = { firstMention: '', headLine: '', body: '' };
        if (typeof ev.data === 'object' && ev.data !== null && 'firstMention' in ev.data) {
          const v = (ev.data as Record<string, unknown>)['firstMention'];
          current.firstMention = typeof v === 'string' ? v : String(v ?? '');
        } else {
          current.firstMention = '';
        }
        continue;
      }
      if (ev.type === 'callBodyChunk') {
        if (!current) current = { firstMention: '', headLine: '', body: '' };
        current.body += String(ev.data);
        continue;
      }
      if (ev.type === 'callFinish') {
        if (current?.firstMention) {
          if (ev.data && typeof ev.data === 'string') {
            current.callId = ev.data;
          }
          calls.push(current);
        }
        current = null;
        continue;
      }
    }

    return calls;
  };

  // Deep comparison function that handles undefined values
  const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;

    // Special case for callFinish: if expected (b) has data null, ignore actual (a) data
    if (typeof b === 'object' && b !== null) {
      const bRecord = b as Record<string, unknown>;
      if (bRecord['type'] === 'callFinish' && bRecord['data'] === null) {
        if (typeof a === 'object' && a !== null) {
          const aRecord = a as Record<string, unknown>;
          if (aRecord['type'] === 'callFinish') return true;
        }
      }
    }

    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;

    if (typeof a !== 'object') return false;

    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
        return false;
    }

    return true;
  };

  const passed = deepEqual(receiver.events, expectedEvents);
  const expectedCollectedCalls = collectCallsFromEvents(receiver.events);
  const actualCollectedCalls = parser.getCollectedCalls();
  const callCollectionOk = deepEqual(actualCollectedCalls, expectedCollectedCalls);
  console.log(`Result: ${passed ? '✅ PASS' : '❌ FAIL'}`);

  if (!passed || !callCollectionOk) {
    failedCnt++;
    console.log('❌ Test failed!');

    console.log('Expected Events:');
    console.log(JSON.stringify(expectedEvents, null, 2));
    console.log('Actual Events:');
    console.log(JSON.stringify(receiver.events, null, 2));

    if (!callCollectionOk) {
      console.log('Expected Collected Calls:');
      console.log(JSON.stringify(expectedCollectedCalls, null, 2));
      console.log('Actual Collected Calls:');
      console.log(JSON.stringify(actualCollectedCalls, null, 2));
    }

    process.stdout.write('', () => process.stderr.write('', () => process.exit(1)));
  }
}

// Helper to build expected events for basic cases
function chunkByStreamBoundaries(text: string, startIndex: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  const firstChunk = STREAM_CHUNK - (startIndex % STREAM_CHUNK || 0);
  if (text.length <= firstChunk) {
    chunks.push(text);
    return chunks;
  }
  chunks.push(text.substring(0, firstChunk));
  i = firstChunk;
  while (i < text.length) {
    chunks.push(text.substring(i, i + STREAM_CHUNK));
    i += STREAM_CHUNK;
  }
  return chunks;
}

function buildBasicCallEvents(
  firstMention: string,
  headLine: string,
  body: string = '',
  input?: string,
) {
  const events: RecordedEvent[] = [];

  // Call events

  // Headline chunks - simulate how the actual TextingStreamParser emits chunks
  const headStart = input ? input.indexOf(headLine) : 0;

  const isValidMentionChar = (char: string): boolean => {
    const charCode = char.charCodeAt(0);
    return (
      (charCode >= 48 && charCode <= 57) || // 0-9
      (charCode >= 65 && charCode <= 90) || // A-Z
      (charCode >= 97 && charCode <= 122) || // a-z
      char === '_' ||
      char === '-' ||
      char === '.' ||
      /\p{L}/u.test(char) ||
      /\p{N}/u.test(char)
    );
  };

  // Simulate the parser's headline chunking:
  // - It does NOT emit headline chunks until `callStart` is emitted.
  // - After `callStart`, it flushes the entire headline buffer at upstream chunk boundaries
  //   (STREAM_CHUNK) and at headline termination (newline / finalize).
  const headChunks: string[] = [];

  if (!input) {
    // No input provided - use simple 10-char chunking
    for (let i = 0; i < headLine.length; i += STREAM_CHUNK) {
      headChunks.push(headLine.substring(i, Math.min(i + STREAM_CHUNK, headLine.length)));
    }
  } else {
    // Find where `callStart` gets emitted: the first non-mention char after the initial `@...`.
    // If the headline contains only the mention, `callStart` happens at the newline after the
    // headline (i.e. effectively at headLine.length for our purposes).
    let callStartOffset = headLine.length;
    if (headLine.startsWith('@')) {
      for (let i = 1; i < headLine.length; i++) {
        if (!isValidMentionChar(headLine[i])) {
          callStartOffset = i;
          break;
        }
      }
    }
    const callStartGlobalPos = headStart + callStartOffset;
    const headEnd = headStart + headLine.length;

    let last = 0;
    for (let b = STREAM_CHUNK; b < headEnd; b += STREAM_CHUNK) {
      if (b <= headStart) continue;
      // Flush happens at upstream chunk end only after callStart has been emitted.
      if (callStartGlobalPos < b) {
        headChunks.push(headLine.substring(last, b - headStart));
        last = b - headStart;
      }
    }
    headChunks.push(headLine.substring(last));
  }

  // emit callStart first, then headline chunks
  events.push({ type: 'callStart', data: { firstMention } });

  for (let idx = 0; idx < headChunks.length; idx++) {
    events.push({ type: 'callHeadLineChunk', data: headChunks[idx] });
  }
  events.push({ type: 'callHeadLineFinish', data: null });

  // Body content
  if (body.trim()) {
    const tripleQuoted = body.startsWith('```');
    if (tripleQuoted) {
      events.push({ type: 'callBodyStart', data: { infoLine: '```' } });
      // Include opening quotes in body content but exclude closing quotes
      const withoutClosing = body.endsWith('```') ? body.slice(0, -3) : body;
      const bodyStart = input ? input.indexOf(body, headStart + headLine.length) : 0;
      const bodyChunks = input
        ? chunkByStreamBoundaries(withoutClosing, bodyStart)
        : (() => {
            const arr: string[] = [];
            for (let i = 0; i < withoutClosing.length; i += STREAM_CHUNK) {
              arr.push(withoutClosing.substring(i, i + STREAM_CHUNK));
            }
            return arr;
          })();
      for (const chunk of bodyChunks) {
        events.push({ type: 'callBodyChunk', data: chunk });
      }
      events.push({ type: 'callBodyFinish', data: { endQuote: '```' } });
    } else {
      events.push({ type: 'callBodyStart', data: {} });
      const bodyStart = input ? input.indexOf(body, headStart + headLine.length) : 0;
      const bodyChunks = input
        ? chunkByStreamBoundaries(body, bodyStart)
        : (() => {
            const arr: string[] = [];
            for (let i = 0; i < body.length; i += STREAM_CHUNK) {
              arr.push(body.substring(i, i + STREAM_CHUNK));
            }
            return arr;
          })();
      for (const chunk of bodyChunks) {
        events.push({ type: 'callBodyChunk', data: chunk });
      }
      events.push({ type: 'callBodyFinish', data: {} });
    }
  }

  events.push({ type: 'callFinish', data: null });

  return events;
}

// Helper to build free text events
function buildFreeTextEvents(text: string, input?: string, fromIndex?: number) {
  const events: RecordedEvent[] = [];

  events.push({ type: 'markdownStart', data: null });

  const start = input ? (fromIndex !== undefined ? fromIndex : input.indexOf(text)) : 0;
  const chunks = input
    ? chunkByStreamBoundaries(text, start)
    : (() => {
        const arr: string[] = [];
        for (let i = 0; i < text.length; i += STREAM_CHUNK) {
          arr.push(text.substring(i, i + STREAM_CHUNK));
        }
        return arr;
      })();
  for (const chunk of chunks) {
    events.push({ type: 'markdownChunk', data: chunk });
  }

  events.push({ type: 'markdownFinish', data: null });

  return events;
}

// Helper to build code block events
function buildCodeBlockEvents(infoLine: string, content: string, input?: string) {
  const events: RecordedEvent[] = [];

  events.push({ type: 'codeBlockStart', data: { infoLine } });

  const contentStart = input ? input.indexOf(content) : 0;
  const chunks = input
    ? chunkByStreamBoundaries(content, contentStart)
    : (() => {
        const arr: string[] = [];
        for (let i = 0; i < content.length; i += STREAM_CHUNK) {
          arr.push(content.substring(i, i + STREAM_CHUNK));
        }
        return arr;
      })();
  for (const chunk of chunks) {
    events.push({ type: 'codeBlockChunk', data: chunk });
  }

  events.push({ type: 'codeBlockFinish', data: { endQuote: '' } });

  return events;
}

// Main function to run all tests
async function runAllTests() {
  // Test 1: Basic single mention parsing
  await runTest(
    'Basic single mention',
    '@tool1 some args',
    buildBasicCallEvents('tool1', '@tool1 some args', '', '@tool1 some args'),
  );

  // Test 2: Multiple mentions in headline
  await runTest(
    'Multiple mentions in headline',
    '@user1 @user2 hello there',
    buildBasicCallEvents('user1', '@user1 @user2 hello there', '', '@user1 @user2 hello there'),
  );

  // Test 3: Tool call with body
  await runTest(
    'Tool call with body',
    `@tool1 command
This is the body
with multiple lines`,
    buildBasicCallEvents(
      'tool1',
      '@tool1 command',
      'This is the body\nwith multiple lines',
      `@tool1 command\nThis is the body\nwith multiple lines`,
    ),
  );

  // Test 4: Multiple tool calls
  await runTest(
    'Multiple tool calls',
    `@tool1 first command
First body content

@tool2 second command
Second body content`,
    [
      ...buildBasicCallEvents(
        'tool1',
        '@tool1 first command',
        'First body content\n\n',
        `@tool1 first command\nFirst body content\n\n@tool2 second command\nSecond body content`,
      ),
      ...buildBasicCallEvents(
        'tool2',
        '@tool2 second command',
        'Second body content',
        `@tool1 first command\nFirst body content\n\n@tool2 second command\nSecond body content`,
      ),
    ],
  );

  // Test 4b: Multiple tool calls without @/ even if body contains ``` later
  await runTest(
    'Multiple tool calls with ``` in body (no @/)',
    `@tool1 cmd
first line
\`\`\`js
console.log(1)
\`\`\`
@tool2 cmd2
body2`,
    [
      ...buildBasicCallEvents(
        'tool1',
        '@tool1 cmd',
        'first line\n```js\nconsole.log(1)\n```\n',
        `@tool1 cmd\nfirst line\n\`\`\`js\nconsole.log(1)\n\`\`\`\n@tool2 cmd2\nbody2`,
      ),
      ...buildBasicCallEvents(
        'tool2',
        '@tool2 cmd2',
        'body2',
        `@tool1 cmd\nfirst line\n\`\`\`js\nconsole.log(1)\n\`\`\`\n@tool2 cmd2\nbody2`,
      ),
    ],
  );

  // Test 5: Free text only
  await runTest(
    'Free text only',
    'This is just regular text\nwith no mentions',
    buildFreeTextEvents(
      'This is just regular text\nwith no mentions',
      'This is just regular text\nwith no mentions',
    ),
  );

  // Test 6: Special @/ syntax
  await runTest(
    'Special @/ syntax',
    `@tool1 command
This is body content
@/
This text after @/`,
    [
      ...buildBasicCallEvents(
        'tool1',
        '@tool1 command',
        'This is body content\n',
        `@tool1 command\nThis is body content\n@/\nThis text after @/`,
      ),
      ...buildFreeTextEvents(
        '\nThis text after @/',
        `@tool1 command\nThis is body content\n@/\nThis text after @/`,
      ),
    ],
  );

  // Test 7: Multi-line headline
  await runTest(
    'Multi-line headline',
    `@user1 first line\n@user2 second line\nThis is the body`,
    buildBasicCallEvents(
      'user1',
      '@user1 first line\n@user2 second line',
      'This is the body',
      `@user1 first line\n@user2 second line\nThis is the body`,
    ),
  );

  // Test 8: Empty call with null body
  await runTest(
    'Empty call with null body',
    `@tool1 command

@tool2 another`,
    [
      ...buildBasicCallEvents('tool1', '@tool1 command', '', `@tool1 command\n\n@tool2 another`),
      ...buildBasicCallEvents('tool2', '@tool2 another', '', `@tool1 command\n\n@tool2 another`),
    ],
  );

  // Test 9: Code block parsing
  await runTest(
    'Code block parsing',
    `Free text before
\`\`\`javascript
function hello() {
  console.log("Hello");
}
\`\`\`
Free text after`,
    [
      { type: 'markdownStart', data: null },
      { type: 'markdownChunk', data: 'Free text ' },
      { type: 'markdownChunk', data: 'before\n' },
      { type: 'markdownFinish', data: null },
      { type: 'codeBlockStart', data: { infoLine: 'javascript' } },
      { type: 'codeBlockChunk', data: '\nfunction ' },
      { type: 'codeBlockChunk', data: 'hello() {\n' },
      { type: 'codeBlockChunk', data: '  console.' },
      { type: 'codeBlockChunk', data: 'log("Hello' },
      { type: 'codeBlockChunk', data: '");\n}\n' },
      { type: 'codeBlockFinish', data: { endQuote: '' } },
      { type: 'markdownStart', data: null },
      { type: 'markdownChunk', data: '\n' },
      { type: 'markdownChunk', data: 'Free text ' },
      { type: 'markdownChunk', data: 'after' },
      { type: 'markdownFinish', data: null },
    ],
  );

  // Test 10: Qualified names with dots
  await runTest(
    'Qualified names with dots',
    `@namespace.tool1 command
This is the body`,
    [
      { type: 'callStart', data: { firstMention: 'namespace.tool1' } },
      { type: 'callHeadLineChunk', data: '@namespace.tool1 com' },
      { type: 'callHeadLineChunk', data: 'mand' },
      { type: 'callHeadLineFinish', data: null },
      { type: 'callBodyStart', data: {} },
      { type: 'callBodyChunk', data: 'This ' },
      { type: 'callBodyChunk', data: 'is the bod' },
      { type: 'callBodyChunk', data: 'y' },
      { type: 'callBodyFinish', data: {} },
      { type: 'callFinish', data: null },
    ],
  );

  // Test 11: Backtick escaping for whole call body
  await runTest(
    'Backtick escaping for whole call body',
    `@tool1 code example
\`\`\`
@this_should_be_ignored
function test() {
  return "@also_ignored";
}
\`\`\``,
    [
      { type: 'callStart', data: { firstMention: 'tool1' } },
      { type: 'callHeadLineChunk', data: '@tool1 cod' },
      { type: 'callHeadLineChunk', data: 'e example' },
      { type: 'callHeadLineFinish', data: null },
      { type: 'callBodyStart', data: { infoLine: '```' } },
      { type: 'callBodyChunk', data: '```\n@this_' },
      { type: 'callBodyChunk', data: 'should_be_' },
      { type: 'callBodyChunk', data: 'ignored\nfu' },
      { type: 'callBodyChunk', data: 'nction tes' },
      { type: 'callBodyChunk', data: 't() {\n  re' },
      { type: 'callBodyChunk', data: 'turn "@als' },
      { type: 'callBodyChunk', data: 'o_ignored"' },
      { type: 'callBodyChunk', data: ';\n}\n```' },
      { type: 'callBodyFinish', data: { endQuote: '```' } },
      { type: 'callFinish', data: null },
    ],
  );

  // Test 12: Multiple code blocks parsing
  await runTest(
    'Multiple code blocks parsing',
    `First free text
\`\`\`python
print("A")
\`\`\`
Middle text
\`\`\`bash
echo "B"
\`\`\`
End text`,
    [
      { type: 'markdownStart', data: null },
      { type: 'markdownChunk', data: 'First free' },
      { type: 'markdownChunk', data: ' text\n' },
      { type: 'markdownFinish', data: null },
      { type: 'codeBlockStart', data: { infoLine: 'python' } },
      { type: 'codeBlockChunk', data: '\nprin' },
      { type: 'codeBlockChunk', data: 't("A")\n' },
      { type: 'codeBlockFinish', data: { endQuote: '' } },
      { type: 'markdownStart', data: null },
      { type: 'markdownChunk', data: '\nMiddle te' },
      { type: 'markdownChunk', data: 'xt\n' },
      { type: 'markdownFinish', data: null },
      { type: 'codeBlockStart', data: { infoLine: 'bash' } },
      { type: 'codeBlockChunk', data: '\necho "B"\n' },
      { type: 'codeBlockFinish', data: { endQuote: '' } },
      { type: 'markdownStart', data: null },
      { type: 'markdownChunk', data: '\nEnd te' },
      { type: 'markdownChunk', data: 'xt' },
      { type: 'markdownFinish', data: null },
    ],
  );

  // Test 13: Multiple @add_reminder calls (from reminders e2e test)
  await runTest(
    'Multiple @add_reminder calls',
    `Setting up reminders.

@add_reminder
Goals Tracking - Monitor project objectives and outcomes
@/

@add_reminder
Timeline Management - Track deadlines and milestones
@/

@add_reminder
Budget Oversight - Monitor financial constraints and expenditures
@/

Done.`,
    [
      ...buildFreeTextEvents(
        'Setting up reminders.\n\n',
        `Setting up reminders.\n\n@add_reminder\nGoals Tracking - Monitor project objectives and outcomes\n@/\n\n@add_reminder\nTimeline Management - Track deadlines and milestones\n@/\n\n@add_reminder\nBudget Oversight - Monitor financial constraints and expenditures\n@/\n\nDone.`,
      ),
      ...buildBasicCallEvents(
        'add_reminder',
        '@add_reminder',
        'Goals Tracking - Monitor project objectives and outcomes\n',
        `Setting up reminders.\n\n@add_reminder\nGoals Tracking - Monitor project objectives and outcomes\n@/\n\n@add_reminder\nTimeline Management - Track deadlines and milestones\n@/\n\n@add_reminder\nBudget Oversight - Monitor financial constraints and expenditures\n@/\n\nDone.`,
      ),
      ...buildFreeTextEvents(
        '\n\n',
        `Setting up reminders.\n\n@add_reminder\nGoals Tracking - Monitor project objectives and outcomes\n@/\n\n@add_reminder\nTimeline Management - Track deadlines and milestones\n@/\n\n@add_reminder\nBudget Oversight - Monitor financial constraints and expenditures\n@/\n\nDone.`,
      ),
      ...buildBasicCallEvents(
        'add_reminder',
        '@add_reminder',
        'Timeline Management - Track deadlines and milestones\n',
        `Setting up reminders.\n\n@add_reminder\nGoals Tracking - Monitor project objectives and outcomes\n@/\n\n@add_reminder\nTimeline Management - Track deadlines and milestones\n@/\n\n@add_reminder\nBudget Oversight - Monitor financial constraints and expenditures\n@/\n\nDone.`,
      ),
      ...buildFreeTextEvents(
        '\n\n',
        `Setting up reminders.\n\n@add_reminder\nGoals Tracking - Monitor project objectives and outcomes\n@/\n\n@add_reminder\nTimeline Management - Track deadlines and milestones\n@/\n\n@add_reminder\nBudget Oversight - Monitor financial constraints and expenditures\n@/\n\nDone.`,
      ),
      ...buildBasicCallEvents(
        'add_reminder',
        '@add_reminder',
        'Budget Oversight - Monitor financial constraints and expenditures\n',
        `Setting up reminders.\n\n@add_reminder\nGoals Tracking - Monitor project objectives and outcomes\n@/\n\n@add_reminder\nTimeline Management - Track deadlines and milestones\n@/\n\n@add_reminder\nBudget Oversight - Monitor financial constraints and expenditures\n@/\n\nDone.`,
      ),
      ...buildFreeTextEvents(
        '\n\nDone.',
        `Setting up reminders.\n\n@add_reminder\nGoals Tracking - Monitor project objectives and outcomes\n@/\n\n@add_reminder\nTimeline Management - Track deadlines and milestones\n@/\n\n@add_reminder\nBudget Oversight - Monitor financial constraints and expenditures\n@/\n\nDone.`,
      ),
    ],
  );

  // Test 14: @ in body should NOT trigger calls - only @ at line start triggers calls
  // This tests the scenario where assistant mentions @types in text, then @fuxi in text
  // Neither should trigger calls since they're in body text, not at line start
  await runTest(
    '@ in body text should not trigger calls',
    `I don't see a teammate named \`@types\` in my directory. Here's who I have available:

**Team:**
- \`@fuxi\` - Fuxi
- \`@pangu\` (self) - Pangu (that's me!)

Would you like me to reach out to \`@fuxi\` instead?`,
    buildFreeTextEvents(
      `I don't see a teammate named \`@types\` in my directory. Here's who I have available:\n\n**Team:**\n- \`@fuxi\` - Fuxi\n- \`@pangu\` (self) - Pangu (that's me!)\n\nWould you like me to reach out to \`@fuxi\` instead?`,
      `I don't see a teammate named \`@types\` in my directory. Here's who I have available:\n\n**Team:**\n- \`@fuxi\` - Fuxi\n- \`@pangu\` (self) - Pangu (that's me!)\n\nWould you like me to reach out to \`@fuxi\` instead?`,
    ),
  );

  // Test 15: Stray @ should remain free text (no call events)
  await runTest(
    'Stray @ should not start a call',
    'Please avoid the @ symbol in responses.\nThanks.',
    buildFreeTextEvents(
      'Please avoid the @ symbol in responses.\nThanks.',
      'Please avoid the @ symbol in responses.\nThanks.',
    ),
  );

  // Test 16: Mention ending with dot should be parsed (trailing dot ignored)
  await runTest(
    'Trailing dot mention should be parsed',
    '@pangu.\nNext line.',
    buildBasicCallEvents('pangu', '@pangu.', 'Next line.', '@pangu.\nNext line.'),
  );

  // Test 17: change_mind blocks + @human + tool call
  const changeMindBlocksInput = `@change_mind !goals
- 扫描 \`dominds/\`（推测为 \`.minds/\`）目录下已开发代码与文档，提炼为 DevOps 团队创建的参考依据
- 若目录名有误，向用户确认正确路径
@change_mind !constraints
- 不使用通用文件工具操作 \`*.tsk/\`
- 仅能在 \`.minds/\` 下读写与管理团队相关内容
- 需要澄清 \`dominds/\` 是否等同于 \`.minds/\`
@change_mind !progress
- 已创建差遣牒三分段，待开始扫描目录

@human 我将先扫描 \`.minds/\` 目录结构并读取相关文档。请确认你说的 \`dominds/\` 是否指 \`.minds/\`？如果不是，请给出准确路径。

@team_mgmt_list_dir`;

  await runTest('change_mind blocks then @human then tool', changeMindBlocksInput, [
    ...buildBasicCallEvents(
      'change_mind',
      '@change_mind !goals',
      '- 扫描 `dominds/`（推测为 `.minds/`）目录下已开发代码与文档，提炼为 DevOps 团队创建的参考依据\n- 若目录名有误，向用户确认正确路径\n',
      changeMindBlocksInput,
    ),
    ...buildBasicCallEvents(
      'change_mind',
      '@change_mind !constraints',
      '- 不使用通用文件工具操作 `*.tsk/`\n- 仅能在 `.minds/` 下读写与管理团队相关内容\n- 需要澄清 `dominds/` 是否等同于 `.minds/`\n',
      changeMindBlocksInput,
    ),
    ...buildBasicCallEvents(
      'change_mind',
      '@change_mind !progress',
      '- 已创建差遣牒三分段，待开始扫描目录\n\n',
      changeMindBlocksInput,
    ),
    ...buildBasicCallEvents(
      'human',
      '@human 我将先扫描 `.minds/` 目录结构并读取相关文档。请确认你说的 `dominds/` 是否指 `.minds/`？如果不是，请给出准确路径。',
      '',
      changeMindBlocksInput,
    ),
    ...buildBasicCallEvents('team_mgmt_list_dir', '@team_mgmt_list_dir', '', changeMindBlocksInput),
  ]);

  // Test 18: change_mind blocks + @human (no trailing tool call)
  const changeMindBlocksInputNoTool = `@change_mind !goals
- 扫描 \`dominds/\` 目录下已开发的代码与文档，提炼为 DevOps 团队创建的参考依据
- 若目录名有误，向用户确认正确路径
@change_mind !constraints
- 不使用通用文件工具操作 \`*.tsk/\`
- 仅能在 \`.minds/\` 下读写与管理团队相关内容
- 需要澄清 \`dominds/\` 是否等同于 \`.minds/\`
@change_mind !progress
- 已记录用户需求，待确认 \`dominds/\` 的准确路径

@human 我只能访问 \`.minds/\`。你说的 \`dominds/\` 是否等同于 \`.minds/\`？如果不是，请给出准确路径或允许我访问对应目录。`;

  await runTest('change_mind blocks then @human (no tool)', changeMindBlocksInputNoTool, [
    ...buildBasicCallEvents(
      'change_mind',
      '@change_mind !goals',
      '- 扫描 `dominds/` 目录下已开发的代码与文档，提炼为 DevOps 团队创建的参考依据\n- 若目录名有误，向用户确认正确路径\n',
      changeMindBlocksInputNoTool,
    ),
    ...buildBasicCallEvents(
      'change_mind',
      '@change_mind !constraints',
      '- 不使用通用文件工具操作 `*.tsk/`\n- 仅能在 `.minds/` 下读写与管理团队相关内容\n- 需要澄清 `dominds/` 是否等同于 `.minds/`\n',
      changeMindBlocksInputNoTool,
    ),
    ...buildBasicCallEvents(
      'change_mind',
      '@change_mind !progress',
      '- 已记录用户需求，待确认 `dominds/` 的准确路径\n\n',
      changeMindBlocksInputNoTool,
    ),
    ...buildBasicCallEvents(
      'human',
      '@human 我只能访问 `.minds/`。你说的 `dominds/` 是否等同于 `.minds/`？如果不是，请给出准确路径或允许我访问对应目录。',
      '',
      changeMindBlocksInputNoTool,
    ),
  ]);

  if (failedCnt <= 0) {
    console.log(`\n🎉 All ${totalCnt} tests passed!`);
  } else {
    console.error(`\n❌ ${failedCnt}/${totalCnt} tests failed!`);
  }
}

// Run all tests
runAllTests().catch((err) => {
  console.error('Error running tests:', err);
  console.error('Stack trace:', err.stack);
  process.stdout.write('', () => process.stderr.write('', () => process.exit(1)));
});
