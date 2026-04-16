#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { requestMcpConfigReload } from '../../main/mcp/supervisor';
import { clearProblems, listProblems } from '../../main/problems';

async function withTempRtws(mcpYamlContent: string, run: () => Promise<void>): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-mcp-hot-reload-'));
  const oldCwd = process.cwd();
  try {
    await fs.mkdir(path.join(tmpDir, '.minds'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.minds', 'mcp.yaml'), mcpYamlContent, 'utf8');
    process.chdir(tmpDir);
    await run();
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  clearProblems({ source: 'mcp' });

  await withTempRtws(
    [
      'version: 1',
      'servers:',
      '  sdk_stdio:',
      '    transport: stdio',
      '    command: node',
      "    args: ['-e', 'setInterval(()=>{},1000)']",
      '    tools: { whitelist: [], blacklist: [] }',
      '    transform: []',
      '    manual:',
      '      content: "SDK helper MCP for integration tasks"',
      '      extraHint: "ignored by runtime manual loader"',
      '',
    ].join('\n'),
    async () => {
      const firstReload = await requestMcpConfigReload('test_mcp_hot_reload_manual_problems');
      assert.ok(firstReload.ok, 'hot reload should succeed for warning-only manual issues');

      const activeProblems = listProblems({ source: 'mcp', resolved: false });
      const warningProblem = activeProblems.find(
        (problem) => problem.id === 'mcp/server/sdk_stdio/toolset_manual_unknown_fields',
      );
      assert.ok(
        warningProblem !== undefined,
        'hot reload should surface manual unknown-fields warning into Problems without validate tool',
      );
      assert.equal(
        warningProblem?.severity,
        'warning',
        'hot reload should persist manual unknown-fields as warning severity',
      );

      await fs.writeFile(path.join(process.cwd(), '.minds', 'mcp.yaml'), 'version: [', 'utf8');
      const invalidReload = await requestMcpConfigReload(
        'test_mcp_hot_reload_manual_problems_invalid_yaml',
      );
      assert.ok(
        invalidReload.ok,
        'hot reload should stay non-throwing even when mcp.yaml is invalid',
      );

      const activeAfterInvalidYaml = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        !activeAfterInvalidYaml.includes('mcp/server/sdk_stdio/toolset_manual_unknown_fields'),
        'manual warning should leave active Problems when mcp.yaml becomes invalid',
      );

      const resolvedAfterInvalidYaml = listProblems({
        source: 'mcp',
        problemId: 'mcp/server/sdk_stdio/toolset_manual_unknown_fields',
        resolved: true,
      });
      assert.ok(
        resolvedAfterInvalidYaml.length === 1,
        'manual warning should remain as resolved history when invalid yaml clears active manual problems',
      );

      await fs.writeFile(
        path.join(process.cwd(), '.minds', 'mcp.yaml'),
        [
          'version: 1',
          'servers:',
          '  sdk_stdio:',
          '    transport: stdio',
          '    command: node',
          "    args: ['-e', 'setInterval(()=>{},1000)']",
          '    tools: { whitelist: [], blacklist: [] }',
          '    transform: []',
          '    manual:',
          '      content: "SDK helper MCP for integration tasks"',
          '',
        ].join('\n'),
        'utf8',
      );

      const secondReload = await requestMcpConfigReload('test_mcp_hot_reload_manual_problems_fix');
      assert.ok(secondReload.ok, 'hot reload should succeed after manual warning is fixed');

      const activeProblemIds = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        !activeProblemIds.includes('mcp/server/sdk_stdio/toolset_manual_unknown_fields'),
        'manual unknown-fields warning should leave active Problems after hot-reload fix',
      );

      const resolvedProblems = listProblems({
        source: 'mcp',
        problemId: 'mcp/server/sdk_stdio/toolset_manual_unknown_fields',
        resolved: true,
      });
      assert.ok(
        resolvedProblems.length === 1,
        'manual unknown-fields warning should remain as resolved history after hot-reload fix',
      );
    },
  );

  clearProblems({ source: 'mcp' });
  console.log('mcp hot reload manual problems tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`mcp hot reload manual problems tests: failed: ${message}`);
  process.exit(1);
});
