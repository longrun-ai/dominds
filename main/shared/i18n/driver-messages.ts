import { formatLanguageName, type LanguageCode } from '../types/language';
import type { TellaskMalformedReason } from '../types/tellask';

export function formatUserFacingLanguageGuide(
  workingLanguage: LanguageCode,
  uiLanguage: LanguageCode,
): string {
  const uiName = formatLanguageName(uiLanguage, workingLanguage);
  const workingName = formatLanguageName(workingLanguage, workingLanguage);
  if (workingLanguage === 'zh') {
    if (uiLanguage === workingLanguage) {
      return `用户可见回复语言：${uiName}。`;
    }
    return `用户可见回复语言：${uiName}。内部工作语言保持为：${workingName}（用于系统提示、队友诉请与工具调用）。`;
  }

  if (uiLanguage === workingLanguage) {
    return `User-visible response language: ${uiName}.`;
  }
  return `User-visible response language: ${uiName}. Internal work language remains: ${workingName} (system prompt, teammate comms, tool calls).`;
}

export function formatReminderItemGuide(
  language: LanguageCode,
  index: number,
  content: string,
): string {
  if (language === 'zh') {
    return [
      '上下文状态：🟡 吃紧',
      '',
      '影响：对话历史中的工具调用/结果已过时，影响你的判断。',
      '',
      '你只有通过调用 clear_mind 才能丢弃过时信息，恢复清晰思维。',
      '"重入包"是你在下一轮无缝继续工作的关键，请尽快准备好。',
      '',
      '你必须在本轮至少调用一次提醒项维护工具（优先 update_reminder；也可 add_reminder）。',
      '目标：把"重入包草稿"维护进提醒项，让你有信心主动 clear_mind 进入新回合。',
      '',
      '同时建议你在提醒项里明确写出：',
      '"基于以上信息，还差……就可以完成重入包，从而安全 clear_mind 进入新回合"。',
      '',
      '可选动作（至少一个，允许多次调用）：',
      '- update_reminder({ "reminder_no": 1, "content": "<维护后的提醒项>" })  （推荐）',
      '- add_reminder({ "content": "<新增的提醒项>", "position": 0 })',
      '',
      '提示：在你自主调用 clear_mind 之前，系统会时常再次提醒你。',
    ].join('\n');
  }
  return `REMINDER ITEM #${index} (HIGH-PRIORITY WORKING SET)

Principle: reminders should be high-value and not stale; prefer update_reminder (curate) over creating many items.
- Still needed: compress and update_reminder (do not grow without bound).
- Not needed: delete_reminder.

Quick actions:
- Update: update_reminder({ "reminder_no": ${index}, "content": "..." })
- Delete: delete_reminder({ "reminder_no": ${index} })
---
${content}`;
}

export function formatQ4HKeepGoingBudgetExhausted(
  language: LanguageCode,
  args: { maxInjectCount: number },
): string {
  const maxInjectCount = args.maxInjectCount;
  if (language === 'zh') {
    return [
      `🤖 鞭策了 ${maxInjectCount} 次，这智能体跟钉子户似的就是不挪窝，`,
      '我也没办法了，你自己看着办吧。（Q4H 已挂起）',
    ].join('\n');
  }

  return [
    `After ${maxInjectCount} pushes for diligence, the agent is still not going, you handle it.`,
  ].join('\n');
}

export function formatDomindsNoteTellaskForTeammatesOnly(
  language: LanguageCode,
  args: { firstMention: string },
): string {
  const firstMention = args.firstMention;
  if (language === 'zh') {
    return (
      `错误：诉请（tellask）仅用于队友诉请（\`!?@<teammate>\`）。\n` +
      `- 当前目标：\`@${firstMention}\` 不是已知队友呼号。\n` +
      `- 若你要调用工具：请使用原生 function-calling（函数工具），不要在文本中输出 \`!?@tool\`。\n` +
      `- 若你要找队友：请确认呼号（如 \`!?@pangu\` / \`!?@super\` / \`!?@self\`）。`
    );
  }
  return (
    `Error: tellask is reserved for teammate tellasks (\`!?@<teammate>\`).\n` +
    `- Current target: \`@${firstMention}\` is not a known teammate call sign.\n` +
    `- If you intended to call a tool: use native function-calling; do not emit \`!?@tool\` in text.\n` +
    `- If you intended to call a teammate: double-check the call sign (e.g. \`!?@pangu\` / \`!?@super\` / \`!?@self\`).`
  );
}

