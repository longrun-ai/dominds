import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../main/minds/system-prompt';
import {
  formatAssignmentFromSupdialog,
  formatTellaskResponseContent,
  getRuntimeTransferMarkers,
} from '../../main/runtime/inter-dialog-format';
import { Team } from '../../main/team';

function buildPrompt(dialogScope: 'mainline' | 'sideline', language: LanguageCode): string {
  const agent = new Team.Member({ id: 'tester', name: 'Tester' });
  return buildSystemPrompt({
    language,
    dialogScope,
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
  });
}

function buildAssignmentPrompt(language: LanguageCode): string {
  return formatAssignmentFromSupdialog({
    callName: 'tellask',
    toAgentId: 'tester',
    fromAgentId: 'caller',
    tellaskContent: '请验收当前实现并给出结论。',
    mentionList: ['@tester'],
    sessionSlug: 'acceptance-check',
    language,
  });
}

function main(): void {
  const zhMarkers = getRuntimeTransferMarkers('zh');
  const enMarkers = getRuntimeTransferMarkers('en');

  const zhMainline = buildPrompt('mainline', 'zh');
  assert.ok(
    zhMainline.includes(
      '发起 `tellask` / `tellaskSessionless` 时，`tellaskContent` 必须是业务正文，不应手写任何回贴标记；若写回贴格式，必须显式要求“禁止手写，Dominds 自动注入标记”。',
    ),
  );
  assert.ok(
    zhMainline.includes(
      `当你在诉请正文里定义“回贴格式/交付格式”时，必须明确写入：\`Dominds 会自动注入回贴标记，禁止手写标记\`；不得要求被诉请者手写 \`${zhMarkers.finalCompleted}\` / \`${zhMarkers.tellaskBack}\` / FBR 标记（\`${zhMarkers.fbrDirectReply}\` / \`${zhMarkers.fbrReasoningOnly}\`）。`,
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
      'When initiating `tellask` / `tellaskSessionless`, `tellaskContent` must stay as business body and must not hand-write reply markers; if you specify a reply format, explicitly require “no hand-written markers, Dominds auto-injects markers”.',
    ),
  );
  assert.ok(
    enMainline.includes(
      `When you define a “reply/delivery format” inside tellask body, you must explicitly include: \`Dominds auto-injects reply markers; do not hand-write markers\`; do not require the responder to hand-write \`${enMarkers.finalCompleted}\` / \`${enMarkers.tellaskBack}\` / FBR markers (\`${enMarkers.fbrDirectReply}\` / \`${enMarkers.fbrReasoningOnly}\`).`,
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
      `回贴文本标记由运行时在跨对话传递正文中自动添加（常规完成=${zhMarkers.finalCompleted}；FBR=${zhMarkers.fbrDirectReply} 或 ${zhMarkers.fbrReasoningOnly}）；该正文直接进入上游上下文，且 UI 展示与其一致。你无需、也不应手写标记。`,
    ),
  );
  assert.ok(
    zhSideline.includes(
      '若你在正文中给下游写“回贴格式”，必须写明“Dominds 自动注入标记，禁止手写”；不得要求下游手写任何标记。',
    ),
  );
  assert.ok(
    zhSideline.includes(
      '本规则仅用于当前支线向上游回复；`tellask` 用于**发起新的下游诉请对话**（委托队友做事），不用于向上游汇报。',
    ),
  );
  assert.ok(
    zhSideline.includes(
      '当前支线未完成/不确定/阻塞/需要澄清时：必须调用 `tellaskBack({ tellaskContent: "..." })`，不得发普通文本中间汇报。',
    ),
  );
  assert.ok(
    zhSideline.includes(
      '`tellaskBack` 只允许用于回问/澄清/阻塞说明；禁止用 `tellaskBack` 发送最终结果。',
    ),
  );
  assert.ok(
    zhSideline.includes(
      '当前支线已完成并能给出最终交付时：只服从运行时程序化给出的当前指令。若运行时点名了精确 reply 函数，就调用那个函数；不要自行改选其他 `reply*` 变体，也不要再走 `tellaskBack`。',
    ),
  );
  assert.ok(
    zhSideline.includes(
      `仅当运行时当前明确点名了某个精确 reply 函数，且你通过那个函数回复时，运行时才会把该回复投递给上游并标注 ${zhMarkers.finalCompleted}。`,
    ),
  );
  assert.ok(
    zhSideline.includes(
      '若运行时当前明确提示“没有待完成的跨对话回复义务”，说明这轮不是待你收口的跨对话回复义务；不要重复调用 `reply*`。',
    ),
  );

  const enSideline = buildPrompt('sideline', 'en');
  assert.ok(
    enSideline.includes(
      `Reply markers are runtime-added in the inter-dialog transfer payload (regular completed reply = ${enMarkers.finalCompleted}; FBR = ${enMarkers.fbrDirectReply} or ${enMarkers.fbrReasoningOnly}); this payload is delivered to upstream context and shown identically in UI. Do not hand-write markers.`,
    ),
  );
  assert.ok(
    enSideline.includes(
      'If you define a reply format for downstream, you must state “Dominds auto-injects markers; do not hand-write them”; do not require downstream to hand-write any marker.',
    ),
  );
  assert.ok(
    enSideline.includes(
      'This rule applies only when replying upstream from the current sideline; tellask is for initiating a new downstream tellask dialog (delegating work to a teammate), not for reporting back to the requester.',
    ),
  );
  assert.ok(
    enSideline.includes(
      'If the current sideline is unfinished, uncertain, blocked, or needs clarification: you must call `tellaskBack({ tellaskContent: "..." })` instead of posting a plain-text progress update.',
    ),
  );
  assert.ok(
    enSideline.includes(
      '`tellaskBack` is allowed only for ask-back / clarification / blocked-state reporting; do not use `tellaskBack` to send final results.',
    ),
  );
  assert.ok(
    enSideline.includes(
      'If the current sideline is complete and can deliver the final result: follow only the current programmatic runtime instruction. If runtime names an exact reply function, call that function; do not switch among `reply*` variants yourself, and do not use `tellaskBack` for final delivery.',
    ),
  );
  assert.ok(
    enSideline.includes(
      `Runtime marks ${enMarkers.finalCompleted} and delivers upstream only when runtime currently names an exact reply function and you reply through that named function.`,
    ),
  );
  assert.ok(
    enSideline.includes(
      'If runtime currently tells you there is no active inter-dialog reply obligation, then this turn is not awaiting another inter-dialog closure from you; do not call `reply*` again.',
    ),
  );

  const zhAssignment = buildAssignmentPrompt('zh');
  assert.ok(
    zhAssignment.includes(
      '你是当前被诉请者对话（tellaskee dialog）的主理人；诉请者对话（tellasker dialog）为 @caller（当前发起本次诉请）。本轮精确完成回复函数名是 `replyTellask`；不要自行改选其他 `reply*` 变体。完成任务时必须调用 `replyTellask`；只有在需要回问上游时才调用 `tellaskBack`。',
    ),
  );

  const enAssignment = buildAssignmentPrompt('en');
  assert.ok(
    enAssignment.includes(
      'You are the responder (tellaskee dialog) for this dialog; the tellasker dialog is @caller (the current caller). The exact completion reply function for this round is `replyTellask`; do not switch to another `reply*` variant by yourself. When the task is complete, you must call `replyTellask`; call `tellaskBack` only when you need to ask back upstream.',
    ),
  );
  assert.ok(
    enAssignment.includes(
      `Protocol note: reply markers (for example \`${enMarkers.tellaskBack}\` / \`${enMarkers.finalCompleted}\` / FBR markers \`${enMarkers.fbrDirectReply}\` / \`${enMarkers.fbrReasoningOnly}\`) are auto-injected by Dominds runtime into the inter-dialog transfer payload.`,
    ),
  );

  const enCompletedReply = formatTellaskResponseContent({
    callName: 'tellask',
    responderId: 'tester',
    requesterId: 'caller',
    mentionList: ['@tester'],
    tellaskContent: 'Please review the current implementation.',
    responseBody: 'All checks passed.',
    status: 'completed',
    language: 'en',
  });
  assert.ok(
    enCompletedReply.startsWith(`${enMarkers.finalCompleted}\n\n@tester provided response:`),
  );

  const zhAskBackReply = formatTellaskResponseContent({
    callName: 'tellaskBack',
    responderId: 'tester',
    requesterId: 'caller',
    tellaskContent: '还缺少线上配置信息，请补充。',
    responseBody: '请确认生产环境端口。',
    status: 'failed',
    language: 'zh',
  });
  assert.ok(zhAskBackReply.startsWith(`${zhMarkers.tellaskBack}\n\n@tester 已回复：`));
  assert.equal(zhMarkers.tellaskBack, '【回问诉请】');

  const enFallbackReply = formatTellaskResponseContent({
    callName: 'tellaskSessionless',
    responderId: 'tester',
    requesterId: 'caller',
    mentionList: ['@tester'],
    tellaskContent: 'Please summarize the blocker.',
    responseBody: 'The blocker is still pending.',
    status: 'completed',
    deliveryMode: 'direct_fallback',
    language: 'en',
  });
  assert.ok(enFallbackReply.includes('did not use a replyTellask* tool'));

  console.log('✅ system-prompt-collab-marker-scope: ok');
}

main();
