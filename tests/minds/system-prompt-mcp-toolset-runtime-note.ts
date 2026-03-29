import assert from 'node:assert/strict';
import { buildSystemPrompt, formatMcpToolsetRuntimeNote } from '../../main/minds/system-prompt';
import { Team } from '../../main/team';

function buildPrompt(language: 'zh' | 'en'): string {
  const agent = new Team.Member({ id: 'tester', name: 'Tester' });
  const note = formatMcpToolsetRuntimeNote(language, [
    {
      toolsetName: 'chatgpt-workstation',
      transport: 'streamable_http',
      errorText: 'connect ECONNREFUSED 127.0.0.1:8787',
    },
  ]);

  return buildSystemPrompt({
    language,
    dialogScope: 'mainline',
    contextHealthPromptMode: 'normal',
    agent,
    persona: 'persona',
    knowledge: 'knowledge',
    lessons: 'lessons',
    skillsText: 'skills',
    envIntro: 'env',
    teamIntro: 'team',
    funcToolRulesText: '',
    policyText: 'policy',
    intrinsicToolUsageText: 'intrinsic',
    toolsetManualIntro: 'manual',
    mcpToolsetRuntimeNote: note,
  });
}

async function main(): Promise<void> {
  const zhPrompt = buildPrompt('zh');
  assert.ok(zhPrompt.includes('## MCP 工具集当前状态'));
  assert.ok(zhPrompt.includes('请将它们视为“当前暂时不可达”的运行时情况'));
  assert.ok(zhPrompt.includes('这不代表你的权限被撤销，也不应视为系统级功能降级'));
  assert.ok(zhPrompt.includes('`chatgpt-workstation`'));
  assert.ok(zhPrompt.includes('connect ECONNREFUSED 127.0.0.1:8787'));

  const enPrompt = buildPrompt('en');
  assert.ok(enPrompt.includes('## MCP Toolset Runtime Status'));
  assert.ok(enPrompt.includes('Treat this as a temporary runtime-availability condition'));
  assert.ok(
    enPrompt.includes(
      'This does not mean your permission was revoked, and it should not be treated as a system-level capability downgrade.',
    ),
  );
  assert.ok(enPrompt.includes('status=temporarily unavailable'));
  assert.ok(enPrompt.includes('connect ECONNREFUSED 127.0.0.1:8787'));

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
