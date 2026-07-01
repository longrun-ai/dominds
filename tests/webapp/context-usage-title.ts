import assert from 'node:assert/strict';

import { formatContextUsageTitle } from '../../webapp/src/i18n/ui';

const baseArgs = {
  kind: 'known',
  promptTokens: 42_000,
  reasoningTokens: 516,
  hardPercentText: '15%',
  modelContextLimitTokens: 272_000,
  modelContextWindowText: '272K',
  level: 'healthy',
  optimalTokens: 200_000,
  optimalPercentText: '74%',
  optimalConfigured: true,
  criticalTokens: 244_800,
  criticalPercentText: '90%',
  criticalConfigured: false,
} as const;

async function main(): Promise<void> {
  const zh = formatContextUsageTitle('zh', baseArgs);
  assert.ok(zh.includes('推理：516'), 'zh context usage title should show reasoning tokens');
  assert.ok(zh.includes('输入：42K'), 'zh context usage title should keep prompt tokens');

  const en = formatContextUsageTitle('en', baseArgs);
  assert.ok(en.includes('Reasoning: 516'), 'en context usage title should show reasoning tokens');
  assert.ok(en.includes('Prompt: 42K'), 'en context usage title should keep prompt tokens');

  const { reasoningTokens: _reasoningTokens, ...argsWithoutReasoning } = baseArgs;
  const withoutReasoning = formatContextUsageTitle('en', argsWithoutReasoning);
  assert.equal(
    withoutReasoning.includes('Reasoning:'),
    false,
    'context usage title should omit reasoning row when provider usage does not include it',
  );

  const unknownWithReasoning = formatContextUsageTitle('en', {
    kind: 'unknown',
    promptTokens: 42_000,
    reasoningTokens: 516,
  });
  assert.ok(
    unknownWithReasoning.includes('Reasoning: 516'),
    'unknown context status should still show reasoning tokens when usage is available',
  );
  assert.ok(
    unknownWithReasoning.includes('Prompt: 42K'),
    'unknown context status should still show prompt tokens when usage is available',
  );

  const zhUnknownWithReasoning = formatContextUsageTitle('zh', {
    kind: 'unknown',
    promptTokens: 42_000,
    reasoningTokens: 516,
  });
  assert.ok(
    zhUnknownWithReasoning.includes('推理：516'),
    'zh unknown context status should still show reasoning tokens when usage is available',
  );
  assert.ok(
    zhUnknownWithReasoning.includes('输入：42K'),
    'zh unknown context status should still show prompt tokens when usage is available',
  );

  console.log('webapp context usage title reasoning tokens: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  console.error(message);
  process.exit(1);
});
