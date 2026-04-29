#!/usr/bin/env tsx

import '../../main/tools/builtins';

import assert from 'node:assert/strict';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import { setToolsetMeta } from '../../main/tools/registry';
import { buildToolsetManualTools } from '../../main/tools/toolset-manual';

function createManTool() {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((t) => t.name === 'man');
  assert.ok(tool, 'man tool should be created');
  return tool;
}

type LanguageAwareDialog = { getLastUserLanguageCode(): 'en' };

async function main(): Promise<void> {
  setToolsetMeta('ws_read', {
    source: 'dominds',
    descriptionI18n: { en: 'rtws read-only tools', zh: '运行时工作区只读工具' },
    manualSpec: {
      topics: ['index', 'tools', 'errors'],
      warnOnMissing: true,
      topicFilesI18n: {
        en: {
          index: 'prompts/ws_read/en/index.md',
          tools: 'prompts/ws_read/en/tools.md',
          errors: 'prompts/ws_read/en/__missing__.md',
        },
        zh: {
          index: 'prompts/ws_read/zh/index.md',
          tools: 'prompts/ws_read/zh/tools.md',
          errors: 'prompts/ws_read/zh/__missing__.md',
        },
      },
    },
  });

  setWorkLanguage('en');
  const manTool = createManTool();
  const caller = new Team.Member({
    id: 'tester',
    name: 'Tester',
    toolsets: ['ws_read'],
  });

  const output = (
    await manTool.call({} as LanguageAwareDialog as never, caller, {
      toolsetId: 'ws_read',
      topics: ['index', 'errors'],
    })
  ).content;

  assert.ok(output.includes('⚠️ Missing manual sections'));
  assert.ok(output.includes('`errors`: missing'));
  assert.ok(output.includes('prompts/ws_read/en/__missing__.md'));
  assert.ok(output.includes('### Overview'));

  console.log('man missing-section warning test: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`man missing-section warning test: failed: ${message}`);
  process.exit(1);
});
