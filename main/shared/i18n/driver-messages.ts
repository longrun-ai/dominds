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
    return `这里是提醒 #${index}。我应判断它是否仍然相关；如果不相关，应立即调用函数工具 \`delete_reminder\`：\`{ \"reminder_no\": ${index} }\`。
---
${content}`;
  }

  return `Here I have reminder #${index}. I should assess whether it's still relevant; if not, I should immediately call the function tool \`delete_reminder\` with \`{ \"reminder_no\": ${index} }\`.
---
${content}`;
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

export type ContextHealthReminderTextArgs =
  | {
      kind: 'usage_unknown';
    }
  | {
      kind: 'over_optimal';
    };

export function formatContextHealthReminderText(
  language: LanguageCode,
  args: ContextHealthReminderTextArgs,
): string {
  if (language === 'zh') {
    const distillLines = [
      '建议：用函数工具 `change_mind` 把“提炼摘要”写回差遣牒（selector 选 `progress`），然后再用函数工具 `clear_mind` 清理噪音开启新回合。',
      '',
      '提炼摘要（写入 `progress` 即可；无需复制粘贴代码块）：',
      '## 提炼摘要',
      '- 目标：',
      '- 关键决策：',
      '- 已改文件：',
      '- 下一步：',
      '- 未决问题：',
    ];

    const options = [
      '- 可选动作（按当前意图自行选择）：',
      '  - 把关键事实/决策写入差遣牒（`change_mind({\"selector\":\"progress\",\"content\":...})`）',
      '  - 收窄范围/减少输出噪音（例如减少大段粘贴、减少无关回显）',
      '  - 接受风险继续（例如为了保持连续性）',
    ];

    switch (args.kind) {
      case 'usage_unknown':
        return [
          '上下文健康：上一轮生成的 token 使用量未知。',
          '',
          '- 原因：当上下文接近模型上限或统计未知时，质量与稳定性更容易波动。',
          ...options,
          '',
          ...distillLines,
        ].join('\n');
      case 'over_optimal':
        return [
          '上下文健康：对话上下文已偏大。',
          '',
          '- 原因：上下文过大会降低质量并拖慢响应。',
          ...options,
          '',
          ...distillLines,
        ].join('\n');
      default: {
        const _exhaustiveCheck: never = args;
        return _exhaustiveCheck;
      }
    }
  }

  const distillLines = [
    'Suggested flow: write a short distillation into the Taskdoc via the function tool `change_mind` (selector `progress`), then use the function tool `clear_mind` to start a new round with less noise.',
    '',
    'Distilled context (put this into `progress`; no code block copy needed):',
    '## Distilled context',
    '- Goal:',
    '- Key decisions:',
    '- Files touched:',
    '- Next steps:',
    '- Open questions:',
  ];

  const options = [
    '- Options (choose based on your intent):',
    '  - Write key facts/decisions into the Taskdoc (`change_mind({\"selector\":\"progress\",\"content\":...})`)',
    '  - Narrow scope / reduce output noise (avoid large pastes, avoid irrelevant tool echoes)',
    '  - Continue as-is if you accept the risk',
  ];

  switch (args.kind) {
    case 'usage_unknown':
      return [
        'Context health: token usage for the last generation is unknown.',
        '',
        '- Why: When context is near limits or usage is unknown, quality and stability can drift.',
        ...options,
        '',
        ...distillLines,
      ].join('\n');
    case 'over_optimal':
      return [
        'Context health: your dialog context is getting large.',
        '',
        '- Why: Large prompts can degrade quality and slow responses.',
        ...options,
        '',
        ...distillLines,
      ].join('\n');
    default: {
      const _exhaustiveCheck: never = args;
      return _exhaustiveCheck;
    }
  }
}

export function formatReminderIntro(language: LanguageCode, count: number): string {
  if (language === 'zh') {
    return `⚠️ 我当前有 ${count} 条提醒（请优先处理）。

快速操作：
- 新增：add_reminder({ "content": "...", "position": 0 })（position=0 表示默认追加；也可填 1..N 指定插入位置）
- 更新：update_reminder({ "reminder_no": 1, "content": "..." })
- 删除：delete_reminder({ "reminder_no": 1 })

建议做法（可选）：
- 先用 change_mind({ "selector": "progress", "content": "..." }) 把关键事实/决策写回差遣牒
- 然后用 clear_mind({ "reminder_content": "" }) 开启新回合以清理噪音

提炼模板（写入差遣牒的 \`progress\` 段）：
## 提炼摘要
- 目标：
- 关键决策：
- 已改文件：
- 下一步：
- 未决问题：`;
  }

  const plural = count > 1 ? 's' : '';
  return `⚠️ I currently have ${count} reminder${plural} (please review).

Quick actions:
- Add: add_reminder({ "content": "...", "position": 0 }) (position=0 means append; or set 1..N to insert)
- Update: update_reminder({ "reminder_no": 1, "content": "..." })
- Delete: delete_reminder({ "reminder_no": 1 })

Suggested flow (optional):
- First, write a short distillation into the Taskdoc via change_mind({ "selector": "progress", "content": "..." })
- Then use clear_mind({ "reminder_content": "" }) to start a new round with less noise

Distill template (put this into the Taskdoc \`progress\` section):
## Distilled context
- Goal:
- Key decisions:
- Files touched:
- Next steps:
- Open questions:`;
}

