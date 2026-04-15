import assert from 'node:assert/strict';
import { resolveCodexInstructions } from '../../main/llm/gen/codex';

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

  const literalMarker = '@inline-builtin-prompt-marker\n\n### Persona\n- Follow local team rules.';
  assert.equal(
    resolveCodexInstructions(literalMarker),
    literalMarker,
    'Dominds should not special-case arbitrary inline marker text at all',
  );

  console.log('✓ Codex instructions mapping test passed');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
