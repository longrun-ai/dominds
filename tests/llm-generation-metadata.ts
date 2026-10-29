import assert from 'node:assert/strict';

import type { ProviderConfig } from '../main/llm/client';
import { buildLlmGenerationMetadata } from '../main/llm/generation-metadata';
import type { Team } from '../main/team';

const providerConfig: ProviderConfig = {
  name: 'Codex test provider',
  apiType: 'codex',
  baseUrl: 'https://example.invalid',
  apiKeyEnvVar: 'TEST_KEY',
  model_param_options: {
    codex: {
      reasoning_effort: {
        type: 'enum',
        prominent: true,
        values: ['low', 'high'],
        description: 'Reasoning effort used for this generation.',
      },
      service_tier: {
        type: 'enum',
        prominent: true,
        values: ['auto', 'priority'],
        value_labels: { auto: 'Standard', priority: 'Fast' },
        default: 'auto',
        description: 'Processing tier used for this generation.',
      },
      verbosity: {
        type: 'enum',
        prominent: true,
        values: ['low', 'high'],
        description: 'Response detail level.',
      },
      temperature: {
        type: 'number',
        prominent: false,
        description: 'Sampling temperature.',
      },
    },
  },
  models: {
    configured: { name: 'Configured model' },
  },
};

const modelParams: Team.ModelParams = {
  codex: {
    reasoning_effort: 'high',
    verbosity: 'low',
  },
};

assert.deepEqual(
  buildLlmGenerationMetadata({
    providerId: ' codex ',
    configuredModelId: ' configured ',
    reportedModelId: ' reported-2026-07-25 ',
    providerConfig,
    modelParams,
  }),
  {
    providerId: 'codex',
    modelId: 'reported-2026-07-25',
    fields: [
      {
        kind: 'set',
        key: 'configured-model-id',
        prominent: false,
        value: 'configured',
      },
      {
        kind: 'set',
        key: 'codex.reasoning_effort',
        prominent: true,
        description: 'Reasoning effort used for this generation.',
        value: 'high',
      },
      {
        kind: 'unset',
        key: 'codex.service_tier',
        prominent: true,
        description: 'Processing tier used for this generation.',
        documentedDefault: 'auto',
        documentedDefaultLabel: 'Standard',
      },
      {
        kind: 'set',
        key: 'codex.verbosity',
        prominent: true,
        description: 'Response detail level.',
        value: 'low',
      },
    ],
  },
  'generation metadata should preserve provider order, actual values, and unset defaults',
);

const structuredValueMetadata = buildLlmGenerationMetadata({
  providerId: 'compatible',
  configuredModelId: 'minimax',
  reportedModelId: 'minimax',
  providerConfig: {
    ...providerConfig,
    apiType: 'openai-compatible',
    model_param_options: {
      'openai-compatible': {
        thinking: {
          type: 'object',
          prominent: true,
          description: 'Provider-specific thinking configuration.',
        },
      },
    },
  },
  modelParams: {
    'openai-compatible': {
      thinking: { type: 'adaptive' },
    },
  },
});
assert.equal(
  structuredValueMetadata.fields[1]?.kind === 'set'
    ? structuredValueMetadata.fields[1].value
    : undefined,
  '{"type":"adaptive"}',
  'structured prominent values should use stable valid JSON',
);

const extensionMetadata = buildLlmGenerationMetadata({
  providerId: 'extension-provider',
  configuredModelId: 'default',
  reportedModelId: 'default',
  providerConfig: {
    ...providerConfig,
    // Registered generators can supply API types beyond the built-in parameter namespaces.
    apiType: 'test-empty-recovery',
  } as unknown as ProviderConfig,
  modelParams: undefined,
});
assert.deepEqual(extensionMetadata, {
  providerId: 'extension-provider',
  modelId: 'default',
  fields: [{ kind: 'set', key: 'configured-model-id', prominent: false, value: 'default' }],
});

console.log('LLM generation metadata: PASS');
