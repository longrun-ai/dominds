import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Team } from '../../main/team';
import '../../main/tools/builtins';
import { MANUAL_SINGLE_REQUEST_CHAR_LIMIT } from '../../main/tools/manual/output-limit';
import { buildMcpManualSpec, buildRawMcpManualSpec } from '../../main/tools/manual/spec';
import { registerToolset, setToolsetMeta, unregisterToolset } from '../../main/tools/registry';
import { buildToolsetManualTools } from '../../main/tools/toolset-manual';
import { writeSemanticEvidence, type SemanticEvidence } from '../helpers/semantic-evidence';

async function main(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  const semantic = process.argv.includes('--semantic');
  const cases: SemanticEvidence[] = [];
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const man = built.tools.find((tool) => tool.name === 'man');
  assert.ok(man);
  const schemaMarker = 'schema-data-8f0a64e1';
  function register(id: string, count: number, contentFile?: string): void {
    registerToolset(
      id,
      Array.from({ length: count }, (_, index) => ({
        type: 'func' as const,
        name: `fixture_lookup_${String(index).padStart(3, '0')}`,
        description: 'Read-only SDK metadata lookup.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: schemaMarker } },
        },
        argsValidation: 'passthrough' as const,
        async call() {
          return { outcome: 'success' as const, content: 'fixture-result' };
        },
      })),
    );
    setToolsetMeta(id, {
      source: 'mcp',
      manualSpec: contentFile ? buildMcpManualSpec(contentFile) : buildRawMcpManualSpec(),
    });
  }
  async function render(id: string, language: 'en' | 'zh', topic: string): Promise<string> {
    const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: [id] });
    const output = await man!.call({ getLastUserLanguageCode: () => language } as never, caller, {
      toolsetId: id,
      topic,
    });
    assert.equal(output.outcome, 'success');
    return output.content;
  }
  async function evidence(
    id: string,
    language: string,
    scenario: string,
    text: string,
    questions: string[],
    extra: Record<string, string | number> = {},
  ): Promise<void> {
    if (!semantic) return;
    cases.push({
      id,
      scenario,
      businessValue:
        'Let execution agents discover MCP capability boundaries and repair missing guidance without treating optional documentation as a capability grant.',
      context: { language, mcpYaml: await fs.readFile('.minds/mcp.yaml', 'utf8'), ...extra },
      reviewQuestions: questions,
      actualText: text,
    });
  }
  await fs.writeFile('.minds/mcp.yaml', 'version: 1\nservers: {}\n');
  register('raw_fixture', 1);
  register('many_fixture', 205);
  register('file_fixture', 1, '.minds/manuals/sdk');
  try {
    for (const language of ['en', 'zh'] as const) {
      const raw = await render('raw_fixture', language, 'tools');
      // These are fixture identifiers/data, not judgments of the surrounding explanation.
      assert.ok(raw.includes('fixture_lookup_000'));
      assert.equal(raw.includes(schemaMarker), false);
      await evidence(
        `raw-${language}`,
        language,
        'A raw MCP toolset has no workspace-authored manual.',
        raw,
        [
          'Does the manual identify its tool attribution and point to actual function contracts without pretending authored chapters are missing or the capability is unavailable?',
        ],
        { registeredTools: 'fixture_lookup_000', authoredManual: false.toString() },
      );
    }
    const many = await render('many_fixture', 'en', 'tools');
    assert.ok(many.length <= MANUAL_SINGLE_REQUEST_CHAR_LIMIT);
    assert.ok(many.includes('fixture_lookup_000'));
    assert.equal(many.includes('fixture_lookup_204'), false);
    assert.equal(many.includes(schemaMarker), false);
    await evidence(
      'raw-bounded',
      'en',
      'A raw MCP server exposes 205 tool identifiers; the preview is bounded.',
      many,
      [
        'Is the preview honest about showing a subset of 205 tools, with no implication that omitted tools are unavailable?',
      ],
      { registeredToolCount: 205 },
    );

    const prefix = path.resolve('.minds/manuals/sdk');
    await fs.mkdir(prefix, { recursive: true });
    const chapters = {
      scenarios: {
        en: 'Read SDK metadata first, then choose the supported integration path. Payload: chapter-en-76e6.',
        zh: '先读取 SDK 元数据，再选择受支持的集成路径。数据标记：chapter-zh-71b3。',
      },
      errors: {
        en: 'This MCP reads metadata; request the authorized owner for production changes. Payload: chapter-en-d274.',
        zh: '此 MCP 读取元数据；生产变更须交给获得授权的负责人。数据标记：chapter-zh-993a。',
      },
    };
    for (const [topic, localized] of Object.entries(chapters)) {
      for (const language of ['en', 'zh'] as const) {
        await fs.writeFile(
          path.join(prefix, `${topic}${language === 'en' ? '.en' : ''}.md`),
          localized[language],
        );
      }
      for (const language of ['en', 'zh'] as const) {
        const content = localized[language];
        const output = await render('file_fixture', language, topic);
        // Supplied payload fidelity and locale selection, without judging its meaning.
        assert.ok(output.includes(content));
        assert.equal(output.includes(localized[language === 'en' ? 'zh' : 'en']), false);
        assert.equal(output.includes(schemaMarker), false);
        await evidence(
          `file-${topic}-${language}`,
          language,
          'A workspace-authored topic is rendered from the corresponding language-specific contentFile.',
          output,
          [
            'Is the authored topic readable in the requested language without duplicated function schemas or a contradictory missing-manual notice?',
          ],
          { topic, sourceText: content },
        );
      }
    }

    const serverBase =
      'version: 1\nservers:\n  sdk_stdio:\n    enabled: false\n    transport: stdio\n    command: unused-disabled-fixture\n';
    for (const mode of ['raw', 'inline', 'file'] as const) {
      const content = 'SDK metadata lookup for integration tasks. Payload: inline-f096.';
      const section =
        'If unavailable, ask the coordinator before choosing an authorized fallback. Payload: section-e431.';
      const config =
        serverBase +
        (mode === 'inline'
          ? `    manual:\n      content: ${JSON.stringify(content)}\n      sections:\n        - title: Business handling\n          content: ${JSON.stringify(section)}\n`
          : mode === 'file'
            ? '    manual:\n      contentFile: .minds/manuals/sdk\n'
            : '');
      await fs.writeFile('.minds/mcp.yaml', config);
      for (const language of ['en', 'zh'] as const) {
        const output = await render('team_mgmt', language, 'mcp');
        if (mode === 'inline') {
          assert.ok(output.includes(content));
          assert.ok(output.includes(section));
        }
        await evidence(
          `team-mcp-${mode}-${language}`,
          language,
          `Team manager inspects MCP configuration with ${mode} manual configuration.`,
          output,
          [
            'Does the guidance distinguish tool contracts, optional workspace-authored business guidance, and actual runtime availability?',
            'Can the manager clarify purpose and boundaries with the human, document meaningful unavailable-case handling, and find the tools belonging to the toolset without copying schemas?',
            'For contentFile, does it accurately describe topic file loading rather than promise that the prefix itself is a document?',
            'Does it preserve current configuration compatibility without presenting the retired App design as the target?',
          ],
        );
      }
    }
    for (const language of ['en', 'zh'] as const) {
      await evidence(
        `troubleshooting-${language}`,
        language,
        'MCP or component toolsets are unavailable while the team manager needs to diagnose them.',
        await render('team_mgmt', language, 'troubleshooting'),
        [
          'Does it distinguish persistent configuration issues from transient runtime unavailability and give a useful recovery path?',
          'Can validation and manual tools still be used to investigate missing component capabilities under the current compatibility implementation?',
          'Does current App compatibility stay distinct from the target harness architecture?',
        ],
      );
    }
  } finally {
    for (const id of ['raw_fixture', 'many_fixture', 'file_fixture']) unregisterToolset(id);
  }
  if (semantic) await writeSemanticEvidence(cases, 'dominds-mcp-manual-guidance-');
  else console.log('MCP manual content behavior tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
