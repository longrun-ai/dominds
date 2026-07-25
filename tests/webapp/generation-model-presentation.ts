import assert from 'node:assert/strict';

import { formatGenerationModelPresentation } from '../../webapp/src/components/generation-model-presentation';

const presentation = formatGenerationModelPresentation({
  providerId: 'codex',
  modelId: 'gpt-5.6-sol',
  configuredModelId: 'gpt-5.6-sol',
  prominentModelParams: [
    {
      kind: 'set',
      namespace: 'codex',
      key: 'reasoning_effort',
      value: 'high',
      description: 'Reasoning effort level.',
    },
    {
      kind: 'unset',
      namespace: 'codex',
      key: 'service_tier',
      documentedDefault: 'auto',
      documentedDefaultLabel: 'Standard',
      description: 'Processing tier.',
    },
    {
      kind: 'set',
      namespace: 'codex',
      key: 'verbosity',
      value: 'medium',
      description: 'Response detail level.',
    },
  ],
});

assert.equal(
  presentation.compactLabel,
  'codex/gpt-5.6-sol·high·unset·medium',
  'compact label should use provider/model followed by prominent values only',
);
assert.equal(
  presentation.tooltip,
  [
    'provider-id: codex',
    'model-id: gpt-5.6-sol',
    'configured-model-id: gpt-5.6-sol',
    '',
    'codex.reasoning_effort: high',
    'Reasoning effort level.',
    '',
    'codex.service_tier: unset',
    'Processing tier.',
    'documented-default: auto (Standard)',
    '',
    'codex.verbosity: medium',
    'Response detail level.',
  ].join('\n'),
  'tooltip should explain the exact identity, field paths, values, descriptions, and defaults',
);

console.log('webapp generation model presentation: PASS');