export function formatDomindsNoteSuperOnlyInSubdialog(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`!?@super` 只在子对话（subdialog）中有效，用于诉请直接父对话（supdialog）。' +
      '你当前不在子对话中，因此没有父对话可诉请。'
    );
  }
  return (
    'Dominds note: `!?@super` is only valid inside a subdialog and calls the direct parent (supdialog). ' +
    'You are currently not in a subdialog, so there is no parent to call.'
  );
}

export function formatDomindsNoteSuperNoTopic(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`!?@super` 是 Type A 的 supdialog 诉请，不接受 `!topic`。' +
      '请使用不带 `!topic` 的 `!?@super`；或使用 `!?@self !topic <topicId>` / `!?@<agentId> !topic <topicId>` 来触发 Type B。'
    );
  }
  return (
    'Dominds note: `!?@super` is a Type A supdialog call and does not accept `!topic`. ' +
    'Use `!?@super` with NO `!topic`, or use `!?@self !topic <topicId>` / `!?@<agentId> !topic <topicId>` for Type B.'
  );
}

export function formatDomindsNoteDirectSelfCall(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：该诉请目标是当前 agent（自诉请/self-call）。' +
      'Fresh Boots Reasoning 通常应使用 `!?@self`（不带 `!topic`）来创建一次性的 fresh boots 会话；' +
      '仅在你明确需要可恢复的长期子对话时才使用 `!?@self !topic <topicId>`。该诉请将继续执行。'
    );
  }
  return (
    'Dominds note: This call targets the current agent (self-call). ' +
    'Fresh Boots Reasoning should usually use `!?@self` (no `!topic`) for an ephemeral fresh boots session; use ' +
    '`!?@self !topic <topicId>` only when you explicitly want a resumable long-lived subdialog. This call will proceed.'
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
      '在队友诉请中，headline 里出现的队友呼号会被视为 collective targets 并被 fan-out（共享同一 headLine+callBody）。\n' +
      '请确认这些呼号是否存在于团队目录中；若你只是想写字面量 `@something`，请用反引号包裹（例如 `@something`）。'
    );
  }
  return (
    'ERR_INVALID_MULTI_TEAMMATE_TARGETS\n' +
    `Dominds note: This teammate tellask includes unknown teammate id(s): ${unknown}\n\n` +
    'In teammate tellasks, teammate mentions inside the headline are treated as collective targets and fanned out (shared headLine+callBody).\n' +
    'Confirm those ids exist in the team roster; if you meant a literal `@something`, wrap it in backticks (e.g., `@something`).'
  );
}

export function formatDomindsNoteInvalidTopicDirective(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'ERR_INVALID_TOPIC_DIRECTIVE\n' +
      'Dominds 提示：检测到 `!topic` 指令，但 topicId 无效。\n\n' +
      '规则：`!topic <topicId>` 的 topicId 必须满足 `^[a-zA-Z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]+)*$`。'
    );
  }
  return (
    'ERR_INVALID_TOPIC_DIRECTIVE\n' +
    'Dominds note: Detected a `!topic` directive, but the topicId is invalid.\n\n' +
    'Rule: `!topic <topicId>` must match `^[a-zA-Z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]+)*$`.'
  );
}

export function formatDomindsNoteMultipleTopicDirectives(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'ERR_MULTIPLE_TOPIC_DIRECTIVES\n' +
      'Dominds 提示：同一条诉请的 headline 中出现了多个 `!topic` 指令。\n\n' +
      '规则：每条诉请最多只能包含一个 `!topic <topicId>`（对 collective teammate tellask，该 topic 会对所有目标队友生效）。'
    );
  }
  return (
    'ERR_MULTIPLE_TOPIC_DIRECTIVES\n' +
    'Dominds note: Multiple `!topic` directives were found in the headline.\n\n' +
    'Rule: a tellask may include at most one `!topic <topicId>` (for collective teammate tellasks, the same topic applies to all targets).'
  );
}
