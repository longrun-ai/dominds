import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { readBuiltinDefaultsYamlRaw } from '../../main/llm/client';
import { resolveCodexServiceTier } from '../../main/llm/gen/codex';
import { buildSetupStatusResponse, handleWriteTeamYaml } from '../../main/server/setup-routes';

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object at ${at}`);
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  assert.equal(resolveCodexServiceTier(undefined), undefined);
  assert.equal(resolveCodexServiceTier(null), undefined);
  assert.equal(resolveCodexServiceTier('default'), undefined);
  assert.equal(resolveCodexServiceTier('auto'), 'auto');
  assert.equal(resolveCodexServiceTier('priority'), 'priority');
  assert.equal(resolveCodexServiceTier('flex'), 'flex');
  assert.equal(resolveCodexServiceTier('scale'), 'scale');

  const defaultsRaw = await readBuiltinDefaultsYamlRaw();
  const parsed = asRecord(YAML.parse(defaultsRaw), 'defaults.yaml');
  const providers = asRecord(parsed['providers'], 'defaults.yaml.providers');
  const codex = asRecord(providers['codex'], 'defaults.yaml.providers.codex');
  const modelParamOptions = asRecord(
    codex['model_param_options'],
    'defaults.yaml.providers.codex.model_param_options',
  );
  const codexOptions = asRecord(
    modelParamOptions['codex'],
    'defaults.yaml.providers.codex.model_param_options.codex',
  );
  const serviceTier = asRecord(
    codexOptions['service_tier'],
    'defaults.yaml.providers.codex.model_param_options.codex.service_tier',
  );

  assert.deepEqual(serviceTier['values'], ['auto', 'priority']);
  assert.deepEqual(serviceTier['value_labels'], {
    auto: 'Standard',
    priority: 'Fast',
  });
  assert.equal(serviceTier['default'], undefined);

  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-codex-service-tier-'));
  try {
    process.chdir(tmpRoot);

    const setupStatus = await buildSetupStatusResponse();
    assert.equal(setupStatus.success, true);
    const codexProvider = setupStatus.providers.find(
      (provider) => provider.providerKey === 'codex',
    );
    assert.ok(codexProvider, 'codex provider should be present in setup status');
    const setupServiceTier = codexProvider.prominentModelParams?.find(
      (param) => param.namespace === 'codex' && param.key === 'service_tier',
    );
    assert.ok(setupServiceTier, 'setup status should expose codex.service_tier');
    assert.equal(setupServiceTier.kind, 'enum');
    assert.equal(setupServiceTier.defaultValue, undefined);
    if (setupServiceTier.kind !== 'enum') {
      throw new Error('codex.service_tier should be an enum prominent setup param');
    }
    assert.deepEqual(setupServiceTier.values, ['auto', 'priority']);

    const volcanoProvider = setupStatus.providers.find(
      (provider) => provider.providerKey === 'volcano-engine-coding-plan',
    );
    assert.ok(volcanoProvider, 'volcano coding-plan provider should be present in setup status');
    const setupThinking = volcanoProvider.prominentModelParams?.find(
      (param) => param.namespace === 'anthropic-compatible' && param.key === 'thinking',
    );
    assert.ok(setupThinking, 'setup status should expose anthropic-compatible.thinking');
    assert.equal(setupThinking.kind, 'boolean');

    const writeResult = await handleWriteTeamYaml(
      JSON.stringify({
        provider: 'codex',
        model: 'gpt-5.4',
        overwrite: false,
        modelParams: {
          codex: {
            service_tier: '',
            reasoning_effort: 'high',
          },
        },
      }),
    );
    assert.equal(writeResult.kind, 'ok');

    const writtenRaw = await fs.readFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'utf-8');
    const written = asRecord(YAML.parse(writtenRaw), 'written team.yaml');
    const memberDefaults = asRecord(
      written['member_defaults'],
      'written team.yaml.member_defaults',
    );
    const modelParams = asRecord(
      memberDefaults['model_params'],
      'written team.yaml.member_defaults.model_params',
    );
    const writtenCodex = asRecord(
      modelParams['codex'],
      'written team.yaml.member_defaults.model_params.codex',
    );
    assert.equal(writtenCodex['service_tier'], undefined);
    assert.equal(writtenCodex['reasoning_effort'], 'high');

    const writeThinkingResult = await handleWriteTeamYaml(
      JSON.stringify({
        provider: 'volcano-engine-coding-plan',
        model: 'doubao-seed-2.0-code',
        overwrite: true,
        modelParams: {
          'anthropic-compatible': {
            thinking: true,
          },
        },
      }),
    );
    assert.equal(writeThinkingResult.kind, 'ok');
    const writtenThinkingRaw = await fs.readFile(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      'utf-8',
    );
    const writtenThinking = asRecord(YAML.parse(writtenThinkingRaw), 'thinking team.yaml');
    const thinkingMemberDefaults = asRecord(
      writtenThinking['member_defaults'],
      'thinking team.yaml.member_defaults',
    );
    const thinkingModelParams = asRecord(
      thinkingMemberDefaults['model_params'],
      'thinking team.yaml.member_defaults.model_params',
    );
    const writtenAnthropicCompatible = asRecord(
      thinkingModelParams['anthropic-compatible'],
      'thinking team.yaml.member_defaults.model_params.anthropic-compatible',
    );
    assert.equal(writtenAnthropicCompatible['thinking'], true);
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
