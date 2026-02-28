import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../main/minds/system-prompt';
import type { LanguageCode } from '../../main/shared/types/language';
import { Team } from '../../main/team';

function buildPrompt(dialogScope: 'mainline' | 'sideline', language: LanguageCode): string {
  const agent = new Team.Member({ id: 'tester', name: 'Tester' });
  return buildSystemPrompt({
    language,
    dialogScope,
    agent,
    persona: 'persona',
    knowledge: 'knowledge',
    lessons: 'lessons',
    envIntro: 'env',
    teamIntro: 'team',
    funcToolRulesText: '',
    policyText: 'policy',
    intrinsicToolUsageText: 'intrinsic',
    toolsetManualIntro: 'manual',
  });
}

function main(): void {
  const zhMainline = buildPrompt('mainline', 'zh');
  assert.ok(
    zhMainline.includes(
      '回贴首行标记规则仅适用于支线对话回贴上游诉请者；发起 \\`tellask\\` / \\`tellaskSessionless\\` 时，\\`tellaskContent\\` 不应加【tellaskBack】或【最终完成】。',
    ),
  );
  assert.ok(
    !zhMainline.includes(
      '内容标记（首行强制）：必须以【tellaskBack】或【最终完成】开头；FBR 用【FBR-直接回复】或【FBR-仅推理】；未标注视为违规。',
    ),
  );

  const enMainline = buildPrompt('mainline', 'en');
  assert.ok(
    enMainline.includes(
      'First-line reply marker rules apply only to sideline upstream posts; when initiating \\`tellask\\` / \\`tellaskSessionless\\`, \\`tellaskContent\\` should not carry 【tellaskBack】 or 【最终完成】.',
    ),
  );
  assert.ok(
    !enMainline.includes(
      'Content marking (first line required): must start with 【tellaskBack】 or 【最终完成】; FBR uses 【FBR-直接回复】 or 【FBR-仅推理】; missing markers are violations.',
    ),
  );

  const zhSideline = buildPrompt('sideline', 'zh');
  assert.ok(
    zhSideline.includes(
      '回贴标记（首行强制，仅用于当前支线向上游诉请者回贴）：必须以【tellaskBack】或【最终完成】开头；FBR 用【FBR-直接回复】或【FBR-仅推理】；未标注视为违规。',
    ),
  );
  assert.ok(
    zhSideline.includes('本规则仅用于当前支线向上游诉请者回贴，不适用于你发起新的 tellask。'),
  );

  const enSideline = buildPrompt('sideline', 'en');
  assert.ok(
    enSideline.includes(
      'Reply markers (first line required, only for upstream posts from the current sideline): must start with 【tellaskBack】 or 【最终完成】; FBR uses 【FBR-直接回复】 or 【FBR-仅推理】; missing markers are violations.',
    ),
  );
  assert.ok(
    enSideline.includes(
      'This rule applies only when posting upstream from the current sideline, not when initiating a new tellask.',
    ),
  );

  console.log('✅ system-prompt-collab-marker-scope: ok');
}

main();
