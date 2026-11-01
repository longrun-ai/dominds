import assert from 'node:assert/strict';
import YAML from 'yaml';
import { CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK } from '../../main/llm/api-quirks';
import { readBuiltinDefaultsYamlRaw, type ProviderConfig } from '../../main/llm/client';
import {
  CodexGen,
  resolveCodexInstructions,
  resolveCodexReasoningEffortForRequest,
} from '../../main/llm/gen/codex';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

function asRecord(value: unknown, at: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), at);
  return value as Record<string, unknown>;
}
async function main() {
  const evidence = semanticEvidenceCollector('dominds-provider-instructions-');
  const oldLanguage = getWorkLanguage();
  const plain: ProviderConfig = {
    name: 'Supplied Codex provider',
    apiType: 'codex',
    baseUrl: 'https://example.invalid/backend-api/',
    apiKeyEnvVar: 'DOMINDS_TEST_UNUSED_KEY',
    models: {},
  };
  const guarded: ProviderConfig = {
    ...plain,
    apiQuirks: [CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK],
  };
  const record = (
    id: string,
    scenario: string,
    text: string,
    context: Record<string, string | number | boolean>,
  ) =>
    evidence.record({
      id,
      scenario,
      businessValue:
        'Provider-specific guidance and configuration remain usable while custom system data survives unchanged.',
      context: {
        ...context,
        scope:
          'Actual local instruction/configuration resolver only. No live request, model compliance, elapsed reasoning-time guarantee or browser rendering is established.',
      },
      reviewQuestions: [
        'Given the actual provider, language and supplied data, is the complete output accurate, understandable and scoped without contradictory instructions or claims of guaranteed model behavior?',
      ],
      actualText: text,
    });
  try {
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      for (const [id, input] of [
        ['empty', ''],
        ['whitespace', '   \n\t  '],
      ] as const) {
        record(
          language + '-fallback-' + id,
          'Blank system input selects actual fallback guidance.',
          resolveCodexInstructions(input),
          { language, input, quirk: false },
        );
        record(
          language + '-guarded-fallback-' + id,
          'Blank system input selects fallback plus the configured provider instruction quirk.',
          resolveCodexInstructions(input, guarded),
          { language, input, quirk: true },
        );
      }
      for (const input of [
        'System line 1\n\nSystem line 2',
        '  keep leading whitespace',
        '@inline-builtin-prompt-marker\n\n### Persona\n- Follow local team rules.',
      ]) {
        // Supplied opaque input fidelity, not an oracle for its meaning.
        assert.equal(resolveCodexInstructions(input), input);
        assert.equal(resolveCodexInstructions(input, plain), input);
        assert.equal(
          resolveCodexInstructions(input, {
            ...plain,
            apiType: 'openai',
            apiQuirks: [CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK],
          }),
          input,
        );
      }
      const custom = 'System line 1\n\nSystem line 2';
      for (const [kind, config] of [
        ['array', guarded],
        ['string', { ...plain, apiQuirks: CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK }],
      ] as const) {
        const actual = resolveCodexInstructions(custom, config);
        assert.equal(actual.slice(0, custom.length), custom);
        record(
          language + '-guarded-custom-' + kind,
          'The configured quirk appends guidance while preserving the complete supplied system prefix.',
          actual,
          { language, custom, quirkRepresentation: kind, apiType: config.apiType },
        );
      }
    }
    setWorkLanguage('en');
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      assert.equal(resolveCodexReasoningEffortForRequest(model, 'max'), 'max');
      for (const effort of ['none', 'minimal'] as const) {
        assert.throws(
          () => resolveCodexReasoningEffortForRequest(model, effort),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            record(
              model + '-' + effort,
              'A disallowed reasoning effort is refused locally for this configured model family.',
              error.message,
              { model, effort },
            );
            return true;
          },
        );
      }
    }
    const policyError = Object.assign(new Error('supplied-policy-error-data:16ce'), {
      code: 'DOMINDS_CODEX_PROVIDER_AUTH_POLICY',
    });
    assert.deepEqual(new CodexGen().classifyFailure(policyError), {
      kind: 'fatal',
      message: policyError.message,
      code: policyError.code,
    });
    const providers = asRecord(
      asRecord(YAML.parse(await readBuiltinDefaultsYamlRaw()), 'defaults')['providers'],
      'providers',
    );
    const values = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const [key, ids, limits] of [
      [
        'codex',
        ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        {
          optimal_max_tokens: 200000,
          caution_remediation_cadence_generations: 10,
          context_length: 272000,
          input_length: 272000,
          output_length: 32768,
        },
      ],
      [
        'openai',
        ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        {
          optimal_max_tokens: 600000,
          critical_max_tokens: 922000,
          caution_remediation_cadence_generations: 10,
          context_length: 1050000,
          input_length: 1050000,
          output_length: 128000,
        },
      ],
    ] as const) {
      const config = asRecord(providers[key], key);
      const options = asRecord(
        asRecord(config['model_param_options'], 'options')[key],
        'namespace',
      );
      assert.deepEqual(asRecord(options['reasoning_effort'], 'reasoning_effort')['values'], values);
      const models = asRecord(config['models'], 'models');
      const actual: Record<string, unknown> = {};
      for (const id of ids) {
        const model = asRecord(models[id], id);
        for (const [field, expected] of Object.entries(limits))
          assert.equal(model[field], expected, id + '.' + field);
        actual[id] = model;
      }
      if (key === 'codex') {
        assert.equal(models['gpt-5.6'], undefined);
        assert.deepEqual(config['apiQuirks'], [CODEX_ANTI_EARLY_FINALIZATION_API_QUIRK]);
      }
      record(
        'builtin-catalog-' + key,
        'Actual model identifiers, display labels and capacity descriptions from the built-in provider catalog.',
        JSON.stringify(actual, null, 2),
        {
          provider: key,
          scopeDetail:
            'Numeric thresholds and identifiers are current repository configuration contracts, not independently verified vendor specifications. Labels/descriptions are judged as actual text, not frozen sentences.',
        },
      );
    }
  } finally {
    setWorkLanguage(oldLanguage);
  }
  await evidence.write();
  console.log(
    'Provider instruction data preservation, configured choices and catalog contracts: PASS',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
