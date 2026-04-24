import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../main/minds/system-prompt';
import { Team } from '../../main/team';

function buildPrompt(mode: 'normal' | 'caution' | 'critical'): string {
  const agent = new Team.Member({ id: 'tester', name: 'Tester' });
  return buildSystemPrompt({
    language: 'zh',
    dialogScope: 'mainDialog',
    contextHealthPromptMode: mode,
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
  });
}

async function main(): Promise<void> {
  const normal = buildPrompt('normal');
  assert.ok(
    normal.includes('当前没有生效中的上下文健康处置指令，可以按正常流程进行 FBR'),
    'normal system prompt should allow normal FBR flow directly',
  );
  assert.ok(
    !normal.includes('如果有吃紧/告急提示'),
    'normal system prompt should not use self-judged alert conditionals',
  );

  const caution = buildPrompt('caution');
  assert.ok(
    caution.includes('当前上下文处于系统吃紧处置态：本程不要发起 FBR'),
    'caution system prompt should directly prohibit FBR in the current course',
  );
  assert.ok(
    caution.includes('先按处置要求把尚未落实到差遣牒、且下一程需要知会的讨论细节写入合适章节'),
    'caution system prompt should prescribe documenting unrecorded discussion details first',
  );
  assert.ok(
    caution.includes('再提炼提醒项并尽快 `clear_mind`'),
    'caution system prompt should still prescribe reminder distillation and clear_mind',
  );

  const critical = buildPrompt('critical');
  assert.ok(
    critical.includes('当前上下文处于系统告急处置态：本程禁止发起 FBR'),
    'critical system prompt should directly prohibit FBR in the current course',
  );
  assert.ok(
    critical.includes('先按处置要求把尚未落实到差遣牒、且下一程需要知会的讨论细节写入合适章节'),
    'critical system prompt should prescribe documenting unrecorded discussion details first',
  );
  assert.ok(
    critical.includes('再维护接续包提醒项，并立即 `clear_mind`'),
    'critical system prompt should directly prescribe immediate clear_mind',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
