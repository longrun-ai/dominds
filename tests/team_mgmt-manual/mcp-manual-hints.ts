#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Team } from '../../main/team';
import '../../main/tools/builtins';
import { buildToolsetManualTools } from '../../main/tools/toolset-manual';

async function render(lang: 'en' | 'zh', topics: ReadonlyArray<string>): Promise<string> {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((entry) => entry.name === 'man');
  assert.ok(tool, 'man tool should be available');
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: ['team_mgmt'] });
  return (await tool.call(dlg as never, caller, { toolsetId: 'team_mgmt', topics: [...topics] }))
    .content;
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
      const zhTroubleshooting = await render('zh', ['troubleshooting']);
      const enTroubleshooting = await render('en', ['troubleshooting']);

      assert.ok(
        zh.includes('不影响 toolset 可用性'),
        'zh mcp manual should explicitly say missing manual does not affect availability',
      );
      assert.ok(
        zh.includes('章节：tools 列表（运行时快照）'),
        'zh mcp manual should auto-generate a tools-list section when manual is missing',
      );
      assert.ok(
        zh.includes('与人类用户确认意图与边界'),
        'zh mcp manual should remind team manager to confirm intent with human user',
      );
      assert.ok(
        zh.includes('不可用时业务处置规约'),
        'zh mcp manual should require unavailable-case business handling rules',
      );
      assert.ok(
        zh.includes('半结构化'),
        'zh mcp manual should recommend semi-structured chapters rather than a rigid template',
      );
      assert.ok(
        zh.includes('是否必须找协调者/专员接手'),
        'zh mcp manual should spell out escalation/fallback questions for unavailable MCP toolsets',
      );
      assert.ok(
        en.includes('toolset availability is unaffected'),
        'en mcp manual should explicitly say missing manual does not affect availability',
      );
      assert.ok(
        en.includes('Section: Tools list (runtime snapshot)'),
        'en mcp manual should auto-generate a tools-list section when manual is missing',
      );
      assert.ok(
        en.includes('confirm intent/boundaries with the human user'),
        'en mcp manual should remind team manager to confirm intent with human user',
      );
      assert.ok(
        en.includes('unavailable-case business handling rules'),
        'en mcp manual should require unavailable-case business handling rules',
      );
      assert.ok(
        en.includes('semi-structured chapter shape'),
        'en mcp manual should recommend semi-structured chapters rather than a rigid template',
      );
      assert.ok(
        en.includes('whether a temporarily unavailable toolset must be escalated'),
        'en mcp manual should spell out escalation/fallback questions for unavailable MCP toolsets',
      );
      assert.ok(
        zhTroubleshooting.includes('暂态问题') ||
          zhTroubleshooting.includes('服务恢复后重跑通常即可正常'),
        'zh troubleshooting manual should explain that some MCP validation failures are transient',
      );
      assert.ok(
        enTroubleshooting.includes('transient runtime-availability issues') ||
          enTroubleshooting.includes('rerunning after recovery will often clear the problem'),
        'en troubleshooting manual should explain that some MCP validation failures are transient',
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
      '        - title: "Business Handling When Unavailable"',
      '          content: "If temporarily unavailable, ask @coordinator before using fallback paths."',
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
      assert.ok(
        en.includes('Business Handling When Unavailable'),
        'mcp manual should render unavailable-case business handling section titles',
      );
      assert.ok(
        en.includes('ask @coordinator before using fallback paths'),
        'mcp manual should render unavailable-case business handling section content',
      );
    },
  );

  console.log('team_mgmt manual via man mcp-manual-hints tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual via man mcp-manual-hints tests: failed: ${message}`);
  process.exit(1);
});
