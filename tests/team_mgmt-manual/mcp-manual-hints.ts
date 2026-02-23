#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Team } from 'dominds/team';
import { teamMgmtManualTool } from 'dominds/tools/team_mgmt';

async function render(lang: 'en' | 'zh', topics: ReadonlyArray<string>): Promise<string> {
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({ id: 'tester', name: 'Tester' });
  return await teamMgmtManualTool.call(dlg, caller, { topics: [...topics] });
}

async function withTempRtws(mcpYamlContent: string, run: () => Promise<void>): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-mcp-manual-'));
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
  await withTempRtws(
    [
      'version: 1',
      'servers:',
      '  sdk_stdio:',
      '    transport: stdio',
      '    command: npx',
      "    args: ['-y', '@some/mcp-server@latest']",
      '    tools: { whitelist: [], blacklist: [] }',
      '    transform: []',
      '',
    ].join('\n'),
    async () => {
      const zh = await render('zh', ['mcp']);
      const en = await render('en', ['mcp']);

      assert.ok(
        zh.includes('不影响 toolset 可用性'),
        'zh mcp manual should explicitly say missing manual does not affect availability',
      );
      assert.ok(
        en.includes('toolset availability is unaffected'),
        'en mcp manual should explicitly say missing manual does not affect availability',
      );
    },
  );

  await withTempRtws(
    [
      'version: 1',
      'servers:',
      '  sdk_stdio:',
      '    transport: stdio',
      '    command: npx',
      "    args: ['-y', '@some/mcp-server@latest']",
      '    tools: { whitelist: [], blacklist: [] }',
      '    transform: []',
      '    manual:',
      '      content: "SDK helper MCP for integration tasks"',
      '      sections:',
      '        - title: "When To Use"',
      '          content: "Use this toolset when you need SDK metadata."',
      '        - title: "Guardrails"',
      '          content: "Do not mutate production systems."',
      '',
    ].join('\n'),
    async () => {
      const en = await render('en', ['mcp']);
      assert.ok(
        en.includes('SDK helper MCP for integration tasks'),
        'mcp manual should render manual.content when provided',
      );
      assert.ok(
        en.includes('Section: When To Use') || en.includes('When To Use'),
        'mcp manual should render manual.sections titles',
      );
      assert.ok(
        en.includes('Do not mutate production systems.'),
        'mcp manual should render manual.sections content',
      );
    },
  );

  console.log('team_mgmt_manual mcp-manual-hints tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt_manual mcp-manual-hints tests: failed: ${message}`);
  process.exit(1);
});
