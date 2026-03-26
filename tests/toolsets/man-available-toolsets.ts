#!/usr/bin/env tsx

import '../../main/tools/builtins';

import assert from 'node:assert/strict';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import { buildToolsetManualTools } from '../../main/tools/toolset-manual';

function createManTool() {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((t) => t.name === 'man');
  assert.ok(tool, 'man tool should be created');
  return tool;
}

async function main(): Promise<void> {
  setWorkLanguage('zh');
  const manTool = createManTool();
  const caller = new Team.Member({
    id: 'tester',
    name: 'Tester',
    toolsets: ['ws_read', 'team_memory'],
  });

  const output = await manTool.call({} as never, caller, {});

  assert.ok(output.includes('**可用工具集**'));
  assert.ok(output.includes('- `ws_read`'));
  assert.ok(output.includes('- `team_memory`'));
  assert.ok(!output.includes('运行时工作区只读访问'));
  assert.ok(output.includes('功能边界、参数写法、场景示例或错误处理不确定时'));

  console.log('man available-toolsets test: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`man available-toolsets test: failed: ${message}`);
  process.exit(1);
});
