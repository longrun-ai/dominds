import type { TellaskCallValidation, TellaskEventsReceiver } from 'dominds/tellask';
import { TellaskStreamParser } from 'dominds/tellask';

type RecordedEvent =
  | { type: 'markdownStart' }
  | { type: 'markdownChunk'; chunk: string }
  | { type: 'markdownFinish' }
  | { type: 'callStart'; validation: TellaskCallValidation }
  | { type: 'callHeadLineChunk'; chunk: string }
  | { type: 'callHeadLineFinish' }
  | { type: 'callBodyStart' }
  | { type: 'callBodyChunk'; chunk: string }
  | { type: 'callBodyFinish' }
  | { type: 'callFinish'; callId: string };

type ExpectedEvent =
  | Exclude<RecordedEvent, { type: 'callFinish' }>
  | { type: 'callFinish'; callId?: string };

class MockTellaskEventsReceiver implements TellaskEventsReceiver {
  public readonly events: RecordedEvent[] = [];

  async markdownStart(): Promise<void> {
    this.events.push({ type: 'markdownStart' });
  }
  async markdownChunk(chunk: string): Promise<void> {
    this.events.push({ type: 'markdownChunk', chunk });
  }
  async markdownFinish(): Promise<void> {
    this.events.push({ type: 'markdownFinish' });
  }

  async callStart(validation: TellaskCallValidation): Promise<void> {
    this.events.push({ type: 'callStart', validation });
  }
  async callHeadLineChunk(chunk: string): Promise<void> {
    this.events.push({ type: 'callHeadLineChunk', chunk });
  }
  async callHeadLineFinish(): Promise<void> {
    this.events.push({ type: 'callHeadLineFinish' });
  }

  async callBodyStart(): Promise<void> {
    this.events.push({ type: 'callBodyStart' });
  }
  async callBodyChunk(chunk: string): Promise<void> {
    this.events.push({ type: 'callBodyChunk', chunk });
  }
  async callBodyFinish(): Promise<void> {
    this.events.push({ type: 'callBodyFinish' });
  }