export type ContextHealthV3RemediationGuideArgs =
  | { kind: 'caution'; mode: 'soft' }
  | {
      kind: 'critical';
      mode: 'countdown';
      promptsRemainingAfterThis: number;
      promptsTotal: number;
    };

export function formatUserFacingContextHealthV3RemediationGuide(
  language: LanguageCode,
  args: ContextHealthV3RemediationGuideArgs,
): string {
  const reentryTemplateZh = [
    '## 重入包（差遣牒未提及的工作交接细节）',
    '- 继续工作的第一步（可执行）：',
    '- 关键定位（文件/符号/搜索词）：',
    '- 运行/验证（命令、端口、环境变量）：',
    '- 易丢失的临时细节（路径/ID/URL/样例输入）：',
  ].join('\n');

  const reentryTemplateEn = [
    '## Re-entry package (handoff details not covered in Taskdoc)',
    '- First actionable step:',
    '- Key pointers (files/symbols/search terms):',
    '- Run/verify (commands, ports, env vars):',
    '- Easy-to-lose ephemeral details (paths/ids/urls/sample inputs):',
  ].join('\n');

  if (language === 'zh') {
    if (args.kind === 'caution' && args.mode === 'soft') {
      return [
        '上下文状态：🟡 吃紧',
        '',
        '影响：对话历史中的工具调用/结果信息很多已经过时，成为你的思考负担和判断力干扰因素。',
        '',
        '你只有通过调用 clear_mind 才能丢弃这些垃圾信息，恢复清醒的头脑。',
        '“重入包”是你在下一轮对话中无间断继续工作的关键，所以你需要尽快把它准备好。',
        '',
        '你必须在本轮至少调用一次提醒项维护工具（优先 update_reminder；也可 add_reminder）。',
        '目标：把“重入包草稿”维护进提醒项，让你尽快建立信心和意愿 **自主** clear_mind 进入新一轮/新回合。',
        '',
        '同时建议你在提醒项里明确写出：',
        '“基于以上信息，还差……就可以完成重入包，从而安全 clear_mind 进入新一轮/新回合”。',
        '',
        '可选动作（至少一个，允许多次调用）：',
        '- update_reminder({ "reminder_no": 1, "content": "<维护后的提醒项>" })  （推荐）',
        '- add_reminder({ "content": "<新增的提醒项>", "position": 0 })',
        '',
        '提示：在你自主调用 clear_mind 之前，系统会时常再次提醒你。',
      ].join('\n');
    }

    return [
      '上下文状态：🔴 告急',
      '',
      `为保持长程自治，系统最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动强制 clear_mind 开启新回合。`,
      '',
      '你应在本轮尽快执行（允许多次调用）：',
      '1) 用 update_reminder / add_reminder 把"重入包（尽最大努力）"维护进提醒项（压缩为少量、高价值条目）。',
      '2) 然后 clear_mind 开启新回合，让后续工作在更小上下文中继续。',
      '',
      '快速操作：',
      '- update_reminder({ "reminder_no": 1, "content": "<维护后的提醒项>" })  （推荐）',
      '- add_reminder({ "content": "<新增的提醒项>", "position": 0 })',
      '',
      '然后建议你主动执行：',
      '- clear_mind({ "reminder_content": "" })  （可选：为空也可；系统会保留已维护的提醒项）',
      '',
      reentryTemplateZh,
    ].join('\n');
  }

  if (args.kind === 'caution' && args.mode === 'soft') {
    return [
      'Context state: 🟡 caution',
      '',
      'Impact: the dialog contains lots of stale tool calls/results, which becomes cognitive noise and can degrade your judgment.',
      '',
      'You can only drop this noise by calling clear_mind.',
      'A “re-entry package” is the key to continuing work without interruption after starting a new round, so you should prepare it as soon as possible.',
      '',
      'In this turn, you must call at least one reminder-curation tool (prefer update_reminder; add_reminder is also OK).',
      'Goal: maintain a re-entry-package draft inside reminders so you can confidently clear_mind autonomously and start a new round.',
      '',
      'Allowed actions (at least one; multiple calls are OK):',
      '- update_reminder({ "reminder_no": 1, "content": "<updated reminder>" })  (preferred)',
      '- add_reminder({ "content": "<new reminder>", "position": 0 })',
      '',
      'Note: until you clear_mind, the system will periodically remind you again.',
    ].join('\n');
  }

  return [
    `Context state: 🔴 critical`,
    '',
    `To keep long-running autonomy stable, the system will remind you at most ${args.promptsRemainingAfterThis} more time(s), then it will automatically force clear_mind to start a new round/new turn dialog.`,
    '',
    'In this turn, do this as soon as possible (multiple calls are OK):',
    '',
    '1) Curate reminders via update_reminder / add_reminder to maintain a best-effort re-entry package.',
    '2) Then clear_mind to start a new round so work continues with a smaller context.',
    '',
    'Quick actions:',
    '- update_reminder({ "reminder_no": 1, "content": "<updated reminder>" })  (preferred)',
    '- add_reminder({ "content": "<new reminder>", "position": 0 })',
    '',
    'Then, you should proactively execute:',
    '- clear_mind({ "reminder_content": "" })  (optional: empty is OK; curated reminders are preserved)',
    '',
    reentryTemplateEn,
  ].join('\n');
}
export function formatDomindsNoteSuperOnlyInSubdialog(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`!?@super` 只在子对话中有效，用于向直接父对话（supdialog）发起诉请。\n' +
      '你当前不在子对话中，因此没有父对话可诉请。\n' +
      '（注：父对话不一定是根对话；差遣牒 `*.tsk/` 通常由根对话维护人统一更新。）'
    );
  }
  return (
    'Dominds note: `!?@super` is only valid inside a subdialog and calls the direct parent (supdialog). ' +
    'You are currently not in a subdialog, so there is no parent to call.'
  );
}

