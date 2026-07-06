import assert from 'node:assert/strict';
import YAML from 'yaml';
import { CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK } from '../../main/llm/api-quirks';
import { readBuiltinDefaultsYamlRaw, type ProviderConfig } from '../../main/llm/client';
import { resolveCodexInstructions } from '../../main/llm/gen/codex';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object at ${at}`);
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const originalWorkLanguage = getWorkLanguage();
  try {
    setWorkLanguage('en');

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

    const literalMarker =
      '@inline-builtin-prompt-marker\n\n### Persona\n- Follow local team rules.';
    assert.equal(
      resolveCodexInstructions(literalMarker),
      literalMarker,
      'Dominds should not special-case arbitrary inline marker text at all',
    );

    const codexProviderWithoutGuard = {
      name: 'Codex test',
      apiType: 'codex',
      baseUrl: 'https://chatgpt.example.invalid/backend-api/',
      apiKeyEnvVar: 'CODEX_HOME',
      models: {},
    } satisfies ProviderConfig;
    assert.equal(
      resolveCodexInstructions(custom, codexProviderWithoutGuard),
      custom,
      'codex wrapper should not append the guard unless the provider quirk is configured',
    );

    const codexProviderWithGuard = {
      name: 'Codex test',
      apiType: 'codex',
      apiQuirks: [CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK],
      baseUrl: 'https://chatgpt.example.invalid/backend-api/',
      apiKeyEnvVar: 'CODEX_HOME',
      models: {},
    } satisfies ProviderConfig;
    const guardedFallback = resolveCodexInstructions('', codexProviderWithGuard);
    assert.ok(
      guardedFallback.startsWith('You are Codex CLI.\n\n## Reasoning Completion Guard\n'),
      'codex anti-early-finalization quirk should append a dedicated English instructions section',
    );
    assert.ok(
      guardedFallback.includes(
        'Please spend at least a minute reasoning before each response. Think long and hard. Prove both sufficiency and necessity before giving the answer for this turn.',
      ),
      'English guard should preserve the empirically useful reasoning-duration nudge',
    );
    assert.ok(
      !guardedFallback.includes('请在每轮作答前至少花一分钟推理'),
      'English guard should not silently append the Chinese guard body',
    );

    const guardedCustom = resolveCodexInstructions(custom, codexProviderWithGuard);
    assert.ok(
      guardedCustom.startsWith(`${custom}\n\n## Reasoning Completion Guard\n`),
      'codex anti-early-finalization quirk should preserve the original custom prompt verbatim',
    );

    setWorkLanguage('zh');
    const guardedCustomZh = resolveCodexInstructions(custom, codexProviderWithGuard);
    assert.ok(
      guardedCustomZh.startsWith(`${custom}\n\n## 每轮作答前的推理完成检查\n`),
      'codex anti-early-finalization quirk should use a Chinese guard for zh work language',
    );
    assert.ok(
      guardedCustomZh.includes(
        '请在每轮作答前至少花一分钟推理。深入而充分地思考。在给出本轮答案前，证明充分性和必要性。',
      ),
      'Chinese guard should preserve the empirically useful reasoning-duration nudge',
    );
    assert.ok(
      !guardedCustomZh.includes('Please spend at least a minute reasoning before each response'),
      'Chinese guard should not silently append the English guard body',
    );

    setWorkLanguage('en');
    const codexProviderWithStringGuard = {
      ...codexProviderWithoutGuard,
      apiQuirks: CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK,
    } satisfies ProviderConfig;
    assert.ok(
      resolveCodexInstructions(custom, codexProviderWithStringGuard).includes(
        '## Reasoning Completion Guard',
      ),
      'codex anti-early-finalization quirk should accept string shorthand apiQuirks',
    );

    const openAiProviderWithCodexGuardName = {
      ...codexProviderWithoutGuard,
      apiType: 'openai',
      apiQuirks: [CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK],
    } satisfies ProviderConfig;
    assert.equal(
      resolveCodexInstructions(custom, openAiProviderWithCodexGuardName),
      custom,
      'codex anti-early-finalization quirk should stay scoped to apiType=codex',
    );

    const defaultsRaw = await readBuiltinDefaultsYamlRaw();
    const parsed = asRecord(YAML.parse(defaultsRaw), 'defaults.yaml');
    const providers = asRecord(parsed['providers'], 'defaults.yaml.providers');
    const codex = asRecord(providers['codex'], 'defaults.yaml.providers.codex');
    assert.deepEqual(
      codex['apiQuirks'],
      [CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK],
      'built-in codex provider should enable the anti-early-finalization quirk by default',
    );
  } finally {
    setWorkLanguage(originalWorkLanguage);
  }

  console.log('✓ Codex instructions mapping test passed');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
