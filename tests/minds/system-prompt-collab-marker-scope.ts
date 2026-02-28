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
      '发起 \\`tellask\\` / \\`tellaskSessionless\\` 时，\\`tellaskContent\\` 必须是业务正文，不应手写任何回贴标记；若写回贴格式，必须显式要求“禁止手写，Dominds 自动注入标记”。',
    ),
  );
  assert.ok(
    zhMainline.includes(
      '当你在诉请正文里定义“回贴格式/交付格式”时，必须明确写入：`Dominds 会自动注入回贴标记，禁止手写标记`；不得要求被诉请者手写 `【最终完成】` / `【tellaskBack】` / FBR 标记。',
    ),
  );
  assert.ok(
    !zhMainline.includes(
      '回贴文本标记由运行时在展示层自动添加（常规完成=【最终完成】；FBR=【FBR-直接回复】或【FBR-仅推理】），不会改写正文；你无需、也不应手写标记。',
    ),
  );

  const enMainline = buildPrompt('mainline', 'en');
  assert.ok(
    enMainline.includes(
      'When initiating \\`tellask\\` / \\`tellaskSessionless\\`, \\`tellaskContent\\` must stay as business body and must not hand-write reply markers; if you specify a reply format, explicitly require “no hand-written markers, Dominds auto-injects markers”.',
    ),
  );
  assert.ok(
    enMainline.includes(
      'When you define a “reply/delivery format” inside tellask body, you must explicitly include: `Dominds auto-injects reply markers; do not hand-write markers`; do not require the responder to hand-write `【最终完成】` / `【tellaskBack】` / FBR markers.',
    ),
  );
  assert.ok(
    !enMainline.includes(
      'Reply markers are runtime-added in the presentation layer (regular completed reply = 【最终完成】; FBR = 【FBR-直接回复】 or 【FBR-仅推理】) without rewriting body text; do not hand-write markers.',
    ),
  );

  const zhSideline = buildPrompt('sideline', 'zh');
  assert.ok(
    zhSideline.includes(
      '回贴文本标记由运行时在跨对话传递正文中自动添加（常规完成=【最终完成】；FBR=【FBR-直接回复】或【FBR-仅推理】）；该正文直接进入上游上下文，且 UI 展示与其一致。你无需、也不应手写标记。',
    ),
  );
  assert.ok(
    zhSideline.includes(
      '若你在正文中给下游写“回贴格式”，必须写明“Dominds 自动注入标记，禁止手写”；不得要求下游手写任何标记。',
    ),
  );
  assert.ok(
    zhSideline.includes('本规则仅用于当前支线向上游诉请者回贴，不适用于你发起新的 tellask。'),
  );
  assert.ok(
    zhSideline.includes(
      '当前支线未完成/不确定/阻塞时：必须调用 \\`tellaskBack({ tellaskContent: "..." })\\`，不得发普通文本中间汇报。',
    ),
  );

  const enSideline = buildPrompt('sideline', 'en');
  assert.ok(
    enSideline.includes(
      'Reply markers are runtime-added in the inter-dialog transfer payload (regular completed reply = 【最终完成】; FBR = 【FBR-直接回复】 or 【FBR-仅推理】); this payload is delivered to upstream context and shown identically in UI. Do not hand-write markers.',
    ),
  );
  assert.ok(
    enSideline.includes(
      'If you define a reply format for downstream, you must state “Dominds auto-injects markers; do not hand-write them”; do not require downstream to hand-write any marker.',
    ),
  );
  assert.ok(
    enSideline.includes(
      'This rule applies only when posting upstream from the current sideline, not when initiating a new tellask.',
    ),
  );
  assert.ok(
    enSideline.includes(
      'If the current sideline is unfinished/uncertain/blocked: you must call \\`tellaskBack({ tellaskContent: "..." })\\` instead of posting a plain-text progress update.',
    ),
  );

  console.log('✅ system-prompt-collab-marker-scope: ok');
}

main();
