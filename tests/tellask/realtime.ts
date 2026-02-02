import type {
  CollectedTellaskCall,
  TellaskCallValidation,
  TellaskEventsReceiver,
} from 'dominds/tellask';
import { TellaskStreamParser } from 'dominds/tellask';

class OutputCollectingReceiver implements TellaskEventsReceiver {
  public markdown: string = '';

  async markdownStart(): Promise<void> {}
  async markdownChunk(chunk: string): Promise<void> {
    this.markdown += chunk;
  }
  async markdownFinish(): Promise<void> {}

  async callStart(_validation: TellaskCallValidation): Promise<void> {}
  async callHeadLineChunk(_chunk: string): Promise<void> {}
  async callHeadLineFinish(): Promise<void> {}
  async callBodyStart(): Promise<void> {}
  async callBodyChunk(_chunk: string): Promise<void> {}
  async callBodyFinish(): Promise<void> {}
  async callFinish(_call: CollectedTellaskCall, _upstreamEndOffset: number): Promise<void> {}
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual:   ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

function nextU32(seed: number): number {
  // xorshift32
  let x = seed >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

async function runWithChunks(
  input: string,
  chunkSizes: number[],
): Promise<{ markdown: string; calls: CollectedTellaskCall[] }> {
  const receiver = new OutputCollectingReceiver();
  const parser = new TellaskStreamParser(receiver);

  let pos = 0;
  for (const size of chunkSizes) {
    if (pos >= input.length) break;
    const end = Math.min(input.length, pos + size);
    await parser.takeUpstreamChunk(input.slice(pos, end));
    pos = end;
  }
  if (pos < input.length) {
    await parser.takeUpstreamChunk(input.slice(pos));
  }
  await parser.finalize();

  return { markdown: receiver.markdown, calls: parser.getCollectedCalls() };
}

async function main(): Promise<void> {
  const input = [
    'preamble: `!?@not-a-call` (mid-line)\n',
    '\n',
    '!?@pangu do something.\n',
    '!?@and continue headline with more context\n',
    '!?body line 1 with ```backticks``` and !? mid-line\n',
    '!?@this @line starts with @ but is body (because body already started)\n',
    'separator line (ends call)\n',
    '!?oops malformed first line\n',
    '!?body\n',
    '\n',
    'tail\n',
  ].join('');

  const baseline = await runWithChunks(input, [input.length]);

  let seed = 0x12345678;
  for (let iter = 0; iter < 200; iter += 1) {
    seed = nextU32(seed);
    const maxChunk = 23;
    const chunkSizes: number[] = [];
    let remaining = input.length;
    let localSeed = seed;
    while (remaining > 0) {
      localSeed = nextU32(localSeed);
      const size = (localSeed % maxChunk) + 1;
      chunkSizes.push(size);
      remaining -= size;
    }

    const out = await runWithChunks(input, chunkSizes);
    assertEqual(out.markdown, baseline.markdown, `markdown mismatch at iter=${iter}`);
    assertEqual(out.calls, baseline.calls, `calls mismatch at iter=${iter}`);
  }

  console.log('tellask realtime tests: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tellask realtime tests: FAIL\n${message}`);
  process.exit(1);
});
