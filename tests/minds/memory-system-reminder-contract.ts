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
  });
  assert.ok(zh.includes('多条粗略提醒项'), 'zh prompt should allow rough multi-reminder bridge');
  assert.ok(
    zh.includes('差遣牒未覆盖'),
    'zh prompt should distinguish Taskdoc-covered vs volatile details',
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
  });
  assert.ok(
    en.includes('multiple rough reminders'),
    'en prompt should allow rough multi-reminder bridge',
  );
  assert.ok(
    en.includes('not already covered by Taskdoc'),
    'en prompt should distinguish Taskdoc-covered vs volatile details',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
