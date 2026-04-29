#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Team } from '../../main/team';
import '../../main/tools/builtins';
import { buildMcpManualSpec, buildRawMcpManualSpec } from '../../main/tools/manual/spec';
import { registerToolset, setToolsetMeta, unregisterToolset } from '../../main/tools/registry';
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
  registerToolset('raw_mcp_test', [
    {
      type: 'func',
      name: 'raw_lookup',
      description: 'Lookup raw MCP records from the upstream server.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query.' },
        },
      },
      argsValidation: 'passthrough',
      async call() {
        return { outcome: 'success', content: 'ok' };
      },
    },
  ]);
  setToolsetMeta('raw_mcp_test', {
    source: 'mcp',
    descriptionI18n: {
      en: 'MCP server: raw_mcp_test',
      zh: 'MCP 服务器：raw_mcp_test',
    },
    manualNoticeI18n: {
      en: 'This toolset is a standard Raw MCP protocol integration. See the individual function-tool descriptions for the tool contract.',
      zh: '该工具集来自标准 MCP 协议接入，工具契约详见各工具函数说明。',
    },
    manualSpec: buildRawMcpManualSpec(),
  });
  try {
    const built = buildToolsetManualTools({
      toolsetNames: [],
      existingToolNames: new Set<string>(),
    });
    const man = built.tools.find((entry) => entry.name === 'man');
    assert.ok(man, 'man tool should be available');
    const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: ['raw_mcp_test'] });
    const dlg = { getLastUserLanguageCode: () => 'zh' as const };
    const rawManual = (
      await man.call(dlg as never, caller, { toolsetId: 'raw_mcp_test', topic: 'tools' })
    ).content;
    assert.ok(
      !rawManual.includes('手册章节缺失'),
      'raw MCP toolsets without manual.contentFile should not report missing manual sections',
    );
    assert.ok(
      rawManual.includes('工具函数说明'),
      'raw MCP toolsets without manual.contentFile should point to function-tool descriptions',
    );
    assert.ok(
      !rawManual.includes('raw_lookup') && !rawManual.includes('Search query.'),
      'raw MCP toolsets without manual.contentFile should not duplicate tool names or schema in man output',
    );
  } finally {
    unregisterToolset('raw_mcp_test');
  }

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
        'zh mcp manual should explicitly say an unconfigured manual does not affect availability',
      );
      assert.ok(
        zh.includes('章节：工具契约来源'),
        'zh mcp manual should explain where the tool contract comes from when manual is not configured',
      );
      assert.ok(
        zh.includes('与人类用户确认整体定位与边界'),
        'zh mcp manual should remind team manager to confirm overall positioning with human user',
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
        'en mcp manual should explicitly say an unconfigured manual does not affect availability',
      );
      assert.ok(
        en.includes('Section: Tool contract source'),
        'en mcp manual should explain where the tool contract comes from when manual is not configured',
      );
      assert.ok(
        en.includes('confirm the overall positioning and boundaries with the human user'),
        'en mcp manual should remind team manager to confirm overall positioning with human user',
      );
      assert.ok(
        en.includes('unavailable-case business handling rules') ||
          en.includes('which business actions must pause until this toolset recovers'),
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

  await withTempRtws(['version: 1', 'servers: {}', ''].join('\n'), async () => {
    await fs.mkdir(path.join(process.cwd(), '.minds', 'manuals', 'sdk'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), '.minds', 'manuals', 'sdk', 'scenarios.md'),
      '综合示例：先读取 SDK 元数据，再按业务目标选择调用路径。',
      'utf8',
    );
    await fs.writeFile(
      path.join(process.cwd(), '.minds', 'manuals', 'sdk', 'errors.md'),
      '避坑指南：不要把生产变更交给只读 SDK 查询 MCP。',
      'utf8',
    );
    registerToolset('sdk_stdio', [
      {
        type: 'func',
        name: 'lookup_sdk_meta',
        description: 'Lookup SDK metadata',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
          },
          required: ['query'],
        },
        argsValidation: 'passthrough',
        async call() {
          return { outcome: 'success', content: 'ok' };
        },
      },
    ]);
    setToolsetMeta('sdk_stdio', {
      source: 'mcp',
      descriptionI18n: {
        en: 'MCP server: sdk_stdio',
        zh: 'MCP 服务器：sdk_stdio',
      },
      manualSpec: buildMcpManualSpec('.minds/manuals/sdk'),
    });
    try {
      const built = buildToolsetManualTools({
        toolsetNames: [],
        existingToolNames: new Set<string>(),
      });
      const man = built.tools.find((entry) => entry.name === 'man');
      assert.ok(man, 'man tool should be available');
      const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: ['sdk_stdio'] });
      const dlg = { getLastUserLanguageCode: () => 'zh' as const };
      const rendered = (
        await man.call(dlg as never, caller, {
          toolsetId: 'sdk_stdio',
          topics: ['scenarios', 'errors'],
        })
      ).content;
      assert.ok(
        rendered.includes('综合示例') && rendered.includes('避坑指南'),
        'contentFile-backed MCP manuals should render handwritten scenarios/errors chapters',
      );
      assert.ok(
        !rendered.includes('lookup_sdk_meta') && !rendered.includes('Search query.'),
        'contentFile-backed MCP manuals should not auto-duplicate tool schema',
      );
    } finally {
      unregisterToolset('sdk_stdio');
    }
  });

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
      '      contentFile: .minds/manuals/sdk',
      '',
    ].join('\n'),
    async () => {
      const zh = await render('zh', ['mcp']);
      const en = await render('en', ['mcp']);

      assert.ok(
        zh.includes('运行时手册文件前缀（`contentFile`）：`.minds/manuals/sdk`'),
        'zh mcp manual should surface contentFile-backed runtime manual prefixes accurately',
      );
      assert.ok(
        zh.includes(
          '最终 `man({ "toolsetId": "sdk_stdio" })` 正文会在运行时从该前缀下的 topic 文件加载',
        ),
        'zh mcp manual should explain that contentFile-backed toolset manuals load their final body at runtime',
      );
      assert.ok(
        en.includes('Runtime manual file prefix (`contentFile`): `.minds/manuals/sdk`'),
        'en mcp manual should surface contentFile-backed runtime manual prefixes accurately',
      );
      assert.ok(
        en.includes('The final `man({ "toolsetId": "sdk_stdio" })` body is loaded at runtime'),
        'en mcp manual should explain that contentFile-backed toolset manuals load their final body at runtime',
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
