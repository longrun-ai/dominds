import { formatLanguageName, type LanguageCode } from '../types/language';

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
    return `这里是提醒 #${index}。我应判断它是否仍然相关；如果不相关，应立即执行 \`!!@delete_reminder ${index}\`。
---
${content}`;
  }

  return `Here I have reminder #${index}, I should assess whether it's still relevant and issue \`!!@delete_reminder ${index}\` immediately if deemed not.
---
${content}`;
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
      '建议：用 `!!@change_mind !progress` 把“提炼摘要”写回差遣牒，然后再用 `!!@clear_mind` 清理噪音开启新回合。',
      '',
      '提炼摘要（写入 `!progress` 即可；无需复制粘贴代码块）：',
      '## 提炼摘要',
      '- 目标：',
      '- 关键决策：',
      '- 已改文件：',
      '- 下一步：',
      '- 未决问题：',
    ];

    const options = [
      '- 可选动作（按当前意图自行选择）：',
      '  - 把关键事实/决策写入差遣牒（`!!@change_mind !progress`）',
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
    'Suggested flow: write a short distillation into the task doc via `!!@change_mind !progress`, then use `!!@clear_mind` to start a new round with less noise.',
    '',
    'Distilled context (put this into `!progress`; no code block copy needed):',
    '## Distilled context',
    '- Goal:',
    '- Key decisions:',
    '- Files touched:',
    '- Next steps:',
    '- Open questions:',
  ];

  const options = [
    '- Options (choose based on your intent):',
    '  - Write key facts/decisions into the task doc (`!!@change_mind !progress`)',
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
- 新增：!!@add_reminder [<position>]
- 更新：!!@update_reminder <number>
- 删除：!!@delete_reminder <number>

建议做法（可选）：
- 先用 \`!!@change_mind !progress\` 把关键事实/决策写回差遣牒
- 然后使用 !!@clear_mind 开启新回合以清理噪音

提炼模板（写入差遣牒的 \`!progress\` 段）：
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
- Add: !!@add_reminder [<position>]
- Update: !!@update_reminder <number>
- Delete: !!@delete_reminder <number>

Suggested flow (optional):
- First, write a short distillation into the task doc via \`!!@change_mind !progress\`
- Then use !!@clear_mind to start a new round with less noise

Distill template (put this into the task doc \`!progress\` section):
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
      'Dominds 提示：`!!@super` 只在子对话（subdialog）中有效，用于诉请直接父对话（supdialog）。' +
      '你当前不在子对话中，因此没有父对话可诉请。'
    );
  }
  return (
    'Dominds note: `!!@super` is only valid inside a subdialog and calls the direct parent (supdialog). ' +
    'You are currently not in a subdialog, so there is no parent to call.'
  );
}

export function formatDomindsNoteSuperNoTopic(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`!!@super` 是 Type A 的 supdialog 诉请，不接受 `!topic`。' +
      '请使用不带 `!topic` 的 `!!@super`；或使用 `!!@self !topic <topicId>` / `!!@<agentId> !topic <topicId>` 来触发 Type B。'
    );
  }
  return (
    'Dominds note: `!!@super` is a Type A supdialog call and does not accept `!topic`. ' +
    'Use `!!@super` with NO `!topic`, or use `!!@self !topic <topicId>` / `!!@<agentId> !topic <topicId>` for Type B.'
  );
}

export function formatDomindsNoteDirectSelfCall(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：该诉请目标是当前 agent（自诉请/self-call）。' +
      'Fresh Boots Reasoning 通常应使用 `!!@self`（不带 `!topic`）来创建一次性的 fresh boots 会话；' +
      '仅在你明确需要可恢复的长期子对话时才使用 `!!@self !topic <topicId>`。该诉请将继续执行。'
    );
  }
  return (
    'Dominds note: This call targets the current agent (self-call). ' +
    'Fresh Boots Reasoning should usually use `!!@self` (no `!topic`) for an ephemeral fresh boots session; use ' +
    '`!!@self !topic <topicId>` only when you explicitly want a resumable long-lived subdialog. This call will proceed.'
  );
}