  async callFinish(callId: string): Promise<void> {
    this.events.push({ type: 'callFinish', callId });
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual:   ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

function canonicalizeEvents(events: RecordedEvent[]): RecordedEvent[] {
  const out: RecordedEvent[] = [];

  let markdown: string | null = null;
  let headline: string | null = null;
  let body: string | null = null;

  const flushMarkdown = (): void => {
    if (markdown === null) return;
    out.push({ type: 'markdownStart' });
    if (markdown.length > 0) out.push({ type: 'markdownChunk', chunk: markdown });
    out.push({ type: 'markdownFinish' });
    markdown = null;
  };

  const flushHeadline = (): void => {
    if (headline === null) return;
    if (headline.length > 0) out.push({ type: 'callHeadLineChunk', chunk: headline });
    out.push({ type: 'callHeadLineFinish' });
    headline = null;
  };

  const flushBody = (): void => {
    if (body === null) return;
    out.push({ type: 'callBodyStart' });
    if (body.length > 0) out.push({ type: 'callBodyChunk', chunk: body });
    out.push({ type: 'callBodyFinish' });
    body = null;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'markdownStart':
        markdown = '';
        break;
      case 'markdownChunk':
        if (markdown === null) markdown = '';
        markdown += ev.chunk;
        break;
      case 'markdownFinish':
        flushMarkdown();
        break;

      case 'callStart':
        flushMarkdown();
        out.push(ev);
        break;

      case 'callHeadLineChunk':
        if (headline === null) headline = '';
        headline += ev.chunk;
        break;
      case 'callHeadLineFinish':
        flushHeadline();
        break;

      case 'callBodyStart':
        if (body === null) body = '';
        break;
      case 'callBodyChunk':
        if (body === null) body = '';
        body += ev.chunk;
        break;
      case 'callBodyFinish':
        flushBody();
        break;

      case 'callFinish':
        flushHeadline();
        flushBody();
        out.push(ev);
        break;
    }
  }

  flushMarkdown();
  flushHeadline();
  flushBody();
  return out;
}

function assertEvents(actual: RecordedEvent[], expected: ExpectedEvent[], name: string): void {
  const canonicalActual = canonicalizeEvents(actual);
  const canonicalExpected: ExpectedEvent[] = expected;

  if (canonicalActual.length !== canonicalExpected.length) {
    throw new Error(
      `${name}: event length mismatch\nExpected: ${canonicalExpected.length}\nActual:   ${canonicalActual.length}\nActual:   ${JSON.stringify(canonicalActual, null, 2)}`,
    );
  }

  for (let i = 0; i < canonicalExpected.length; i += 1) {
    const e = canonicalExpected[i];
    const a = canonicalActual[i];
    if (a.type !== e.type) {
      throw new Error(
        `${name}: event[${i}] type mismatch\nExpected: ${e.type}\nActual:   ${a.type}\nActual:   ${JSON.stringify(canonicalActual, null, 2)}`,
      );
    }

    if (a.type === 'callFinish') {
      if (e.type !== 'callFinish') throw new Error(`${name}: unreachable compare branch`);
      if (e.callId !== undefined) {
        assertEqual(a.callId, e.callId, `${name}: callFinish.callId mismatch at index ${i}`);
      }
      continue;
    }

    assertEqual(a, e, `${name}: event mismatch at index ${i}`);
  }
}

async function runTest(name: string, input: string, expected: ExpectedEvent[]): Promise<void> {
  const receiver = new MockTellaskEventsReceiver();
  const parser = new TellaskStreamParser(receiver);

  const TEST_UPSTREAM_CHUNK = 3;
  for (let i = 0; i < input.length; i += TEST_UPSTREAM_CHUNK) {
    await parser.takeUpstreamChunk(input.slice(i, i + TEST_UPSTREAM_CHUNK));
  }
  await parser.finalize();

  assertEvents(receiver.events, expected, name);
}

async function main(): Promise<void> {
  await runTest('markdown only', 'hello\nworld\n', [
    { type: 'markdownStart' },
    { type: 'markdownChunk', chunk: 'hello\nworld\n' },
    { type: 'markdownFinish' },
  ]);

  await runTest(
    'single tellask call with body',
    'before\n!?@pangu do\n!?body 1\n!?body 2\nafter\n',
    [
      { type: 'markdownStart' },
      { type: 'markdownChunk', chunk: 'before\n' },
      { type: 'markdownFinish' },
      { type: 'callStart', validation: { kind: 'valid', firstMention: 'pangu' } },
      { type: 'callHeadLineChunk', chunk: '@pangu do\n' },
      { type: 'callHeadLineFinish' },
      { type: 'callBodyStart' },
      { type: 'callBodyChunk', chunk: 'body 1\nbody 2\n' },
      { type: 'callBodyFinish' },
      { type: 'callFinish' },
      { type: 'markdownStart' },
      { type: 'markdownChunk', chunk: 'after\n' },
      { type: 'markdownFinish' },
    ],
  );

  await runTest('multiline headline', '!?@pangu first\n!?@ more\n!?body\n', [
    { type: 'callStart', validation: { kind: 'valid', firstMention: 'pangu' } },
    { type: 'callHeadLineChunk', chunk: '@pangu first\n@ more\n' },
    { type: 'callHeadLineFinish' },
    { type: 'callBodyStart' },
    { type: 'callBodyChunk', chunk: 'body\n' },
    { type: 'callBodyFinish' },
    { type: 'callFinish' },
  ]);

  await runTest('body can contain @ after body started', '!?@pangu h\n!?b\n!?@still body\n', [
    { type: 'callStart', validation: { kind: 'valid', firstMention: 'pangu' } },
    { type: 'callHeadLineChunk', chunk: '@pangu h\n' },
    { type: 'callHeadLineFinish' },
    { type: 'callBodyStart' },
    { type: 'callBodyChunk', chunk: 'b\n@still body\n' },
    { type: 'callBodyFinish' },
    { type: 'callFinish' },
  ]);

  await runTest('malformed first line (missing !?@)', '!?hello\n!?body\n', [
    { type: 'callStart', validation: { kind: 'malformed', reason: 'missing_mention_prefix' } },
    { type: 'callHeadLineChunk', chunk: 'hello\n' },
    { type: 'callHeadLineFinish' },
    { type: 'callBodyStart' },
    { type: 'callBodyChunk', chunk: 'body\n' },
    { type: 'callBodyFinish' },
    { type: 'callFinish' },
  ]);

  await runTest('malformed invalid mention id', '!?@.\n!?body\n', [
    { type: 'callStart', validation: { kind: 'malformed', reason: 'invalid_mention_id' } },
    { type: 'callHeadLineChunk', chunk: '@.\n' },
    { type: 'callHeadLineFinish' },
    { type: 'callBodyStart' },
    { type: 'callBodyChunk', chunk: 'body\n' },
    { type: 'callBodyFinish' },
    { type: 'callFinish' },
  ]);

  await runTest('two calls separated by non-!? lines', '!?@a one\nseparator\n!?@b two\n', [
    { type: 'callStart', validation: { kind: 'valid', firstMention: 'a' } },
    { type: 'callHeadLineChunk', chunk: '@a one\n' },
    { type: 'callHeadLineFinish' },
    { type: 'callFinish' },
    { type: 'markdownStart' },
    { type: 'markdownChunk', chunk: 'separator\n' },
    { type: 'markdownFinish' },
    { type: 'callStart', validation: { kind: 'valid', firstMention: 'b' } },
    { type: 'callHeadLineChunk', chunk: '@b two\n' },
    { type: 'callHeadLineFinish' },
    { type: 'callFinish' },
  ]);

  console.log('tellask parsing tests: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tellask parsing tests: FAIL\n${message}`);
  process.exit(1);
});
