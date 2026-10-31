import { formatContextUsageTitle, type ContextUsageTitleArgs } from '../../webapp/src/i18n/ui';
import { writeSemanticEvidence, type SemanticEvidence } from '../helpers/semantic-evidence';

async function main() {
  const base = {
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
  const { reasoningTokens: _reasoningTokens, ...withoutReasoning } = base;
  const inputs: { id: string; args: ContextUsageTitleArgs; givenFacts: string }[] = [
    {
      id: 'known-reasoning',
      args: base,
      givenFacts:
        'Prompt=42000, reasoning=516, supplied hard usage15%, window272K, healthy. Soft threshold200000/74% is configured; critical threshold244800/90% is default.',
    },
    {
      id: 'known-no-reasoning',
      args: withoutReasoning,
      givenFacts:
        'The known-state prompt/window/threshold facts remain. No reasoning usage was supplied; absence must not become an observed zero.',
    },
    {
      id: 'unknown-with-usage',
      args: { kind: 'unknown', promptTokens: 42_000, reasoningTokens: 516 },
      givenFacts:
        'The context status/window/thresholds are unavailable, but prompt42000 and reasoning516 were supplied.',
    },
    {
      id: 'unknown-no-usage',
      args: { kind: 'unknown' },
      givenFacts:
        'No context status/window/threshold or usage numbers were supplied. Do not invent zero or an observed healthy state.',
    },
    {
      id: 'known-caution',
      args: { ...base, promptTokens: 210_000, hardPercentText: '77%', level: 'caution' },
      givenFacts:
        'Supplied caution state: prompt210000, reasoning516, hard usage77%, window272K. Soft configured200000/74%; critical default244800/90%.',
    },
    {
      id: 'known-critical',
      args: { ...base, promptTokens: 250_000, hardPercentText: '92%', level: 'critical' },
      givenFacts:
        'Supplied critical state: prompt250000, reasoning516, hard usage92%, window272K. Soft configured200000/74%; critical default244800/90%.',
    },
    {
      id: 'unknown-observed-zero',
      args: { kind: 'unknown', promptTokens: 0, reasoningTokens: 0 },
      givenFacts:
        'Context limits/status remain unavailable. Both prompt and reasoning usage were explicitly observed as zero, distinct from missing usage.',
    },
  ];
  const evidence: SemanticEvidence[] = [];
  for (const language of ['en', 'zh'] as const) {
    for (const { id, args, givenFacts } of inputs) {
      evidence.push({
        id: language + '-' + id,
        scenario:
          'Format the actual context-usage title from supplied availability, counts, health and threshold facts.',
        businessValue:
          'Show available prompt/reasoning usage and context boundaries accurately without confusing missing data, zero usage, threshold configuration and current measured usage.',
        context: {
          language,
          args: JSON.stringify(args),
          givenFacts,
          scope:
            'Actual title formatter only. Counts, percentages, levels and threshold provenance are declared inputs, not calculated pressure, live provider measurement, DOM rendering or a browser interaction.',
        },
        reviewQuestions: [
          'Does the actual title accurately convey known/unknown state and the supplied prompt/reasoning facts, preserving the distinction between missing and explicitly zero usage?',
          'Where thresholds are supplied, are current usage, model limit, soft/critical boundaries and configured/default provenance understandable and consistent with the input, without inventing additional observations?',
        ],
        actualText: formatContextUsageTitle(language, args),
      });
    }
  }
  await writeSemanticEvidence(evidence, 'dominds-context-title-');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
