import assert from 'node:assert/strict';

import { formatGenerationModelPresentation } from '../../webapp/src/components/generation-model-presentation';

const presentation = formatGenerationModelPresentation({
  providerId: 'codex',
  modelId: 'gpt-5.6-sol',
  fields: [
    {
      kind: 'set',
      key: 'configured-model-id',
      prominent: false,
      value: 'gpt-5.6-sol',
    },
    {
      kind: 'set',
      key: 'codex.reasoning_effort',
      prominent: true,
      value: 'high',
      description: 'Reasoning effort level.',
    },
    {
      kind: 'unset',
      key: 'codex.service_tier',
      prominent: true,
      documentedDefault: 'auto',
      documentedDefaultLabel: 'Standard',
      description: 'Processing tier.',
    },
    {
      kind: 'set',
      key: 'codex.verbosity',
      prominent: true,
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
    '',
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