export function formatDomindsNoteSuperNoTellaskSession(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`!?@super` 是 Type A 的 supdialog 诉请，不接受 `!tellaskSession`。' +
      '请使用不带 `!tellaskSession` 的 `!?@super`；或使用 `!?@self !tellaskSession <tellaskSession>` / `!?@<agentId> !tellaskSession <tellaskSession>` 来触发 Type B。'
    );
  }
  return (
    'Dominds note: `!?@super` is a Type A supdialog call and does not accept `!tellaskSession`. ' +
    'Use `!?@super` with NO `!tellaskSession`, or use `!?@self !tellaskSession <tellaskSession>` / `!?@<agentId> !tellaskSession <tellaskSession>` for Type B.'
  );
}

export function formatDomindsNoteDirectSelfCall(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：该诉请目标是当前 agent（自诉请/self-call）。' +
      '扪心自问 通常应使用 `!?@self`（不带 `!tellaskSession`）来创建一次性的 fresh boots 会话；' +
      '仅在你明确需要可恢复的长期子对话时才使用 `!?@self !tellaskSession <tellaskSession>`。该诉请将继续执行。'
    );
  }
  return (
    'Dominds note: This call targets the current agent (self-call). ' +
    'Fresh Boots Reasoning should usually use `!?@self` (no `!tellaskSession`) for an ephemeral fresh boots session; use ' +
    '`!?@self !tellaskSession <tellaskSession>` only when you explicitly want a resumable long-lived subdialog. This call will proceed.'
  );
}

