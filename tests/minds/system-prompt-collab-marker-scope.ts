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
    rtwsRootAbs: '/tmp/dominds-test-rtws',
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
    fromAgentId: 'tellasker',
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
      `当你在诉请正文里定义“回贴格式/交付格式”时，只写业务交付结构即可；不要要求被诉请者手写 \`${zhMarkers.finalCompleted}\` / \`${zhMarkers.tellaskBack}\` / FBR 标记（\`${zhMarkers.fbrDirectReply}\` / \`${zhMarkers.fbrReasoningOnly}\`），这些标记由 Dominds 自动注入。`,
    ),
  );
  assert.ok(!zhMainDialog.includes('Dominds 会自动注入回贴标记，禁止手写标记'));
  assert.ok(
    zhMainDialog.includes(
      '“⏳ 进行中诉请”提醒项只是系统状态窗，不是控制面；用它判断是否确实存在仍在执行的诉请。',
    ),
    'zh Main Dialog prompt should explain pending-tellask reminders are status windows',
  );
  assert.ok(
    zhMainDialog.includes(
      '只有长线诉请（`tellask` + `sessionSlug`）能接着同一件事说、更新同一件正在做的事；一次性诉请（`tellaskSessionless`）做不到。',
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
      `When you define a “reply/delivery format” inside tellask body, keep it to the business delivery structure; do not require the tellaskee to hand-write \`${enMarkers.finalCompleted}\` / \`${enMarkers.tellaskBack}\` / FBR markers (\`${enMarkers.fbrDirectReply}\` / \`${enMarkers.fbrReasoningOnly}\`), because Dominds injects those markers automatically.`,
    ),
  );
  assert.ok(
    !enMainDialog.includes('Dominds auto-injects reply markers; do not hand-write markers'),
  );
  assert.ok(
    enMainDialog.includes(
      'The “⏳ In-flight Tellasks” reminder is only a system status window, not a control surface; use it to determine whether any Tellask is truly still in flight.',
    ),
    'en Main Dialog prompt should explain pending-tellask reminders are status windows',
  );
  assert.ok(
    enMainDialog.includes(
      'Only a sessioned Tellask (`tellask` + `sessionSlug`) can continue the same task and update that task. A one-shot Tellask (`tellaskSessionless`) cannot:',
    ),
    'en Main Dialog prompt should explain tellaskSessionless has no assignment-update channel',
  );
  assert.ok(
    !enMainDialog.includes(
      'Reply markers are added by Dominds in the presentation layer (regular completed reply = 【最终完成】; FBR = 【FBR-直接回复】 or 【FBR-仅推理】) without rewriting body text; do not hand-write markers.',
    ),
  );

  const zhSideDialog = buildPrompt('sideDialog', 'zh');
  assert.ok(
    zhSideDialog.includes(
      `回贴文本标记由 Dominds 在跨对话传递正文中自动添加（常规完成=${zhMarkers.finalCompleted}；FBR=${zhMarkers.fbrDirectReply} 或 ${zhMarkers.fbrReasoningOnly}）；该正文直接进入诉请者上下文，且 UI 展示与其一致。你无需、也不应手写标记。`,
    ),
  );
  assert.ok(
    zhSideDialog.includes(
      '若你在正文中给下游写“回贴格式”，只写业务交付结构；不得要求下游手写任何标记，Dominds 会自动注入。',
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
      `正式完成路径中，仅当 Dominds 当前明确点名了某个精确回复工具，且你通过那个工具回复时，Dominds 才会把该回复投递给诉请者并标注 ${zhMarkers.finalCompleted}`,
    ),
  );
  assert.ok(
    zhSideDialog.includes(
      '若 Dominds 当前明确提示“无需回贴”，说明这轮没有别的对话在等你发送最终回贴；这是当前对话里的普通回合，按当前消息正常交流和处理即可。',
    ),
  );

  const enSideDialog = buildPrompt('sideDialog', 'en');
  assert.ok(
    enSideDialog.includes(
      `Reply markers are added by Dominds in the inter-dialog transfer payload (regular completed reply = ${enMarkers.finalCompleted}; FBR = ${enMarkers.fbrDirectReply} or ${enMarkers.fbrReasoningOnly}); this payload is delivered to tellasker context and shown identically in UI. Do not hand-write markers.`,
    ),
  );
  assert.ok(
    enSideDialog.includes(
      'If you define a reply format for downstream, keep it to the business delivery structure; do not require downstream to hand-write any marker, because Dominds injects markers automatically.',
    ),
  );
  assert.ok(
    enSideDialog.includes(
      'This rule applies only when replying to the tellasker from the current Side Dialog; tellask is for initiating a new downstream tellask dialog (delegating work to a teammate), not for reporting back to the tellasker.',
    ),
  );
  assert.ok(
    enSideDialog.includes(
      'If the current Side Dialog is unfinished, do not mechanically map “blocked / uncertain” to `tellaskBack`; when team SOP / role ownership already identifies the responsible owner, directly use `tellask` / `tellaskSessionless` for that owner instead of posting a plain-text progress update.',
    ),
  );
  assert.ok(
    enSideDialog.includes(
      '`tellaskBack` is only for asking the tellasker back; use it only when tellasker clarification / decision / missing input is required, or current team SOP cannot determine ownership. Do not use `tellaskBack` to send final results.',
    ),
  );
  assert.ok(enSideDialog.includes(buildSideDialogCompletionRule('en')));
  assert.ok(
    enSideDialog.includes(
      `In the formal completion path, Dominds marks ${enMarkers.finalCompleted} and delivers to the tellasker only when Dominds currently names an exact reply tool and you reply through that named tool`,
    ),
  );
  assert.ok(
    enSideDialog.includes(
      'If Dominds currently tells you no reply is needed, then no other dialog is waiting for your final reply in this turn; this is a normal turn in the current conversation, so handle the current message normally.',
    ),
  );

  const zhAssignment = buildAssignmentPrompt('zh');
  assert.ok(
    zhAssignment.includes(
      buildSideDialogRoleHeaderCopy({
        language: 'zh',
        tellaskerId: 'tellasker',
        expectedReplyTool: 'replyTellask',
      }),
    ),
  );

  const enAssignment = buildAssignmentPrompt('en');
  assert.ok(
    enAssignment.includes(
      buildSideDialogRoleHeaderCopy({
        language: 'en',
        tellaskerId: 'tellasker',
        expectedReplyTool: 'replyTellask',
      }),
    ),
  );
  assert.ok(
    enAssignment.includes(
      `Protocol note: reply markers (for example \`${enMarkers.tellaskBack}\` / \`${enMarkers.finalCompleted}\` / FBR markers \`${enMarkers.fbrDirectReply}\` / \`${enMarkers.fbrReasoningOnly}\`) are auto-injected by Dominds into the inter-dialog transfer payload.`,
    ),
  );

  const enCompletedReply = formatTellaskResponseContent({
    callName: 'tellask',
    callId: 'collab-en-completed',
    responderId: 'tester',
    tellaskerId: 'tellasker',
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
    tellaskerId: 'tellasker',
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
    tellaskerId: 'tellasker',
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
