import assert from 'node:assert/strict';
import { resolveCodexInstructions, spliceCodexBuiltinPrompt } from '../../main/llm/gen/codex';

async function main(): Promise<void> {
  assert.equal(resolveCodexInstructions(''), 'You are Codex CLI.');
  assert.equal(resolveCodexInstructions('   \n\t  '), 'You are Codex CLI.');

  const custom = 'System line 1\n\nSystem line 2';
  assert.equal(
    resolveCodexInstructions(custom),
    custom,
    'codex wrapper should pass custom system prompt content through as instructions',
  );

  const spaced = '  keep leading whitespace';
  assert.equal(
    resolveCodexInstructions(spaced),
    spaced,
    'non-empty system prompt should be preserved verbatim instead of being normalized',
  );

  assert.equal(
    spliceCodexBuiltinPrompt({
      template: '@codex-system-prompt',
      defaultModel: 'gpt-5.4',
      loadPrompt: (model) => `BUILTIN:${model}`,
    }),
    'BUILTIN:gpt-5.4',
    'standalone @codex-system-prompt directive should splice the current model bundled prompt',
  );

  assert.equal(
    spliceCodexBuiltinPrompt({
      template:
        '@codex-system-prompt:gpt-5.3-codex\n\n### Local Addendum\n- Keep Dominds-specific routing rules.',
      defaultModel: 'gpt-5.4',
      loadPrompt: (model) => `BUILTIN:${model}`,
    }),
    'BUILTIN:gpt-5.3-codex\n\n### Local Addendum\n- Keep Dominds-specific routing rules.',
    '@codex-system-prompt:<model> should allow pinning a specific bundled prompt while preserving local addenda',
  );

  assert.equal(
    resolveCodexInstructions('@codex-system-prompt\n\n### Persona\n- Follow local team rules.', {
      defaultModel: 'gpt-5.4',
      loadPrompt: (model) => `BUILTIN:${model}`,
    }),
    'BUILTIN:gpt-5.4\n\n### Persona\n- Follow local team rules.',
    'resolveCodexInstructions should expand @codex-system-prompt inside non-empty custom system prompts',
  );

  console.log('✓ Codex instructions mapping test passed');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
