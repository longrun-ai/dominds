import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import YAML from 'yaml';
import { LlmConfig, type ChatMessage, type ProviderConfig } from '../../main/llm/client';
import { OpenAiGen } from '../../main/llm/gen/openai';
import { buildLlmGenerationMetadata } from '../../main/llm/generation-metadata';
import { getProblemsSnapshot } from '../../main/problems';
import { buildSetupStatusResponse, handleWriteTeamYaml } from '../../main/server/setup-routes';
import { Team } from '../../main/team';
import { formatGenerationModelPresentation } from '../../webapp/src/components/generation-model-presentation';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  const evidence = semanticEvidenceCollector('dominds-openai-mode-');
  const originalFetch = globalThis.fetch;
  const envVar = 'DOMINDS_TEST_OPENAI_MODE_KEY';
  const originalKey = process.env[envVar];
  const requests: Record<string, unknown>[] = [];
  const suppliedOutput = 'opaque-response-data:4dc9';
  const builtin = (await LlmConfig.load()).getProvider('openai');
  assert.ok(builtin);
  const provider: ProviderConfig = {
    ...builtin,
    name: 'Controlled Responses peer',
    baseUrl: 'https://mode-peer.invalid/v1',
    apiKeyEnvVar: envVar,
    models: { 'gpt-6.1-sol': {}, 'gpt-5.4': {} },
  };
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'input-1',
      grammar: 'markdown',
      content: 'opaque-input-data:16ab',
    },
  ];
  const record = (
    id: string,
    scenario: string,
    actualText: string,
    facts: Record<string, string>,
  ) =>
    evidence.record({
      id,
      scenario,
      businessValue:
        'An rtws operator chooses Pro independently of effort, retains that choice across setup reloads, and can inspect the configured execution mode without inventing a new wire model ID.',
      context: {
        ...facts,
        scope:
          'Controlled local native wrapper, configuration persistence, parser, setup DTO and presentation formatter. No paid inference, browser rendering or model-quality claim.',
      },
      reviewQuestions: [
        'Does the complete actual guidance or presentation accurately explain the supplied mode/effort/default/identity or configuration failure, with no claim that configuration proves observed upstream execution or quality?',
      ],
      actualText,
    });
  try {
    process.env[envVar] = 'controlled-fixture-key';
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, 'https://mode-peer.invalid/v1/responses');
      requests.push(JSON.parse(await request.text()));
      return Response.json({
        id: 'response-data:1',
        object: 'response',
        status: 'completed',
        model: 'gpt-6.1-sol',
        output: [
          {
            type: 'message',
            id: 'message-data:1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: suppliedOutput, annotations: [] }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      });
    };
    const cases: Array<{
      id: string;
      params: NonNullable<Team.ModelParams['openai']>;
      expected: unknown;
    }> = [
      {
        id: 'pro-low',
        params: { reasoning_mode: 'pro', reasoning_effort: 'low' },
        expected: { mode: 'pro', effort: 'low' },
      },
      {
        id: 'standard-max',
        params: { reasoning_mode: 'standard', reasoning_effort: 'max' },
        expected: { mode: 'standard', effort: 'max' },
      },
      { id: 'pro-only', params: { reasoning_mode: 'pro' }, expected: { mode: 'pro' } },
      { id: 'max-is-not-pro', params: { reasoning_effort: 'max' }, expected: { effort: 'max' } },
      { id: 'legacy-omission', params: {}, expected: undefined },
      {
        id: 'pro-no-summary',
        params: { reasoning_mode: 'pro', reasoning_summary: 'none' },
        expected: { mode: 'pro', summary: null },
      },
    ];
    for (const row of cases) {
      const agent = new Team.Member({
        id: 'executor',
        name: 'Executor',
        provider: 'controlled',
        model: 'gpt-6.1-sol',
        model_params: { openai: row.params, codex: { reasoning_effort: 'high' } },
      });
      assert.ok(agent.model);
      const result = await new OpenAiGen().genMoreMessages(
        provider,
        agent,
        '',
        [],
        {
          dialogSelfId: 'mode-test',
          dialogRootId: 'mode-test',
          providerKey: 'controlled',
          modelKey: agent.model,
          toolUseRequirement: 'none',
        },
        context,
        1,
        AbortSignal.timeout(5000),
      );
      assert.deepEqual(requests.at(-1)?.reasoning, row.expected, row.id);
      assert.equal(requests.at(-1)?.model, 'gpt-6.1-sol');
      // Exact supplied opaque data and wire identifiers protect transport, not prose meaning.
      assert.deepEqual(
        result.messages
          .filter((message) => message.type === 'saying_msg')
          .map((message) => message.content),
        [suppliedOutput],
      );
      assert.ok(result.llmGenModel);
      assert.equal(result.llmGenModel, 'gpt-6.1-sol');
      const metadata = buildLlmGenerationMetadata({
        providerId: 'controlled',
        configuredModelId: agent.model,
        reportedModelId: result.llmGenModel,
        providerConfig: provider,
        modelParams: agent.model_params,
      });
      const mode = metadata.fields.find((field) => field.key === 'openai.reasoning_mode');
      assert.ok(mode);
      assert.equal(mode.kind, row.params.reasoning_mode === undefined ? 'unset' : 'set');
      if (mode.kind === 'set') assert.equal(mode.value, row.params.reasoning_mode);
      record(
        row.id,
        'Inspect the selected model and explicit or omitted execution mode separately from reasoning effort.',
        JSON.stringify(
          { metadata, presentation: formatGenerationModelPresentation(metadata) },
          null,
          2,
        ),
        {
          configuredParams: JSON.stringify(agent.model_params),
          wireReasoning: JSON.stringify(row.expected) ?? 'omitted',
          givenOutput: suppliedOutput,
        },
      );
    }
    assert.equal(requests.length, cases.length);
    globalThis.fetch = originalFetch;

    await withTempRtws(async () => {
      await fs.writeFile(
        '.minds/llm.yaml',
        YAML.stringify({ providers: { controlled: provider } }),
      );
      await fs.rm('.minds/team.yaml', { force: true });
      const modeParams = {
        openai: { reasoning_mode: 'pro', reasoning_effort: 'low', verbosity: 'low' },
      };
      const write = await handleWriteTeamYaml(
        JSON.stringify({
          provider: 'controlled',
          model: 'gpt-6.1-sol',
          overwrite: false,
          modelParams: modeParams,
        }),
      );
      assert.equal(write.kind, 'ok');
      const written = YAML.parse(await fs.readFile('.minds/team.yaml', 'utf8'));
      assert.deepEqual(written.member_defaults.model_params, modeParams);
      assert.equal(written.member_defaults.model, 'gpt-6.1-sol');
      const status = await buildSetupStatusResponse();
      assert.equal(status.success, true);
      assert.deepEqual(status.teamYaml.memberDefaults?.modelParams, modeParams);
      const custom = status.providers.find((value) => value.providerKey === 'controlled');
      const modeChoice = custom?.prominentModelParams?.find(
        (value) => value.namespace === 'openai' && value.key === 'reasoning_mode',
      );
      assert.ok(modeChoice && modeChoice.kind === 'enum');
      assert.deepEqual(modeChoice.values, ['standard', 'pro']);
      assert.equal(modeChoice.defaultValue, undefined);
      record(
        'setup-mode-choice',
        'Setup exposes mode choices for the custom rtws provider and reads back the persisted choice without changing the wire model ID.',
        JSON.stringify({ modeChoice, saved: status.teamYaml.memberDefaults }, null, 2),
        {
          savedModel: 'gpt-6.1-sol',
          sentMode: 'pro',
          note: 'Setup values describe configuration, not a claim that this controlled peer executed Pro.',
        },
      );

      const teamConfig = {
        member_defaults: written.member_defaults,
        members: {
          executor: { name: 'Executor' },
          standard: {
            name: 'Standard',
            model_params: { openai: { reasoning_mode: 'standard', reasoning_effort: 'max' } },
          },
        },
      };
      await fs.writeFile('.minds/team.yaml', YAML.stringify(teamConfig));
      const team = await Team.load();
      assert.deepEqual(team.getMember('executor')?.model_params?.openai, modeParams.openai);
      assert.deepEqual(team.getMember('standard')?.model_params?.openai, {
        reasoning_mode: 'standard',
        reasoning_effort: 'max',
      });
      for (const invalid of ['max', false, 3, {}]) {
        const invalidConfig = {
          ...teamConfig,
          members: {
            executor: { name: 'Executor', model_params: { openai: { reasoning_mode: invalid } } },
          },
        };
        await fs.writeFile('.minds/team.yaml', YAML.stringify(invalidConfig));
        const invalidTeam = await Team.load();
        assert.deepEqual(invalidTeam.getMember('executor')?.model_params, modeParams);
        const problem = getProblemsSnapshot().problems.find(
          (value) =>
            value.id === 'team/team_yaml_error/members/executor/model_params/invalid_ignored' &&
            !value.resolved,
        );
        assert.ok(problem);
        assert.equal(problem.kind, 'team_workspace_config_error');
        assert.equal(problem.severity, 'warning');
        record(
          'invalid-mode-' + JSON.stringify(invalid),
          'An otherwise valid member uses an invalid OpenAI reasoning_mode; native parsing refuses its invalid override, retains the explicitly configured valid defaults and reports an actionable Problem.',
          JSON.stringify(problem, null, 2),
          { teamYaml: YAML.stringify(invalidConfig), invalidValue: JSON.stringify(invalid) },
        );
      }
      const misplaced = {
        ...teamConfig,
        members: { executor: { name: 'Executor', model_params: { reasoning_mode: 'pro' } } },
      };
      await fs.writeFile('.minds/team.yaml', YAML.stringify(misplaced));
      await Team.load();
      const misplacedProblem = getProblemsSnapshot().problems.find(
        (value) =>
          value.id === 'team/team_yaml_error/members/executor/model_params/unknown_fields' &&
          !value.resolved,
      );
      assert.ok(misplacedProblem);
      record(
        'misplaced-mode',
        'The operator puts reasoning_mode outside the openai namespace; native schema inspection reports the placement error and its repair path.',
        JSON.stringify(misplacedProblem, null, 2),
        { teamYaml: YAML.stringify(misplaced) },
      );
      const repaired = { ...teamConfig, members: { executor: { name: 'Executor' } } };
      await fs.writeFile('.minds/team.yaml', YAML.stringify(repaired));
      assert.deepEqual(
        (await Team.load()).getMember('executor')?.model_params?.openai,
        modeParams.openai,
      );
      assert.equal(
        getProblemsSnapshot().problems.some(
          (value) =>
            value.id === 'team/team_yaml_error/members/executor/model_params/invalid_ignored' &&
            !value.resolved,
        ),
        false,
      );
      // Unconfigured existing models keep omitting mode; setup does not opt them into Pro.
      const legacy = await handleWriteTeamYaml(
        JSON.stringify({ provider: 'controlled', model: 'gpt-5.4', overwrite: true }),
      );
      assert.equal(legacy.kind, 'ok');
      assert.equal(
        YAML.parse(await fs.readFile('.minds/team.yaml', 'utf8')).member_defaults.model_params,
        undefined,
      );
      assert.equal(
        (await buildSetupStatusResponse()).teamYaml.memberDefaults?.modelParams,
        undefined,
      );
    });
    await evidence.write();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env[envVar];
    else process.env[envVar] = originalKey;
  }
}

let completed = false;
process.once('beforeExit', () => {
  if (!completed) process.exitCode = 1;
});
void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    completed = true;
  });
