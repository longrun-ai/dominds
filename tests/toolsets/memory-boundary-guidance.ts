#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { Team } from '../../main/team';
import '../../main/tools/builtins';
import {
  buildToolsetManualTools,
  renderToolsetManualContent,
} from '../../main/tools/toolset-manual';

async function renderManual(
  lang: 'zh' | 'en',
  toolsetId: 'team_mgmt' | 'personal_memory' | 'team_memory',
  topics?: ReadonlyArray<string>,
): Promise<string> {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((entry) => entry.name === 'man');
  assert.ok(tool, 'man tool should be available');
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({
    id: 'tester',
    name: 'Tester',
    toolsets: ['team_mgmt', 'personal_memory', 'team_memory'],
  });
  return (
    await tool.call(
      dlg as never,
      caller,
      topics ? { toolsetId, topics: [...topics] } : { toolsetId },
    )
  ).content;
}

async function renderToolsetTopic(
  lang: 'zh' | 'en',
  toolsetId: 'personal_memory' | 'team_memory',
  topic: 'principles',
): Promise<string> {
  return await renderToolsetManualContent({
    toolsetId,
    language: lang,
    topic,
    availableToolNames: new Set<string>(),
  });
}

async function main(): Promise<void> {
  const zhMinds = await renderManual('zh', 'team_mgmt', ['minds']);
  assert.ok(
    zhMinds.includes('角色级长期定义资产'),
    'zh team_mgmt minds manual should define persona/knowhow/pitfalls as role-level long-lived assets',
  );
  assert.ok(
    zhMinds.includes('成员个人长期可复用经验与个人工作索引 -> `personal_memory`'),
    'zh team_mgmt minds manual should route personal reusable experience to personal_memory',
  );
  assert.ok(
    zhMinds.includes('Taskdoc `progress` 或 reminders'),
    'zh team_mgmt minds manual should route current task progress to Taskdoc/reminders',
  );

  const zhPermissions = await renderManual('zh', 'team_mgmt', ['permissions']);
  assert.ok(
    zhPermissions.includes('只有持有 `team_mgmt` 的成员才应修改'),
    'zh permissions manual should make team_mgmt ownership explicit for team assets',
  );
  assert.ok(
    zhPermissions.includes('不构成任何额外写权限'),
    'zh permissions manual should clarify that role ownership does not grant write permission',
  );

  const zhPersonal = await renderToolsetTopic('zh', 'personal_memory', 'principles');
  assert.ok(
    zhPersonal.includes('角色级长期定义资产'),
    'zh personal_memory manual should distinguish role assets from personal memory',
  );
  assert.ok(
    zhPersonal.includes('当前任务进展、临时 bridge 信息、短期待办'),
    'zh personal_memory manual should push short-term task state out of personal memory',
  );

  const zhTeam = await renderToolsetTopic('zh', 'team_memory', 'principles');
  assert.ok(
    zhTeam.includes('三分法边界'),
    'zh team_memory manual should include the three-way boundary split',
  );
  assert.ok(
    zhTeam.includes('不要把当前任务进展、临时 blocker、短期 bridge 信息写进 `team_memory`'),
    'zh team_memory manual should reject temporary task state in team memory',
  );

  const enMinds = await renderManual('en', 'team_mgmt', ['minds']);
  assert.ok(
    enMinds.includes('role-level long-lived definition assets'),
    'en team_mgmt minds manual should define persona/knowhow/pitfalls as role-level long-lived assets',
  );
  assert.ok(
    enMinds.includes('current task progress, temporary bridge notes, and short-term TODOs'),
    'en team_mgmt minds manual should route short-term task state away from role assets',
  );

  console.log('memory boundary guidance tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`memory boundary guidance tests: failed: ${message}`);
  process.exit(1);
});
