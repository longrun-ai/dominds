import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Team } from '../../main/team';
import { teamMgmtListProvidersTool } from '../../main/tools/team_mgmt';
import { withManualReminderDialog } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

function providerYaml() {
  const lines = ['providers:'];
  for (let index = 1; index <= 240; index++) {
    const key = 'provider_' + String(index).padStart(3, '0');
    lines.push(
      '  ' + key + ':',
      '    name: "' + key + '"',
      '    apiType: "openai"',
      '    baseUrl: "https://example.invalid/v1"',
      '    apiKeyEnvVar: "DOMINDS_LIST_FIXTURE_' + index + '_KEY"',
      '    models:',
    );
    for (let model = 1; model <= 20; model++) {
      const id = 'model_' + String(model).padStart(3, '0');
      lines.push('      ' + id + ': { name: "' + key + '-' + id + '" }');
    }
  }
  return lines.join('\n') + '\n';
}
async function main() {
  const evidence = semanticEvidenceCollector('dominds-provider-listing-');
  for (const language of ['en', 'zh'] as const) {
    await withManualReminderDialog(language, async (dialog) => {
      const caller = new Team.Member({ id: 'tester', name: 'Tester' });
      const givenYaml = providerYaml();
      await fs.writeFile('.minds/llm.yaml', givenYaml);
      const keys = Array.from(
        { length: 240 },
        (_, index) => 'provider_' + String(index + 1).padStart(3, '0'),
      );
      const result = await teamMgmtListProvidersTool.call(dialog, caller, {
        include_builtin: false,
        include_rtws: true,
        show_models: true,
        max_models: 20,
      });
      assert.equal(result.outcome, 'success');
      // Supplied provider/model identifiers are data. Omission/readiness prose has no literal oracle.
      assert.deepEqual(
        keys.filter((key) => result.content.includes(key)),
        keys.slice(0, 80),
      );
      assert.ok(result.content.includes('model_001'));
      assert.ok(result.content.length <= 60_000);
      assert.equal(await fs.readFile('.minds/llm.yaml', 'utf8'), givenYaml);
      evidence.record({
        id: 'providers-bounded-' + language,
        scenario:
          'Actual workspace configuration declares 240 given providers, each with 20 model IDs; listing returns only the first 80 providers.',
        businessValue:
          'An agent understands incomplete provider/model display and can narrow the request to inspect an omitted provider.',
        context: {
          language,
          suppliedProviders: 240,
          shownGivenProviders: 80,
          omittedProviders: 160,
          modelsPerProvider: 20,
          firstProvider: keys[0]!,
          lastShownProvider: keys[79]!,
          omittedProvider: keys[239]!,
          declaredModelIds: JSON.stringify(
            Array.from({ length: 20 }, (_, index) => 'model_' + String(index + 1).padStart(3, '0')),
          ),
          scope:
            'Native dialog/member and actual YAML/tool; long model-ID rows may have their own inline character truncation. No provider request or credential authentication is performed.',
        },
        reviewQuestions: [
          'Does the actual full output accurately explain provider omission and any incomplete model display, with usable narrowing guidance and no claim that environment-variable presence proves working authentication?',
        ],
        actualText: result.content,
      });
      const narrowed = await teamMgmtListProvidersTool.call(dialog, caller, {
        provider_pattern: 'provider_240',
        include_builtin: false,
        include_rtws: true,
        show_models: true,
        max_models: 1,
      });
      assert.equal(narrowed.outcome, 'success');
      assert.deepEqual(
        keys.filter((key) => narrowed.content.includes(key)),
        ['provider_240'],
      );
      assert.ok(narrowed.content.includes('model_001'));
      assert.ok(!narrowed.content.includes('model_002'));
      assert.equal(await fs.readFile('.minds/llm.yaml', 'utf8'), givenYaml);
      evidence.record({
        id: 'providers-narrowed-' + language,
        scenario:
          'The suggested provider_pattern retrieves the previously omitted provider_240 with max_models=1 from 20 configured models.',
        businessValue:
          'The recovery path reaches omitted configuration without suggesting the single shown model is the full configured set.',
        context: {
          language,
          requestedProvider: 'provider_240',
          configuredModels: 20,
          requestedModelLimit: 1,
          shownModel: 'model_001',
          scope:
            'Actual listing and original YAML; no provider connection or model capability probe.',
        },
        reviewQuestions: [
          'Does the actual narrowed output correctly communicate the selected provider and limited model display?',
        ],
        actualText: narrowed.content,
      });
    });
  }
  await evidence.write();
  console.log(
    'Actual provider configuration, bounded listing and omitted-provider retrieval: PASS',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
