import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import { buildAnthropicRequestMessagesWrapper } from '../../main/llm/gen/anthropic';
import { buildOpenAiRequestInputWrapper } from '../../main/llm/gen/openai';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';
import { resolveProviderToolResultMaxChars } from '../../main/llm/gen/tool-output-limit';
import { Team } from '../../main/team';
import { ripgrepSnippetsTool } from '../../main/tools/ripgrep';
import { providerHistory } from '../helpers/provider-context';
import type { ProjectionApi } from '../helpers/provider-images';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { toolOutputData } from '../helpers/tool-output';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-projection-truncation-');
async function project(api: ProjectionApi, content: string) {
  const fixture = providerHistory();
  const context: ChatMessage[] = [fixture.user, fixture.call, { ...fixture.result, content }];
  const original = structuredClone(context);
  const config: ProviderConfig = {
    name: 'truncation-fixture',
    apiType: api,
    baseUrl: 'https://example.invalid',
    apiKeyEnvVar: 'UNUSED_TRUNCATION_FIXTURE_KEY',
    tool_result_max_chars: 120,
    models: {},
  };
  if (api === 'openai') {
    const projection = await buildOpenAiRequestInputWrapper(context, config);
    const item = projection.find((item) => item.type === 'function_call_output');
    assert.ok(item?.type === 'function_call_output' && typeof item.output === 'string');
    assert.deepEqual(context, original);
    return { output: item.output, projection, context };
  }
  if (api === 'openai-compatible') {
    const projection = await buildOpenAiCompatibleRequestMessagesWrapper('', context, {
      providerConfig: config,
    });
    const item = projection.find((item) => item.role === 'tool');
    assert.ok(item?.role === 'tool' && typeof item.content === 'string');
    assert.deepEqual(context, original);
    return { output: item.content, projection, context };
  }
  const projection = await buildAnthropicRequestMessagesWrapper(context, config);
  const last = projection.at(-1);
  assert.ok(last?.role === 'user' && Array.isArray(last.content));
  const text = last.content[0];
  assert.ok(text?.type === 'text');
  assert.deepEqual(context, original);
  return { output: text.text, projection, context };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function main() {
  for (const api of ['openai', 'openai-compatible', 'anthropic'] as const) {
    for (const [id, supplied] of [
      ['short', 'short-result-data:7e3'],
      ['long', 'BEGIN:data-f742\n' + 'Ω'.repeat(500) + '\nEND:data-e351'],
    ] as const) {
      const result = await project(api, supplied);
      assert.ok(result.output.length > 0 && result.output.length <= 120);
      if (id === 'short')
        assert.ok(result.output.includes(supplied)); // Supplied data only.
      else assert.ok(result.output.length < supplied.length);
      evidence.record({
        id: api + '-' + id,
        scenario: `${api} projects a ${id} supplied tool result under a120-character configured limit.`,
        businessValue:
          'Bound provider request growth without silently rewriting the durable tool outcome or misleading an agent about omitted data.',
        context: {
          input: JSON.stringify(result.context),
          configuredLimit: 120,
          originalResultChars: supplied.length,
          scope:
            'Actual request projection only; source context remains unchanged. No provider request, SDK transport or persistence write.',
        },
        reviewQuestions: [
          'Does the actual projected tool context describe any truncation accurately and keep the available data attributed to the historical result, without claiming an omitted portion was read or the task completed?',
        ],
        actualText: JSON.stringify(result.projection, null, 2),
      });
    }
  }
  for (const [apiType, expected] of [
    ['codex', 8 * 1024 * 1024],
    ['openai', 8 * 1024 * 1024],
    ['openai-compatible', 4 * 1024 * 1024],
    ['anthropic', 4 * 1024 * 1024],
    ['anthropic-compatible', 4 * 1024 * 1024],
    ['google', 4 * 1024 * 1024],
    ['mock', 8 * 1024 * 1024],
  ] as const) {
    assert.equal(resolveProviderToolResultMaxChars({ apiType }), expected);
    assert.equal(resolveProviderToolResultMaxChars({ apiType, tool_result_max_chars: 120 }), 120);
  }
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const dialog = await createMainDialog();
    const line = 'needle:' + 'x'.repeat(500_000);
    await fs.writeFile(path.join(rtws, 'huge.txt'), line + '\n');
    const output = await ripgrepSnippetsTool.call(
      dialog,
      new Team.Member({ id: 'reader', name: 'Reader', read_dirs: ['**/*'] }),
      { pattern: 'needle', path: 'huge.txt', max_results: 50 },
    );
    assert.equal(output.outcome, 'success');
    const data = toolOutputData(output.content);
    assert.equal(data.truncated, true);
    assert.ok(record(data.truncation));
    assert.equal(data.truncation.applied, true);
    assert.deepEqual(data.truncation.reasons, ['per_text_char_limit']);
    assert.ok(Array.isArray(data.results));
    assert.equal(data.results.length, 1);
    const item: unknown = data.results[0];
    assert.ok(record(item));
    assert.equal(item.path, 'huge.txt');
    assert.equal(item.line, 1);
    assert.equal(item.col, 1);
    assert.ok(record(item.truncation));
    assert.equal(item.truncation.applied, true);
    assert.equal(item.truncation.match_original_chars, line.length);
    assert.deepEqual(item.truncation.reasons, ['per_text_char_limit']);
    assert.ok(typeof item.match === 'string' && item.match.length < line.length);
    evidence.record({
      id: 'ripgrep-truncated-snippet',
      scenario:
        'The real ripgrep tool searches one known500007-character line in the isolated workspace.',
      businessValue:
        'Expose omitted search data as structured counts and an accurate explanation, so an agent can narrow a search instead of treating a clipped excerpt as complete.',
      context: {
        inputFile: 'huge.txt',
        pattern: 'needle',
        originalLineChars: line.length,
        knownMatches: 1,
        scope:
          'Real tool, Dialog, file and ripgrep process; public YAML fields parsed as data. No fixed explanation or source snippet is an oracle.',
      },
      reviewQuestions: [
        'Does the actual summary correctly describe this known single matching line and truncation, without implying unseen data was fully shown?',
      ],
      actualText: output.content,
    });
    await evidence.write();
  });
  console.log('Provider limits, retained source data and real search truncation: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
