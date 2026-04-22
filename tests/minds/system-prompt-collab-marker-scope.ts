import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../main/minds/system-prompt';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
  getRuntimeTransferMarkers,
} from '../../main/runtime/inter-dialog-format';
import {
  buildSideDialogCompletionRule,
  buildSideDialogRoleHeaderCopy,
} from '../../main/runtime/reply-prompt-copy';
import { Team } from '../../main/team';

function buildPrompt(dialogScope: 'mainDialog' | 'sideDialog', language: LanguageCode): string {
  const agent = new Team.Member({ id: 'tester', name: 'Tester' });
  return buildSystemPrompt({
    language,
    dialogScope,
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
  });
}

function buildAssignmentPrompt(language: LanguageCode): string {
  return formatAssignmentFromAskerDialog({
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

  const zhMainDialog = buildPrompt('mainDialog', 'zh');
  assert.ok(
    zhMainDialog.includes(
      '发起 `tellask` / `tellaskSessionless` 时，`tellaskContent` 必须是业务正文，不应手写任何回贴标记；若写回贴格式，只描述业务交付结构即可。',
    ),
  );
  assert.ok(
    zhMainDialog.includes(
      `当你在诉请正文里定义“回贴格式/交付格式”时，只写业务交付结构即可；不要要求被诉请者手写 \`${zhMarkers.finalCompleted}\` / \`${zhMarkers.tellaskBack}\` / FBR 标记（\`${zhMarkers.fbrDirectReply}\` / \`${zhMarkers.fbrReasoningOnly}\`），这些标记由 Dominds 运行时自动注入。`,
    ),
  );
  assert.ok(!zhMainDialog.includes('Dominds 会自动注入回贴标记，禁止手写标记'));
  assert.ok(
    zhMainDialog.includes(
      '“⏳ 进行中诉请”提醒项只是系统状态窗，不是控制面：内容不可手改；当存在非 0 路进行中诉请时，不可删除，误删会被拒绝并返回引导文案。',
    ),
    'zh Main Dialog prompt should explain active pending-tellask reminders are non-deletable',
  );
  assert.ok(
    zhMainDialog.includes(
      '只有长线诉请（`tellask` + `sessionSlug`）才有“更新任务安排”的通道；一次性诉请（`tellaskSessionless`）没有这个通道。',
    ),
    'zh Main Dialog prompt should explain tellaskSessionless has no assignment-update channel',
  );
  assert.ok(
    !zhMainDialog.includes(
      '回贴文本标记由运行时在展示层自动添加（常规完成=【最终完成】；FBR=【FBR-直接回复】或【FBR-仅推理】），不会改写正文；你无需、也不应手写标记。',
    ),
  );

  const enMainDialog = buildPrompt('mainDialog', 'en');
  assert.ok(
    enMainDialog.includes(
      'When initiating `tellask` / `tellaskSessionless`, `tellaskContent` must stay as business body and must not hand-write reply markers; if you specify a reply format, describe only the business delivery structure.',
    ),
  );
  assert.ok(
    enMainDialog.includes(
      `When you define a “reply/delivery format” inside tellask body, keep it to the business delivery structure; do not require the responder to hand-write \`${enMarkers.finalCompleted}\` / \`${enMarkers.tellaskBack}\` / FBR markers (\`${enMarkers.fbrDirectReply}\` / \`${enMarkers.fbrReasoningOnly}\`), because Dominds runtime injects those markers automatically.`,
    ),
  );
  assert.ok(
    !enMainDialog.includes('Dominds auto-injects reply markers; do not hand-write markers'),
  );
  assert.ok(
    enMainDialog.includes(
      'The “⏳ In-flight Tellasks” reminder is only a system status window, not a control surface: its content is not hand-editable; while any Tellask is still active, it is not deletable, and mistaken deletion will be rejected with guidance.',
    ),
    'en Main Dialog prompt should explain active pending-tellask reminders are non-deletable',
  );
  assert.ok(
    enMainDialog.includes(
      'Only a sessioned Tellask (`tellask` + `sessionSlug`) has an assignment-update channel. A one-shot Tellask (`tellaskSessionless`) has no such channel:',
    ),
    'en Main Dialog prompt should explain tellaskSessionless has no assignment-update channel',
  );
  assert.ok(
    !enMainDialog.includes(
      'Reply markers are runtime-added in the presentation layer (regular completed reply = 【最终完成】; FBR = 【FBR-直接回复】 or 【FBR-仅推理】) without rewriting body text; do not hand-write markers.',
    ),
  );

  const zhSideDialog = buildPrompt('sideDialog', 'zh');
  assert.ok(
    zhSideDialog.includes(
      `回贴文本标记由运行时在跨对话传递正文中自动添加（常规完成=${zhMarkers.finalCompleted}；FBR=${zhMarkers.fbrDirectReply} 或 ${zhMarkers.fbrReasoningOnly}）；该正文直接进入诉请者上下文，且 UI 展示与其一致。你无需、也不应手写标记。`,
    ),
  );
  assert.ok(
    zhSideDialog.includes(
      '若你在正文中给下游写“回贴格式”，只写业务交付结构；不得要求下游手写任何标记，运行时会自动注入。',
    ),
  );
  assert.ok(
    zhSideDialog.includes(
      '本规则仅用于当前支线向诉请者回复；`tellask` 用于**发起新的下游诉请对话**（委托队友做事），不用于向诉请者汇报。',
    ),
  );
  assert.ok(
    zhSideDialog.includes(
      '当前支线未完成时，不得把“阻塞/不确定”机械等同于 `tellaskBack`；若团队规程/SOP/职责卡已明确负责人，应直接 `tellask` / `tellaskSessionless` 对应负责人，不得发普通文本中间汇报。',
    ),
  );
  assert.ok(
    zhSideDialog.includes(
      '`tellaskBack` 只允许用于回问诉请者；仅当必须向诉请者补需求/澄清/裁决/缺失输入，或现有团队规程无法明确判责时才使用。禁止用 `tellaskBack` 发送最终结果。',
    ),
  );
  assert.ok(zhSideDialog.includes(buildSideDialogCompletionRule('zh')));
  assert.ok(
    zhSideDialog.includes(
      `仅当运行时当前明确点名了某个精确 reply 函数，且你通过那个函数回复时，运行时才会把该回复投递给诉请者并标注 ${zhMarkers.finalCompleted}。`,
    ),
  );
  assert.ok(
    zhSideDialog.includes(
      '若运行时当前明确提示“没有待完成的跨对话回复义务”，说明这轮不是待你收口的跨对话回复义务；不要重复调用 `reply*`。',
    ),
  );

  const enSideDialog = buildPrompt('sideDialog', 'en');
  assert.ok(
    enSideDialog.includes(
      `Reply markers are runtime-added in the inter-dialog transfer payload (regular completed reply = ${enMarkers.finalCompleted}; FBR = ${enMarkers.fbrDirectReply} or ${enMarkers.fbrReasoningOnly}); this payload is delivered to requester context and shown identically in UI. Do not hand-write markers.`,
    ),
  );
  assert.ok(
    enSideDialog.includes(
      'If you define a reply format for downstream, keep it to the business delivery structure; do not require downstream to hand-write any marker, because runtime injects markers automatically.',
    ),
  );
  assert.ok(
    enSideDialog.includes(
      'This rule applies only when replying to the requester from the current Side Dialog; tellask is for initiating a new downstream tellask dialog (delegating work to a teammate), not for reporting back to the requester.',
    ),
  );
  assert.ok(
    enSideDialog.includes(
      'If the current Side Dialog is unfinished, do not mechanically map “blocked / uncertain” to `tellaskBack`; when team SOP / role ownership already identifies the responsible owner, directly use `tellask` / `tellaskSessionless` for that owner instead of posting a plain-text progress update.',
    ),
  );
  assert.ok(
    enSideDialog.includes(
      '`tellaskBack` is only for asking the requester back; use it only when requester clarification / decision / missing input is required, or current team SOP cannot determine ownership. Do not use `tellaskBack` to send final results.',
    ),
  );
  assert.ok(enSideDialog.includes(buildSideDialogCompletionRule('en')));
  assert.ok(
    enSideDialog.includes(
      `Runtime marks ${enMarkers.finalCompleted} and delivers to the requester only when runtime currently names an exact reply function and you reply through that named function.`,
    ),
  );
  assert.ok(
    enSideDialog.includes(
      'If runtime currently tells you there is no active inter-dialog reply obligation, then this turn is not awaiting another inter-dialog closure from you; do not call `reply*` again.',
    ),
  );

  const zhAssignment = buildAssignmentPrompt('zh');
  assert.ok(
    zhAssignment.includes(
      buildSideDialogRoleHeaderCopy({
        language: 'zh',
        requesterId: 'caller',
        expectedReplyTool: 'replyTellask',
      }),
    ),
  );

  const enAssignment = buildAssignmentPrompt('en');
  assert.ok(
    enAssignment.includes(
      buildSideDialogRoleHeaderCopy({
        language: 'en',
        requesterId: 'caller',
        expectedReplyTool: 'replyTellask',
      }),
    ),
  );
  assert.ok(
    enAssignment.includes(
      `Protocol note: reply markers (for example \`${enMarkers.tellaskBack}\` / \`${enMarkers.finalCompleted}\` / FBR markers \`${enMarkers.fbrDirectReply}\` / \`${enMarkers.fbrReasoningOnly}\`) are auto-injected by Dominds runtime into the inter-dialog transfer payload.`,
    ),
  );

  const enCompletedReply = formatTellaskResponseContent({
    callName: 'tellask',
    callId: 'collab-en-completed',
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
    callId: 'collab-zh-askback',
    responderId: 'tester',
    requesterId: 'caller',
    tellaskContent: '还缺少线上配置信息，请补充。',
    responseBody: '请确认生产环境端口。',
    status: 'failed',
    language: 'zh',
  });
  assert.ok(zhAskBackReply.startsWith(`${zhMarkers.tellaskBack}\n\n@tester 已回复：`));
  assert.equal(zhMarkers.tellaskBack, '【回问诉请】');

  const enReply = formatTellaskResponseContent({
    callName: 'tellaskSessionless',
    callId: 'collab-en-sessionless',
    responderId: 'tester',
    requesterId: 'caller',
    mentionList: ['@tester'],
    tellaskContent: 'Please summarize the blocker.',
    responseBody: 'The blocker is still pending.',
    status: 'completed',
    deliveryMode: 'reply_tool',
    language: 'en',
  });
  assert.ok(enReply.startsWith(`${enMarkers.finalCompleted}\n\n@tester provided response:`));

  console.log('✅ system-prompt-collab-marker-scope: ok');
}

main();
