import { parseTeammateTellask } from '../../main/llm/driver';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual:   ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

async function main(): Promise<void> {
  assertEqual(
    parseTeammateTellask('pangu', '@pangu !tellaskSession env-check\n'),
    { type: 'B', agentId: 'pangu', tellaskSession: 'env-check' },
    'parses single !tellaskSession directive in headline',
  );

  assertEqual(
    parseTeammateTellask('pangu', '@pangu !tellaskSession env.check_1\n@ more context\n'),
    { type: 'B', agentId: 'pangu', tellaskSession: 'env.check_1' },
    'parses !tellaskSession directive across multiline headline',
  );

  assertEqual(
    parseTeammateTellask('pangu', '@pangu hello\n'),
    { type: 'C', agentId: 'pangu' },
    'no !tellaskSession => type C',
  );

  console.log('teammate tellask parsing tests: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`teammate tellask parsing tests: FAIL\n${message}`);
  process.exit(1);
});
