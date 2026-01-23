import { parseTeammateCall } from '../../main/llm/driver';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual:   ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

async function main(): Promise<void> {
  assertEqual(
    parseTeammateCall('pangu', '@pangu !topic env-check\n'),
    { type: 'B', agentId: 'pangu', topicId: 'env-check' },
    'parses single !topic directive in headline',
  );

  assertEqual(
    parseTeammateCall('pangu', '@pangu !topic env.check_1\n@ more context\n'),
    { type: 'B', agentId: 'pangu', topicId: 'env.check_1' },
    'parses !topic directive across multiline headline',
  );

  assertEqual(
    parseTeammateCall('pangu', '@pangu hello\n'),
    { type: 'C', agentId: 'pangu' },
    'no !topic => type C',
  );

  console.log('teammate call parsing tests: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`teammate call parsing tests: FAIL\n${message}`);
  process.exit(1);
});
