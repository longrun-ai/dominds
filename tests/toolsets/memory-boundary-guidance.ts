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
  toolsetId: 'personal_memory' | 'team_memory' | 'control',
  topic: 'principles',
): Promise<string> {
  return await renderToolsetManualContent({
    toolsetId,
    language: lang,
    topic,
  });
}

function assertPersonalMemoryRecommendationsIncludeCompanionToolsets(
  manual: string,
  label: string,
): void {
  const personalMemoryLines = manual
    .split('\n')
    .filter((line) => line.includes('`personal_memory`'));
  assert.ok(personalMemoryLines.length > 0, `${label} should mention personal_memory`);
  for (const line of personalMemoryLines) {
    assert.ok(
      line.includes('`skills`') && line.includes('`resources`'),
      `${label} personal_memory recommendation should also mention skills/resources: ${line}`,
    );
  }
}

async function main(): Promise<void> {
  const zhTeamManual = await renderManual('zh', 'team_mgmt', ['team']);
  assertPersonalMemoryRecommendationsIncludeCompanionToolsets(
    zhTeamManual,
    'zh team_mgmt team manual',
  );

  const zhMinds = await renderManual('zh', 'team_mgmt', ['minds']);
  assert.ok(
    zhMinds.includes('角色级长期定义资产'),
    'zh team_mgmt minds manual should define persona/knowhow/pitfalls as role-level long-lived assets',
  );
  assert.ok(
    zhMinds.includes('成员个人长期可复用经验与个人工作索引 -> `personal_memory`'),
    'zh team_mgmt minds manual should route personal reusable experience to personal_memory',
  );
  assertPersonalMemoryRecommendationsIncludeCompanionToolsets(zhMinds, 'zh team_mgmt minds manual');
  assert.ok(
    zhMinds.includes('Taskdoc `progress`（准实时任务公告牌）'),
    'zh team_mgmt minds manual should define Taskdoc progress as the quasi-real-time task bulletin board',
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
    zhPersonal.includes('准实时任务公告牌'),
    'zh personal_memory manual should route team-synced current state to Taskdoc progress bulletin board',
  );
  assert.ok(
    zhPersonal.includes('与 skills 的边界') &&
      zhPersonal.includes('工作区关联强的事实、路径、局部契约、职责域索引') &&
      zhPersonal.includes('独立于工作区内容的操作方法、检查清单、触发条件与边界'),
    'zh personal_memory manual should route workspace-coupled facts to memory and reusable methods to skills',
  );

  const zhTeam = await renderToolsetTopic('zh', 'team_memory', 'principles');
  assert.ok(
    zhTeam.includes('三分法边界'),
    'zh team_memory manual should include the three-way boundary split',
  );
  assert.ok(
    zhTeam.includes('准实时任务公告牌'),
    'zh team_memory manual should reject temporary task state in team memory',
  );
  assert.ok(
    zhTeam.includes('不要把通用操作规程、审查清单、调试套路或团队协作 SOP 写成 team memory') &&
      zhTeam.includes('应写成团队共享 skill') &&
      zhTeam.includes('路径索引与绑定关系'),
    'zh team_memory manual should route generic SOPs to team-shared skills and keep rtws bindings in memory',
  );

  const zhControl = await renderToolsetTopic('zh', 'control', 'principles');
  assert.ok(
    zhControl.includes('准实时全队任务公告牌'),
    'zh control manual should define Taskdoc progress as a quasi-real-time team task bulletin board',
  );
  assert.ok(
    zhControl.includes('当前有效状态快照'),
    'zh control manual should describe progress as the current effective-state snapshot',
  );

  const enTeamManual = await renderManual('en', 'team_mgmt', ['team']);
  assertPersonalMemoryRecommendationsIncludeCompanionToolsets(
    enTeamManual,
    'en team_mgmt team manual',
  );

  const enMinds = await renderManual('en', 'team_mgmt', ['minds']);
  assert.ok(
    enMinds.includes('role-level long-lived definition assets'),
    'en team_mgmt minds manual should define persona/knowhow/pitfalls as role-level long-lived assets',
  );
  assertPersonalMemoryRecommendationsIncludeCompanionToolsets(enMinds, 'en team_mgmt minds manual');
  assert.ok(
    enMinds.includes('quasi-real-time task bulletin board'),
    'en team_mgmt minds manual should define Taskdoc progress as the quasi-real-time task bulletin board',
  );

  const enPersonal = await renderToolsetTopic('en', 'personal_memory', 'principles');
  assert.ok(
    enPersonal.includes('Boundary with skills') &&
      enPersonal.includes('workspace-coupled facts, paths, local contracts') &&
      enPersonal.includes(
        'workspace-independent operating methods, checklists, triggers, and boundaries',
      ),
    'en personal_memory manual should route workspace-coupled facts to memory and reusable methods to skills',
  );

  const enTeam = await renderToolsetTopic('en', 'team_memory', 'principles');
  assert.ok(
    enTeam.includes('Do not store generic operating procedures, review checklists') &&
      enTeam.includes('team collaboration SOPs as team memory') &&
      enTeam.includes('write a team-shared skill instead') &&
      enTeam.includes('path indexes, and bindings'),
    'en team_memory manual should route generic SOPs to team-shared skills and keep rtws bindings in memory',
  );

  const enControl = await renderToolsetTopic('en', 'control', 'principles');
  assert.ok(
    enControl.includes('quasi-real-time team task bulletin board'),
    'en control manual should define Taskdoc progress as a quasi-real-time team task bulletin board',
  );
  assert.ok(
    enControl.includes('current effective-state snapshot'),
    'en control manual should describe progress as the current effective-state snapshot',
  );

  console.log('memory boundary guidance tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`memory boundary guidance tests: failed: ${message}`);
  process.exit(1);
});
