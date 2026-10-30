import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import type { Dialog } from '../../main/dialog';
import { requestMcpConfigReload } from '../../main/mcp/supervisor';
import { clearProblems, listProblems } from '../../main/problems';
import { Team } from '../../main/team';
import { MANUAL_SINGLE_REQUEST_CHAR_LIMIT } from '../../main/tools/manual/output-limit';
import { teamMgmtValidateMcpCfgTool } from '../../main/tools/team_mgmt';
import { writeMcpStdioFixture } from '../helpers/mcp-stdio-fixture';
import { writeSemanticEvidence, type SemanticEvidence } from '../helpers/semantic-evidence';

async function main(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  const semantic = process.argv.includes('--semantic');
  const cases: SemanticEvidence[] = [];
  await writeMcpStdioFixture();
  const caller = new Team.Member({ id: 'tester', name: 'Tester' });
  const scenarios = [
    {
      id: 'missing',
      declaration: '',
      problemId: 'mcp/server/sdk_stdio/toolset_manual_missing',
      severity: 'warning',
    },
    {
      id: 'invalid',
      declaration: '    manual:\n      sections: 42\n',
      problemId: 'mcp/server/sdk_stdio/toolset_manual_error',
      severity: 'error',
    },
    {
      id: 'unknown-field',
      declaration: '    manual:\n      content: SDK metadata lookup\n      extraHint: ignored\n',
      problemId: 'mcp/server/sdk_stdio/toolset_manual_unknown_fields',
      severity: 'warning',
    },
    {
      id: 'workspace-size',
      declaration: `    manual:\n      content: ${'A'.repeat(MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000)}\n`,
      problemId: 'mcp/workspace_manual_team_mgmt_mcp_too_large',
      severity: 'error',
    },
    {
      id: 'toolset-size',
      declaration: '    manual:\n      contentFile: .minds/manuals/sdk\n',
      problemId: 'mcp/server/sdk_stdio/toolset_manual_too_large',
      severity: 'error',
    },
    {
      id: 'invalid-server',
      declaration: '',
      problemId: 'mcp/server/sdk_stdio/server_error',
      severity: 'error',
    },
  ];
  await fs.mkdir('.minds/manuals/sdk', { recursive: true });
  await fs.writeFile(
    '.minds/manuals/sdk/index.md',
    '甲'.repeat(MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000),
  );
  await fs.writeFile(
    '.minds/manuals/sdk/index.en.md',
    'A'.repeat(MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000),
  );
  try {
    for (const scenario of scenarios) {
      clearProblems({ source: 'mcp' });
      const config =
        `version: 1\nservers:\n  sdk_stdio:\n    transport: ${scenario.id === 'invalid-server' ? 'not_a_transport' : 'stdio'}\n    command: ${JSON.stringify(process.execPath)}\n    args: ['.minds/mock-mcp-server.cjs']\n    cwd: '.'\n` +
        scenario.declaration;
      await fs.writeFile('.minds/mcp.yaml', config);
      for (const language of ['en', 'zh'] as const) {
        const result = await teamMgmtValidateMcpCfgTool.call(
          { getLastUserLanguageCode: () => language } as Dialog,
          caller,
          {},
        );
        assert.equal(result.outcome, 'failure', scenario.id);
        const problem = listProblems({
          source: 'mcp',
          resolved: false,
          problemId: scenario.problemId,
        })[0];
        assert.ok(problem, `missing active problem ${scenario.problemId}`);
        assert.equal(problem.severity, scenario.severity);
        if (scenario.id === 'invalid-server') {
          assert.equal(
            listProblems({
              source: 'mcp',
              resolved: false,
              problemId: 'mcp/server/sdk_stdio/toolset_manual_missing',
            }).length,
            0,
          );
        }
        if (semantic)
          cases.push({
            id: `${scenario.id}-${language}`,
            scenario: `Validate actual MCP configuration: ${scenario.id}. The external stdio process is a functioning controlled MCP fixture.`,
            businessValue:
              'Explain the repairable condition without confusing optional guidance, configuration validity and runtime availability.',
            context: {
              language,
              mcpYaml: config,
              problem: JSON.stringify(problem),
              manualSizeLimit: MANUAL_SINGLE_REQUEST_CHAR_LIMIT,
              fileTopicSize: MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000,
            },
            reviewQuestions: [
              'Does the complete validator output communicate the actual issue, its severity and an actionable repair for this configuration?',
              'Does it distinguish static declarations from transient runtime availability and avoid treating a missing optional manual as a missing capability?',
              'For size failures, does it identify the actual rendered manual and the applicable budget, without conflating workspace guidance and the toolset manual?',
            ],
            actualText: result.content,
          });
      }
      if (scenario.id === 'invalid-server') {
        await fs.writeFile(
          '.minds/mcp.yaml',
          'version: 1\nservers:\n  retained_invalid:\n    transport: not_a_transport\n',
        );
        const partiallyRepaired = await teamMgmtValidateMcpCfgTool.call(
          { getLastUserLanguageCode: () => 'en' } as Dialog,
          caller,
          {},
        );
        assert.equal(partiallyRepaired.outcome, 'failure');
        assert.equal(
          listProblems({ source: 'mcp', resolved: false, problemId: scenario.problemId }).length,
          0,
          'deleted invalid server is resolved without a runtime',
        );
        assert.equal(
          listProblems({
            source: 'mcp',
            resolved: false,
            problemId: 'mcp/server/retained_invalid/server_error',
          }).length,
          1,
          'a still-declared invalid server must remain active',
        );
      }
      await fs.writeFile('.minds/mcp.yaml', 'version: 1\nservers: {}\n');
      const repaired = await teamMgmtValidateMcpCfgTool.call(
        { getLastUserLanguageCode: () => 'en' } as Dialog,
        caller,
        {},
      );
      assert.equal(repaired.outcome, 'success');
      assert.equal(listProblems({ source: 'mcp', resolved: false }).length, 0);
      assert.equal(
        listProblems({ source: 'mcp', resolved: true, problemId: scenario.problemId }).length,
        1,
      );
    }
  } finally {
    await fs.writeFile('.minds/mcp.yaml', 'version: 1\nservers: {}\n');
    await requestMcpConfigReload('test-cleanup');
  }
  if (semantic) await writeSemanticEvidence(cases, 'dominds-mcp-validation-guidance-');
  else console.log('MCP validation problem lifecycle tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
