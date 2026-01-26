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
    return `这里是提醒项 #${index}（工作集/工作日志的一部分）。

原则：提醒项应该是“高价值且不过时”的信息；我应优先用 update_reminder 维护它，避免堆很多条。
- 保留且仍然需要：把内容压缩为要点并 update_reminder（不要无限增大）。
- 已过时/不再需要：再 delete_reminder。

快速操作：
- 更新：update_reminder({ "reminder_no": ${index}, "content": "..." })
- 删除：delete_reminder({ "reminder_no": ${index} })
---
${content}`;
  }

  return `Here is reminder item #${index} (part of your working set / worklog).

Principle: reminders should be high-value and not stale; prefer update_reminder (curate) over creating many items.
- Still needed: compress and update_reminder (do not grow without bound).
- Not needed: delete_reminder.

Quick actions:
- Update: update_reminder({ "reminder_no": ${index}, "content": "..." })
- Delete: delete_reminder({ "reminder_no": ${index} })
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
    }
  | {
      kind: 'over_critical';
      remainingGenTurns: number;
    };

export function formatContextHealthReminderText(
  language: LanguageCode,
  args: ContextHealthReminderTextArgs,
): string {
  if (language === 'zh') {
    switch (args.kind) {
      case 'usage_unknown':
        return [
          '📋',
          '🧠 上下文健康：⚪ 未知（上一轮 token 统计不可用）',
          '',
          '说明：当上下文接近模型上限或统计未知时，质量与稳定性更容易波动。',
          '',
          '建议：先 change_mind 更新差遣牒 progress（提炼摘要），再 clear_mind 开启新一轮以清理噪音。',
        ].join('\n');
      case 'over_optimal':
        return [
          '📋',
          '🧠 上下文健康：🟡 黄（现在就停手：先提炼，再清理）',
          '',
          '禁止继续推进实现或继续读大文件输出。先把“必须保留的细节”收敛到少量提醒项（优先 update_reminder 压缩/合并），再 change_mind(progress) 写提炼摘要（不限制行数；按任务规模与参与人数调整篇幅），然后 clear_mind 开启新一轮/新回合。',
          '',
          '说明：clear_mind 不会清空差遣牒（`*.tsk/`），也不会清理现有提醒项；可放心开启新一轮/新回合。',
          '',
          '如果你担心丢细节：不要继续堆对话历史；把关键细节写进提醒项（提醒项是跨新一轮/新回合的工作集）。',
        ].join('\n');
      case 'over_critical':
        return [
          '📋',
          '🧠 上下文健康：🔴 红（硬闸门：立刻提炼，否则会被动新开一轮/新回合）',
          '',
          `倒数：还剩 ${args.remainingGenTurns} 次生成机会；到 0 系统将被动开启新一轮/新回合以保持稳定性（等同 clear_mind：清空本轮对话消息；差遣牒与提醒项不受影响）。`,
          '',
          '禁止继续推进实现。必须立刻执行：',
          '- 先用 update_reminder 把“必须保留的细节”压缩/合并到少量提醒项（工作集）',
          '- 再 change_mind(progress) 写提炼摘要（不限制行数；覆盖：目标 / 关键决策 / 已改动点 / 下一步 / 未决问题）',
          '- 然后 clear_mind 开启新一轮/新回合',
        ].join('\n');
      default: {
        const _exhaustiveCheck: never = args;
        return _exhaustiveCheck;
      }
    }
  }

  const clearMindSafetyLines = [
    'Note: calling the function tool `clear_mind` does NOT delete the Taskdoc (`*.tsk/`) and does NOT delete existing reminder items.',
    'So it is safe to distill key facts into the Taskdoc/reminders and then `clear_mind` immediately.',
    '',
    'If I am still worried about losing context:',
    '- I can put a long “safety reminder item” into `clear_mind({ "reminder_content": "..." })` so the new round carries key facts/decisions/next steps.',
  ];

  switch (args.kind) {
    case 'usage_unknown':
      return [
        '📋',
        'Context health: unknown (token usage for the last generation is unavailable).',
        '',
        'Why: When context is near limits or usage is unknown, quality and stability can drift.',
        '',
        'Suggested: `change_mind` (selector `progress`) then `clear_mind` to start a new round with less noise.',
      ].join('\n');
    case 'over_optimal':
      return [
        '📋',
        'Context health: 🟡 caution (your dialog context is getting large).',
        '',
        'Why: Large prompts can degrade quality and slow responses.',
        '',
        ...clearMindSafetyLines,
        '',
        'Suggested: `change_mind` (selector `progress`) then `clear_mind` to start a new round with less noise.',
      ].join('\n');
    case 'over_critical':
      return [
        '📋',
        'Context health: 🔴 critical (high risk: generation may fail/stall/become unusable).',
        '',
        `Countdown: ${args.remainingGenTurns} generation turns left; at 0 the system will auto-start a new round for stability (equivalent to \`clear_mind\`).`,
        '',
        ...clearMindSafetyLines,
        '',
        'Must prioritize: `change_mind` (selector `progress`) → `clear_mind`.',
      ].join('\n');
    default: {
      const _exhaustiveCheck: never = args;
      return _exhaustiveCheck;
    }
  }
}
export function formatReminderIntro(language: LanguageCode, count: number): string {
  if (language === 'zh') {
    return `⚠️ 我当前有 ${count} 条提醒项（这是跨新一轮/新回合的工作集；请主动维护）。

推荐工作流（优先级从高到低）：
1) 需要长期携带的关键细节：写进提醒项（尽量少量几条，优先 update_reminder 维护单条“工作集提醒项”）。
2) 任务契约/关键决策/下一步：写进差遣牒（change_mind 的 progress 段，保持简短）。
3) 大段对话与工具调用历史：当成噪音，必要时 clear_mind 清掉。

快速操作：
- 新增：add_reminder({ "content": "...", "position": 0 })（position=0 表示默认追加；也可填 1..N 指定插入位置）
- 更新：update_reminder({ "reminder_no": 1, "content": "..." })
- 删除：delete_reminder({ "reminder_no": 1 })

注意：
- 系统托管提醒项（有 owner）会自动更新/消失；通常不需要 delete_reminder。

建议（上下文健康黄/红时必须执行）：
- 先把“必须保留的细节”收敛到少量提醒项（update_reminder 压缩/合并）
- 再 change_mind(progress) 写提炼摘要（不限制行数；覆盖：目标 / 关键决策 / 已改动点 / 下一步 / 未决问题）
- 然后 clear_mind 开启新一轮/新回合（差遣牒与提醒项不会丢）

提炼模板（写入差遣牒的 progress 段）：
## 提炼摘要
- 目标：
- 关键决策：
- 已改文件：
- 下一步：
- 未决问题：`;
  }

  const plural = count > 1 ? 's' : '';
  return `⚠️ I currently have ${count} reminder item${plural} (this is your cross-round working set; actively curate it).

Recommended flow (highest priority first):
1) Key details worth carrying: put them into reminders (keep it small; prefer update_reminder on a single “worklog” item).
2) Task contract / key decisions / next steps: put into the Taskdoc (change_mind selector progress; keep it short).
3) Long chat/tool history: treat as noise; clear_mind when needed.

Quick actions:
- Add: add_reminder({ "content": "...", "position": 0 }) (position=0 means append; or set 1..N to insert)
- Update: update_reminder({ "reminder_no": 1, "content": "..." })
- Delete: delete_reminder({ "reminder_no": 1 })

Note:
- System-managed reminders (with an owner) auto-update/auto-drop; you typically do not need delete_reminder.

Suggested (mandatory at yellow/red context health):
- First, compress/merge reminders into a small set (update_reminder)
- Then distill into Taskdoc progress (change_mind) (no fixed length; scale by task size)
- Then clear_mind to start a new round (Taskdoc and reminders are preserved)

Distill template (Taskdoc progress):
## Distilled context
- Goal:
- Key decisions:
- Files touched:
- Next steps:
- Open questions:`;
}

export function formatContextHealthAutoNewRoundPrompt(
  language: LanguageCode,
  nextRound: number,
): string {
  if (language === 'zh') {
    return (
      '上下文健康：倒数已归零。系统已自动开启新一轮以保持稳定性（等同 clear_mind：清空本轮对话消息；差遣牒与提醒项不受影响）。\n' +
      `这是对话的第 #${nextRound} 轮，请继续执行任务。`
    );
  }
  return (
    'Context health: countdown reached zero. The system auto-started a new round for stability ' +
    "(equivalent to clear_mind: clears this round's dialog messages; Taskdoc and reminder items are preserved).\n" +
    `This is round #${nextRound}. Please continue the task.`
  );
}

export function formatDomindsNoteSuperOnlyInSubdialog(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`!?@super` 只在子对话（subdialog）中有效，用于诉请直接父对话（supdialog）。' +
      '补充：父对话不一定是主对话/根对话；差遣牒（`*.tsk/`）通常由主对话/根对话维护人统一更新。' +
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
