import assert from 'node:assert/strict';
import { buildSystemPrompt, formatMcpToolsetRuntimeNote } from '../../main/minds/system-prompt';
import { Team } from '../../main/team';

function buildPrompt(language: 'zh' | 'en'): string {
  const agent = new Team.Member({ id: 'tester', name: 'Tester' });
  const note = formatMcpToolsetRuntimeNote(language, [
    {
      toolsetName: 'chatgpt-workstation',
      transport: 'streamable_http',
      status: 'temporarily_unavailable',
      errorText: 'connect ECONNREFUSED 127.0.0.1:8787',
    },
    {
      toolsetName: 'disabled-browser',
      transport: 'unknown',
      status: 'disabled',
    },
  ]);

  return buildSystemPrompt({
    language,
    dialogScope: 'mainDialog',
    contextHealthPromptMode: 'normal',
    agent,
    persona: 'persona',
    knowhow: 'knowhow',
    pitfalls: 'pitfalls',
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
  assert.ok(zhPrompt.includes('有些可能是被明确禁用'));
  assert.ok(zhPrompt.includes('这不代表你的权限被撤销，也不应视为系统级功能降级'));
  assert.ok(zhPrompt.includes('`chatgpt-workstation`'));
  assert.ok(zhPrompt.includes('状态=暂时不可达'));
  assert.ok(zhPrompt.includes('connect ECONNREFUSED 127.0.0.1:8787'));
  assert.ok(zhPrompt.includes('`disabled-browser`'));
  assert.ok(zhPrompt.includes('状态=已禁用'));
  assert.ok(zhPrompt.includes('0 工具的 MCP toolset'));

  const enPrompt = buildPrompt('en');
  assert.ok(enPrompt.includes('## MCP Toolset Runtime Status'));
  assert.ok(enPrompt.includes('some may be explicitly disabled'));
  assert.ok(
    enPrompt.includes(
      'This does not mean your permission was revoked, and it should not be treated as a system-level capability downgrade.',
    ),
  );
  assert.ok(enPrompt.includes('status=temporarily unavailable'));
  assert.ok(enPrompt.includes('connect ECONNREFUSED 127.0.0.1:8787'));
  assert.ok(enPrompt.includes('`disabled-browser`'));
  assert.ok(enPrompt.includes('status=disabled'));
  assert.ok(enPrompt.includes('zero tools'));

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
