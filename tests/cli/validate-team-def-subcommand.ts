import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runDomindsCli } from '../helpers/cli-process';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-cli-team-validation-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await fs.mkdir(path.join(rtws, '.minds'), { recursive: true });
    const mcpPath = path.join(rtws, '.minds/mcp.yaml');
    for (const scenario of [
      {
        id: 'deferred',
        toolset: 'sdk_server',
        code: 0,
        mcp: "version: 1\nservers:\n  sdk_server:\n    transport: stdio\n    command: node\n    args: ['-e', 'setInterval(()=>{}, 1000)']\n    tools: { whitelist: [], blacklist: [] }\n    transform: []\n",
        intent: 'A declared MCP toolset is currently unloaded, without a hard definition error.',
      },
      {
        id: 'disabled',
        toolset: 'disabled_server',
        code: 0,
        mcp: 'version: 1\nservers:\n  disabled_server:\n    enabled: false\n    transport: streamable_http\n    url: http://127.0.0.1:9/mcp\n',
        intent:
          'An intentionally disabled MCP server exposes no tools without making the team definition invalid.',
      },
      {
        id: 'missing',
        toolset: 'definitely_missing_toolset',
        code: 2,
        mcp: undefined,
        intent: 'An undeclared toolset is a hard definition error.',
      },
      {
        id: 'available',
        toolset: 'ws_read',
        code: 0,
        mcp: undefined,
        intent: 'A registered built-in toolset is usable in the team definition.',
      },
    ]) {
      const team = `members:\n  tester:\n    name: Tester\n    toolsets:\n      - ${scenario.toolset}\n`;
      await fs.writeFile(path.join(rtws, '.minds/team.yaml'), team);
      if (scenario.mcp === undefined) await fs.rm(mcpPath, { force: true });
      else await fs.writeFile(mcpPath, scenario.mcp);
      // -C is an actual top-level CLI option, not a direct call into the audit renderer.
      const result = runDomindsCli(
        ['-C', rtws, 'validate_team_def'],
        path.resolve(__dirname, '../..'),
      );
      assert.equal(result.status, scenario.code);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.length > 0);
      evidence.record({
        id: scenario.id,
        scenario: scenario.intent,
        businessValue:
          'Distinguish a broken team definition from temporary or intentional tool unavailability so operators choose the right repair.',
        context: {
          teamYaml: team,
          mcpYaml: scenario.mcp ?? '(no MCP declaration)',
          expectedExitCode: scenario.code,
          actualExitCode: result.status,
          scope:
            'Real local CLI/team parsing and declaration audit. No MCP server is started or contacted; does not prove the declared endpoint recovers or exposes any tool.',
        },
        reviewQuestions: [
          'Does the actual report distinguish this availability state, explain its implications accurately, and avoid promising a repair or runtime tool availability that was not established?',
        ],
        actualText: result.stdout,
      });
    }
    await evidence.write();
  });
  console.log('CLI team validation states and exit codes: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