export function formatDomindsNoteMalformedTellaskCall(
  language: LanguageCode,
  reason: TellaskMalformedReason,
  options?: { firstLineAfterPrefix?: string },
): string {
  const firstLine = options?.firstLineAfterPrefix?.trim() ?? '';
  const got = firstLine !== '' ? `\n\nGot: \`!?${firstLine}\`` : '';

  if (language === 'zh') {
    switch (reason) {
      case 'missing_mention_prefix': {
        return (
          'ERR_MALFORMED_TELLASK\n' +
          'Dominds 提示：这段内容被解析为“诉请块”，但第一行不是有效的诉请头。\n\n' +
          '规则：诉请块第一行必须以 `!?@<mention-id>` 开头，例如：`!?@pangu`。\n' +
          '如果你只是想写普通 markdown，请不要在行首使用 `!?`。' +
          got
        );
      }
      case 'invalid_mention_id': {
        return (
          'ERR_MALFORMED_TELLASK\n' +
          'Dominds 提示：这段内容被解析为“诉请块”，但 `!?@` 后的 mention-id 为空或无效。\n\n' +
          '规则：第一行必须是 `!?@<mention-id>`（mention-id 不能为空），例如：`!?@pangu`。' +
          got
        );
      }
      default: {
        const _exhaustive: never = reason;
        return _exhaustive;
      }
    }
  }

  switch (reason) {
    case 'missing_mention_prefix': {
      return (
        'ERR_MALFORMED_TELLASK\n' +
        'Dominds note: This content was parsed as a tellask block, but the first line is not a valid tellask headline.\n\n' +
        'Rule: the first line must start with `!?@<mention-id>`, e.g. `!?@pangu`.\n' +
        'If you want normal markdown, do not start the line with `!?`.' +
        got
      );
    }
    case 'invalid_mention_id': {
      return (
        'ERR_MALFORMED_TELLASK\n' +
        'Dominds note: This content was parsed as a tellask block, but the mention-id after `!?@` is empty or invalid.\n\n' +
        'Rule: the first line must be `!?@<mention-id>` (mention-id cannot be empty), e.g. `!?@pangu`.' +
        got
      );
    }
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function formatDomindsNoteInvalidMultiTeammateTargets(
  language: LanguageCode,
  options: { unknown: string[] },
): string {
  const unknown = options.unknown.map((id) => `@${id}`).join(', ');
  if (language === 'zh') {
    return (
      'ERR_INVALID_MULTI_TEAMMATE_TARGETS\n' +
      `Dominds 提示：这条队友诉请包含未知队友呼号：${unknown}\n\n` +
      '在队友诉请中，headline 里出现的队友呼号会被视为 collective targets 并被分发（所有目标共享同一 headLine+callBody）。\n' +
      '请确认这些呼号是否存在于团队目录中；若你只是想写字面上的 @something，请用反引号包裹（例如 `@something`）。'
    );
  }
  return (
    'ERR_INVALID_MULTI_TEAMMATE_TARGETS\n' +
    `Dominds note: This teammate tellask includes unknown teammate id(s): ${unknown}\n\n` +
    'In teammate tellasks, teammate mentions inside the headline are treated as collective targets and fanned out (shared headLine+callBody).\n' +
    'Confirm those ids exist in the team roster; if you meant a literal `@something`, wrap it in backticks (e.g., `@something`).'
  );
}

export function formatDomindsNoteInvalidTellaskSessionDirective(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'ERR_INVALID_TELLASK_SESSION_DIRECTIVE\n' +
      'Dominds 提示：检测到 `!tellaskSession` 指令，但 tellaskSession 无效。\n\n' +
      '规则：`!tellaskSession <tellaskSession>` 的 tellaskSession 必须满足 `^[a-zA-Z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]+)*$`。'
    );
  }
  return (
    'ERR_INVALID_TELLASK_SESSION_DIRECTIVE\n' +
    'Dominds note: Detected a `!tellaskSession` directive, but the tellaskSession is invalid.\n\n' +
    'Rule: `!tellaskSession <tellaskSession>` must match `^[a-zA-Z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]+)*$`.'
  );
}

export function formatDomindsNoteMultipleTellaskSessionDirectives(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'ERR_MULTIPLE_TELLASK_SESSION_DIRECTIVES\n' +
      'Dominds 提示：同一条诉请的 headline 中出现了多个 `!tellaskSession` 指令。\n\n' +
      '规则：每条诉请最多只能包含一个 `!tellaskSession <tellaskSession>`（对 collective teammate tellask，该 tellaskSession 会对所有目标队友生效）。'
    );
  }
  return (
    'ERR_MULTIPLE_TELLASK_SESSION_DIRECTIVES\n' +
    'Dominds note: Multiple `!tellaskSession` directives were found in the headline.\n\n' +
    'Rule: a tellask may include at most one `!tellaskSession <tellaskSession>` (for collective teammate tellasks, the same tellaskSession applies to all targets).'
  );
}
