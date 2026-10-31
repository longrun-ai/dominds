import type { LlmGenerationMetadata } from '@longrun-ai/kernel/types/storage';
import { formatGenerationModelPresentation } from '../../webapp/src/components/generation-model-presentation';
import { writeSemanticEvidence } from '../helpers/semantic-evidence';

async function main() {
  const original: LlmGenerationMetadata = {
    providerId: 'codex',
    modelId: 'gpt-5.6-sol',
    fields: [
      { kind: 'set', key: 'configured-model-id', prominent: false, value: 'gpt-5.6-sol' },
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
  };
  const cases: { id: string; metadata: LlmGenerationMetadata; givenFacts: string }[] = [
    {
      id: 'original-prominent-and-unset',
      metadata: original,
      givenFacts:
        'Reported/configured model is gpt-5.6-sol. Reasoning effort=high and verbosity=medium are supplied values. service_tier is unset; auto/Standard is only its documented default, never evidence of a sent parameter.',
    },
    {
      id: 'reported-versus-configured',
      metadata: {
        providerId: 'provider-data:67b3',
        modelId: 'reported-model-data:ab4f',
        fields: [
          {
            kind: 'set',
            key: 'configured-model-id',
            prominent: false,
            value: 'configured-model-data:d82e',
          },
          {
            kind: 'set',
            key: 'parameter-data:choice',
            prominent: true,
            value: 'priority-data',
            valueLabel: 'Supplied choice label',
            description: 'Description supplied as configuration data.',
          },
          {
            kind: 'set',
            key: 'parameter-data:secondary',
            prominent: false,
            value: 'secondary-data:44c2',
          },
        ],
      },
      givenFacts:
        'The reported and configured model identifiers differ. The supplied choice is prominent and has its supplied label; the secondary parameter is available for detailed inspection, not prominent display.',
    },
    {
      id: 'structured-supplied-value',
      metadata: {
        providerId: 'compatible-data',
        modelId: 'model-data:structured',
        fields: [
          {
            kind: 'set',
            key: 'configured-model-id',
            prominent: false,
            value: 'model-data:structured',
          },
          {
            kind: 'set',
            key: 'openai-compatible.thinking',
            prominent: true,
            value: '{"type":"adaptive","budget":[2,8]}',
            description: 'Supplied structured thinking configuration.',
          },
          { kind: 'unset', key: 'openai-compatible.optional', prominent: true },
        ],
      },
      givenFacts:
        'The structured thinking value is supplied JSON data containing type=adaptive and budget=[2,8]. optional is unset and has no documented default; do not invent one.',
    },
    {
      id: 'no-prominent-parameters',
      metadata: {
        providerId: 'mock-data',
        modelId: 'model-data:identity-only',
        fields: [
          {
            kind: 'set',
            key: 'configured-model-id',
            prominent: false,
            value: 'model-data:identity-only',
          },
        ],
      },
      givenFacts:
        'Only provider/reported/configured identity is available. There are no prominent parameters, supplied parameter values or documented defaults.',
    },
  ];
  await writeSemanticEvidence(
    cases.map(({ id, metadata, givenFacts }) => ({
      id,
      scenario:
        'Render actual compact model identification and its detailed tooltip from the supplied public generation-metadata object.',
      businessValue:
        'Let a person inspect actual model identity and supplied parameter values without mistaking an unset value or a documented default for an observed sent parameter.',
      context: {
        metadata: JSON.stringify(metadata),
        givenFacts,
        language:
          'Current formatter uses technical English field labels and supplied descriptions.',
        scope:
          'Actual presentation formatter with declared metadata input. No provider request, generation, DOM/browser rendering, accessibility or model-availability assertion is made.',
      },
      reviewQuestions: [
        'Does the actual compact label convey reported identity and prominent values without presenting unset/default documentation as sent configuration?',
        'Does the detailed tooltip preserve the supplied identity, values/labels, descriptions and documented-default distinction clearly, without inventing missing data?',
      ],
      actualText: JSON.stringify(formatGenerationModelPresentation(metadata), null, 2),
    })),
    'dominds-model-presentation-',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
