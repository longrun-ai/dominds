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
    return `用户可见回复语言：${uiName}。内部工作语言保持为：${workingName}（用于系统提示、队友沟通与工具调用）。`;
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
    return `这里是提醒 #${index}。我应判断它是否仍然相关；如果不相关，应立即执行 \`@delete_reminder ${index}\`。
---
${content}`;
  }

  return `Here I have reminder #${index}, I should assess whether it's still relevant and issue \`@delete_reminder ${index}\` immediately if deemed not.
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
    switch (args.kind) {
      case 'usage_unknown':
        return '上下文健康：上一轮生成的 token 使用量未知。如果你感觉性能下降，把重要事实/决策提炼到差遣牒和/或提醒里，然后使用 @clear_mind 以精简上下文开启新的对话回合。';
      case 'over_optimal':
        return '上下文健康：对话上下文已偏大。Dominds 不会自动压缩上下文——把重要事实/决策提炼到差遣牒和/或提醒里，然后使用 @clear_mind 以精简上下文开启新的对话回合。';
      default: {
        const _exhaustiveCheck: never = args;
        return _exhaustiveCheck;
      }
    }
  }

  switch (args.kind) {
    case 'usage_unknown':
      return 'Context health: unknown for the last generation. If you feel degraded performance, distill the important facts/decisions into the task doc and/or reminders, then use @clear_mind to start a new round of the dialog with concise context.';
    case 'over_optimal':
      return 'Context health: your dialog context is getting large. Dominds does not auto-compact context — distill the important facts/decisions into the task doc and/or reminders, then use @clear_mind to start a new round of the dialog with concise context.';
    default: {
      const _exhaustiveCheck: never = args;
      return _exhaustiveCheck;
    }
  }
}

export function formatReminderIntro(language: LanguageCode, count: number): string {
  if (language === 'zh') {
    return `我有 ${count} 条提醒可用于记忆管理。

我可以随时管理这些提醒，以在多轮对话间保持上下文：
- @add_reminder [<position>]\n<content>
- @update_reminder <number>\n<new content>
- @delete_reminder <number>

使用 @clear_mind 会开启新一轮对话——这有助于保持思路清晰，同时提醒会把重要信息带到新一轮中。使用 @change_mind 只会更新差遣牒内容（不进入新一轮）。

提示：我可以带正文地使用 @clear_mind，该正文会被追加为新的提醒；同时我会进入新一轮对话，不再包含旧消息。`;
  }

  const plural = count > 1 ? 's' : '';
  return `I have ${count} reminder${plural} available for my memory management.

I can manage these anytime to maintain context across dialog rounds:
- @add_reminder [<position>]\n<content>
- @update_reminder <number>\n<new content>
- @delete_reminder <number>

Using @clear_mind starts a new dialog round (good for clearing noise) while reminders carry important info forward. Using @change_mind only updates the task document content (no round reset).

Tip: I can use @clear_mind with a body, and that body will be added as a new reminder, while I'm in a new dialog round without old messages.`;
}

export function formatDomindsNoteSuperOnlyInSubdialog(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`@super` 只在子对话（subdialog）中有效，用于呼叫直接父对话（supdialog）。' +
      '你当前不在子对话中，因此没有父对话可呼叫。'
    );
  }
  return (
    'Dominds note: `@super` is only valid inside a subdialog and calls the direct parent (supdialog). ' +
    'You are currently not in a subdialog, so there is no parent to call.'
  );
}

export function formatDomindsNoteSuperNoTopic(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`@super` 是 Type A 的 supdialog 呼叫，不接受 `!topic`。' +
      '请使用不带 `!topic` 的 `@super`；或使用 `@self !topic <topicId>` / `@<agentId> !topic <topicId>` 来触发 Type B。'
    );
  }
  return (
    'Dominds note: `@super` is a Type A supdialog call and does not accept `!topic`. ' +
    'Use `@super` with NO `!topic`, or use `@self !topic <topicId>` / `@<agentId> !topic <topicId>` for Type B.'
  );
}

export function formatDomindsNoteDirectSelfCall(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：该呼叫目标是当前 agent（自呼叫/self-call）。' +
      'Fresh Boots Reasoning 通常应使用 `@self`（不带 `!topic`）来创建一次性的 fresh boots 会话；' +
      '仅在你明确需要可恢复的长期子对话时才使用 `@self !topic <topicId>`。该呼叫将继续执行。'
    );
  }
  return (
    'Dominds note: This call targets the current agent (self-call). ' +
    'Fresh Boots Reasoning should usually use `@self` (no `!topic`) for an ephemeral fresh boots session; use ' +
    '`@self !topic <topicId>` only when you explicitly want a resumable long-lived subdialog. This call will proceed.'
  );
}
