#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Dialog } from '../../main/dialog';
import { clearProblems, listProblems } from '../../main/problems';
import { Team } from '../../main/team';
import { MANUAL_SINGLE_REQUEST_CHAR_LIMIT } from '../../main/tools/manual/output-limit';
import { teamMgmtValidateMcpCfgTool } from '../../main/tools/team_mgmt';

async function withTempRtws(mcpYamlContent: string, run: () => Promise<void>): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-mcp-validate-'));
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

async function writeMockMcpStdioServer(targetPath: string): Promise<void> {
  await fs.writeFile(
    targetPath,
    [
      "const readline = require('node:readline');",
      '',
      'const rl = readline.createInterface({',
      '  input: process.stdin,',
      '  crlfDelay: Infinity,',
      '});',
      '',
      'function respond(id, result) {',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      '}',
      '',
      'function respondError(id, message) {',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\\n');",
      '}',
      '',
      'const tool = {',
      "  name: 'lookup_sdk_meta',",
      "  description: 'Lookup SDK metadata',",
      "  inputSchema: { type: 'object', additionalProperties: false, properties: {} },",
      '};',
      '',
      "rl.on('line', (line) => {",
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      "  if (msg.method === 'initialize') {",
      "    respond(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } });",
      '    return;',
      '  }',
      "  if (msg.method === 'tools/list') {",
      '    respond(msg.id, { tools: [tool] });',
      '    return;',
      '  }',
      '  if (msg.id !== undefined) {',
      "    respondError(msg.id, 'unsupported method');",
      '  }',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
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
      '      sections: 42',
      '',
    ].join('\n'),
    async () => {
      const dlg = {
        getLastUserLanguageCode: () => 'en' as const,
      } as unknown as Dialog;
      const caller = new Team.Member({ id: 'tester', name: 'Tester' });
      const out = (await teamMgmtValidateMcpCfgTool.call(dlg, caller, {})).content;

      assert.ok(
        out.includes('toolset_manual_error'),
        'validate tool should report toolset_manual_error for invalid manual declaration',
      );
      assert.ok(
        out.includes('servers.sdk_stdio.manual.sections'),
        'validate tool should include the precise invalid manual field path',
      );
      assert.ok(
        out.includes('runtime availability failures') || out.includes('当前运行时可达性问题'),
        'validate tool should explain that MCP validation can include transient runtime-availability failures',
      );
      const problemIds = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        problemIds.includes('mcp/server/sdk_stdio/toolset_manual_error'),
        'invalid manual declaration should be persisted into Problems',
      );

      await fs.writeFile(
        path.join(process.cwd(), '.minds', 'mcp.yaml'),
        ['version: 1', 'servers: {}', ''].join('\n'),
        'utf8',
      );
      await teamMgmtValidateMcpCfgTool.call(dlg, caller, {});
      const activeProblemIds = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        !activeProblemIds.includes('mcp/server/sdk_stdio/toolset_manual_error'),
        'manual declaration problem should leave active Problems after the config is fixed',
      );
      const resolvedProblem = listProblems({
        source: 'mcp',
        problemId: 'mcp/server/sdk_stdio/toolset_manual_error',
        resolved: true,
      });
      assert.ok(
        resolvedProblem.length === 1,
        'manual declaration problem should remain as resolved history after the config is fixed',
      );
    },
  );

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
      const dlg = {
        getLastUserLanguageCode: () => 'en' as const,
      } as unknown as Dialog;
      const caller = new Team.Member({ id: 'tester', name: 'Tester' });
      const out = (await teamMgmtValidateMcpCfgTool.call(dlg, caller, {})).content;

      assert.ok(
        out.includes('toolset_manual_unknown_fields'),
        'validate tool should report toolset_manual_unknown_fields for unsupported manual extra fields',
      );
      assert.ok(
        out.includes('[warning]'),
        'validate tool should surface unsupported manual extra fields as a warning-level problem',
      );
      assert.ok(
        out.includes('servers.sdk_stdio.manual.extraHint'),
        'validate tool should identify the precise unsupported manual field path',
      );
      const activeProblems = listProblems({ source: 'mcp', resolved: false });
      const warningProblem = activeProblems.find(
        (problem) => problem.id === 'mcp/server/sdk_stdio/toolset_manual_unknown_fields',
      );
      assert.ok(
        warningProblem !== undefined,
        'unsupported manual extra fields should be persisted into Problems',
      );
      assert.equal(
        warningProblem?.severity,
        'warning',
        'unsupported manual extra fields should persist as a warning-severity problem',
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
      await teamMgmtValidateMcpCfgTool.call(dlg, caller, {});
      const activeProblemIds = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        !activeProblemIds.includes('mcp/server/sdk_stdio/toolset_manual_unknown_fields'),
        'manual unknown-fields warning should leave active Problems after the config is fixed',
      );
      const resolvedProblem = listProblems({
        source: 'mcp',
        problemId: 'mcp/server/sdk_stdio/toolset_manual_unknown_fields',
        resolved: true,
      });
      assert.ok(
        resolvedProblem.length === 1,
        'manual unknown-fields warning should remain as resolved history after the config is fixed',
      );
    },
  );

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
      '      content: |',
      `        ${'A'.repeat(MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000)}`,
      '',
    ].join('\n'),
    async () => {
      const dlg = {
        getLastUserLanguageCode: () => 'en' as const,
      } as unknown as Dialog;
      const caller = new Team.Member({ id: 'tester', name: 'Tester' });
      const out = (await teamMgmtValidateMcpCfgTool.call(dlg, caller, {})).content;

      assert.ok(
        out.includes('workspace_manual_team_mgmt_mcp_too_large'),
        'validate tool should report workspace_manual_team_mgmt_mcp_too_large for oversized final manual output',
      );
      assert.ok(
        out.includes('man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })'),
        'validate tool should reference the actual final manual call shown to the LLM',
      );
      assert.ok(
        out.includes(String(MANUAL_SINGLE_REQUEST_CHAR_LIMIT)),
        'validate tool should mention the manual size budget',
      );
      const problemIds = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        problemIds.includes('mcp/workspace_manual_team_mgmt_mcp_too_large'),
        'oversized final manual result should be persisted into Problems',
      );

      await fs.writeFile(
        path.join(process.cwd(), '.minds', 'mcp.yaml'),
        ['version: 1', 'servers: {}', ''].join('\n'),
        'utf8',
      );
      await teamMgmtValidateMcpCfgTool.call(dlg, caller, {});
      const activeProblemIds = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        !activeProblemIds.includes('mcp/workspace_manual_team_mgmt_mcp_too_large'),
        'oversized manual problem should leave active Problems after the config is fixed',
      );
      const resolvedProblem = listProblems({
        source: 'mcp',
        problemId: 'mcp/workspace_manual_team_mgmt_mcp_too_large',
        resolved: true,
      });
      assert.ok(
        resolvedProblem.length === 1,
        'oversized manual problem should remain as resolved history after the config is fixed',
      );
    },
  );

  clearProblems({ source: 'mcp' });

  await withTempRtws(
    [
      'version: 1',
      'servers:',
      '  sdk_stdio:',
      '    transport: stdio',
      '    command: node',
      "    args: ['.minds/mock-mcp-server.js']",
      '    cwd: "."',
      '    tools: { whitelist: [], blacklist: [] }',
      '    transform: []',
      '    manual:',
      '      contentFile: .minds/manuals/sdk',
      '',
    ].join('\n'),
    async () => {
      await writeMockMcpStdioServer(path.join(process.cwd(), '.minds', 'mock-mcp-server.js'));
      await fs.mkdir(path.join(process.cwd(), '.minds', 'manuals', 'sdk'), { recursive: true });
      await fs.writeFile(
        path.join(process.cwd(), '.minds', 'manuals', 'sdk', 'index.md'),
        '概述\n\n' + '甲'.repeat(MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000),
        'utf8',
      );
      await fs.writeFile(
        path.join(process.cwd(), '.minds', 'manuals', 'sdk', 'index.en.md'),
        'Overview\n\n' + 'A'.repeat(MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000),
        'utf8',
      );

      const dlg = {
        getLastUserLanguageCode: () => 'en' as const,
      } as unknown as Dialog;
      const caller = new Team.Member({ id: 'tester', name: 'Tester' });
      const out = (await teamMgmtValidateMcpCfgTool.call(dlg, caller, {})).content;

      assert.ok(
        out.includes('toolset_manual_too_large'),
        'validate tool should report toolset_manual_too_large for oversized final MCP toolset manual output',
      );
      assert.ok(
        out.includes('man({ "toolsetId": "sdk_stdio" })'),
        'validate tool should reference the actual final MCP toolset manual call shown to the LLM',
      );
      const problemIds = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        problemIds.includes('mcp/server/sdk_stdio/toolset_manual_too_large'),
        'oversized final MCP toolset manual result should be persisted into Problems',
      );

      await fs.writeFile(
        path.join(process.cwd(), '.minds', 'mcp.yaml'),
        ['version: 1', 'servers: {}', ''].join('\n'),
        'utf8',
      );
      await teamMgmtValidateMcpCfgTool.call(dlg, caller, {});
      const activeProblemIds = listProblems({ source: 'mcp', resolved: false }).map(
        (problem) => problem.id,
      );
      assert.ok(
        !activeProblemIds.includes('mcp/server/sdk_stdio/toolset_manual_too_large'),
        'oversized final MCP toolset manual problem should leave active Problems after the config is fixed',
      );
      const resolvedProblem = listProblems({
        source: 'mcp',
        problemId: 'mcp/server/sdk_stdio/toolset_manual_too_large',
        resolved: true,
      });
      assert.ok(
        resolvedProblem.length === 1,
        'oversized final MCP toolset manual problem should remain as resolved history after the config is fixed',
      );
    },
  );

  clearProblems({ source: 'mcp' });
  console.log('team_mgmt_validate_mcp_cfg manual-errors tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt_validate_mcp_cfg manual-errors tests: failed: ${message}`);
  process.exit(1);
});
