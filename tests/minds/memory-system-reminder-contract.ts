import assert from 'node:assert/strict';
import { buildMemorySystemPrompt } from '../../main/minds/system-prompt-parts';

async function main(): Promise<void> {
  const zh = buildMemorySystemPrompt({
    language: 'zh',
    agentId: 'tester',
    isSubdialog: false,
    taskdocMaintainerId: 'maintainer',
    agentHasTeamMemoryTools: false,
    agentHasPersonalMemoryTools: false,
    agentIsShellSpecialist: false,
    agentHasShellTools: false,
    agentHasReadonlyShell: false,
    shellSpecialistMemberIds: [],
    contextHealthPromptMode: 'normal',
  });
  assert.ok(
    zh.includes('`progress` 是全队共享、准实时、可扫读的任务公告牌'),
    'zh prompt should define progress as the team-shared quasi-real-time task bulletin board',
  );
  assert.ok(
    zh.includes('`goals` / `constraints` 是较稳定的任务契约'),
    'zh prompt should define goals/constraints as the stable task contract',
  );
  assert.ok(
    zh.includes('当前没有生效中的上下文健康处置指令'),
    'zh normal prompt should contain the normal context-health directive',
  );
  assert.ok(
    zh.includes('完整当前快照'),
    'zh prompt should require progress updates to preserve a full current snapshot',
  );
  assert.ok(
    zh.includes('差遣牒未覆盖'),
    'zh prompt should distinguish Taskdoc-covered vs volatile details',
  );
  assert.ok(
    zh.includes('只有系统实际开启新一程后，第一步才是以清醒头脑复核并整理'),
    'zh prompt should pin clear-headed review to the system-started new course',
  );
  assert.ok(
    !zh.includes('若已吃紧/告急'),
    'zh prompt should avoid self-judged caution/critical wording',
  );

  const en = buildMemorySystemPrompt({
    language: 'en',
    agentId: 'tester',
    isSubdialog: true,
    taskdocMaintainerId: 'maintainer',
    agentHasTeamMemoryTools: false,
    agentHasPersonalMemoryTools: false,
    agentIsShellSpecialist: false,
    agentHasShellTools: false,
    agentHasReadonlyShell: false,
    shellSpecialistMemberIds: [],
    contextHealthPromptMode: 'critical',
  });
  assert.ok(
    en.includes('`progress` is the team-shared, quasi-real-time, scannable task bulletin board'),
    'en prompt should define progress as the team-shared quasi-real-time task bulletin board',
  );
  assert.ok(
    en.includes('`goals` / `constraints` are the more stable task contract'),
    'en prompt should define goals/constraints as the stable task contract',
  );
  assert.ok(
    en.includes('Current context is under system critical remediation'),
    'en critical prompt should contain the critical context-health directive',
  );
  assert.ok(
    en.includes('complete, team-scannable current snapshot'),
    'en prompt should require progress updates to preserve a full current snapshot',
  );
  assert.ok(
    en.includes('not already covered by Taskdoc'),
    'en prompt should distinguish Taskdoc-covered vs volatile details',
  );
  assert.ok(
    en.includes('rough multi-reminder bridge notes are acceptable'),
    'en critical prompt should allow rough bridge reminders during remediation',
  );
  assert.ok(
    en.includes(
      'Once the system actually starts the new course, the first step is to review/rewrite them',
    ),
    'en prompt should pin clear-headed review to the system-started new course',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
