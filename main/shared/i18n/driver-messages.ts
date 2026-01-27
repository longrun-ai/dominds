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
    return `【提醒项 #${index}｜高优先级工作集】

原则：提醒项应该是“高价值且不过时”的信息；我应优先用 update_reminder 维护它，避免堆很多条。
- 保留且仍然需要：把内容压缩为要点并 update_reminder（不要无限增大）。
- 已过时/不再需要：再 delete_reminder。

快速操作：
- 更新：update_reminder({ "reminder_no": ${index}, "content": "..." })
- 删除：delete_reminder({ "reminder_no": ${index} })
---
${content}`;
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
  | { kind: 'caution'; mode: 'soft'; graceRemaining: number; graceTotal: number }
  | { kind: 'caution'; mode: 'hard_curate' }
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
    '## 重入包（可多行；按任务规模伸缩）',
    '- 目标/范围：',
    '- 当前进展：',
    '- 关键决策/约束：',
    '- 已改动点（文件/模块）：',
    '- 下一步（可执行）：',
    '- 未决问题/风险：',
  ].join('\n');

  const reentryTemplateEn = [
    '## Re-entry package (multi-line; scale by task size)',
    '- Goal/scope:',
    '- Current progress:',
    '- Key decisions/constraints:',
    '- Changes (files/modules):',
    '- Next steps (actionable):',
    '- Open questions/risks:',
  ].join('\n');

  if (language === 'zh') {
    if (args.kind === 'caution' && args.mode === 'soft') {
      return [
        '上下文健康：🟡 黄（v3 remediation / 缓冲期）',
        '',
        '你刚刚超过 optimal 阈值。为避免过早 clear_mind 导致大量重读，你可以先继续工作一小段时间。',
        `缓冲期剩余：${args.graceRemaining}/${args.graceTotal} 次生成。`,
        '',
        '建议：从现在开始把“重入包草稿”持续维护在提醒项里（update_reminder / add_reminder），等信息更明朗后再 clear_mind。',
        '当缓冲期结束且仍处于黄：系统会按 cadence（默认每 10 次生成）注入一次“维护提醒项”的硬提醒（要求至少调用一次 update_reminder/add_reminder）。',
        '',
        reentryTemplateZh,
      ].join('\n');
    }

    if (args.kind === 'caution' && args.mode === 'hard_curate') {
      return [
        '上下文健康：🟡 黄（v3 remediation / 维护提醒项）',
        '',
        '你必须在本轮至少调用一次提醒项维护工具（优先 update_reminder；也可 add_reminder）。',
        '目标：把“重入包草稿”维护进提醒项，让我能在信息足够时 **自主** clear_mind 进入新一轮/新回合。',
        '',
        '建议你在提醒项里明确写出：',
        '“基于以上信息，还差……就可以完成重入包，从而安全 clear_mind 进入新一轮/新回合”。',
        '',
        '可选动作（至少一个，允许多次调用）：',
        '- update_reminder({ "reminder_no": 1, "content": "<维护后的提醒项>" })  （推荐）',
        '- add_reminder({ "content": "<新增的提醒项>", "position": 0 })',
        '',
        '提示：若你仍处于黄且没有完成提醒项维护，系统会按 cadence（默认每 10 次生成）再次提醒（直到缓解）。',
        '',
        reentryTemplateZh,
      ].join('\n');
    }

    return [
      `上下文健康：🔴 红（v3 remediation / 倒数清理）`,
      '',
      `为保持长程自动运行，系统将连续最多 ${args.promptsTotal} 轮以 role=user 的“用户 prompt”形式提醒你尽快收敛重入包并清理。`,
      '',
      `倒数：本轮之后还剩 ${args.promptsRemainingAfterThis} 轮。若在倒数结束前仍未 clear_mind，系统将自动强制 clear_mind，并开启新一轮/新回合（不触发 Q4H，不暂停对话）。`,
      '',
      '你应在本轮尽快执行（允许多次调用）：',
      '1) 用 update_reminder / add_reminder 把“重入包（best effort）”维护进提醒项（压缩为少量、高价值条目）。',
      '2) 然后 clear_mind 开启新一轮/新回合，让后续工作在更小的上下文中继续。',
      '',
      '快速操作：',
      '- update_reminder({ "reminder_no": 1, "content": "<维护后的提醒项>" })  （推荐）',
      '- add_reminder({ "content": "<新增的提醒项>", "position": 0 })',
      '- clear_mind({ "reminder_content": "" })  （可选：为空也可；系统会保留已维护的提醒项）',
      '',
      reentryTemplateZh,
    ].join('\n');
  }

  if (args.kind === 'caution' && args.mode === 'soft') {
    return [
      'Context health: 🟡 caution (v3 remediation / grace period)',
      '',
      'You just crossed the optimal threshold. To avoid clearing too early (and re-reading a lot), you may continue briefly.',
      `Grace remaining: ${args.graceRemaining}/${args.graceTotal} generations.`,
      '',
      'Suggestion: start drafting and curating a re-entry package in reminders (update_reminder / add_reminder), then clear_mind when it becomes scannable and actionable.',
      'Once the grace period ends (and still caution), the system will inject a hard reminder-curation prompt on a cadence (default: every 10 generations), requiring at least one update_reminder/add_reminder call.',
      '',
      reentryTemplateEn,
    ].join('\n');
  }

  if (args.kind === 'caution' && args.mode === 'hard_curate') {
    return [
      'Context health: 🟡 caution (v3 remediation / curate reminders)',
      '',
      'In this turn, you must call at least one reminder-curation tool (prefer update_reminder; add_reminder is also OK).',
      'Goal: maintain a re-entry-package draft inside reminders so you can later clear_mind autonomously when it becomes actionable.',
      '',
      'Suggested phrasing inside the reminder(s):',
      '“Based on the above, we still need … to complete the re-entry package, so we can safely clear_mind and start a new round.”',
      '',
      'Allowed actions (at least one; multiple calls are OK):',
      '- update_reminder({ "reminder_no": 1, "content": "<updated reminder>" })  (preferred)',
      '- add_reminder({ "content": "<new reminder>", "position": 0 })',
      '',
      'Note: if still caution and you did not curate reminders, the system reinjects this guidance on the configured cadence (default: every 10 generations) until relieved.',
      '',
      reentryTemplateEn,
    ].join('\n');
  }

  return [
    `Context health: 🔴 critical (v3 remediation / countdown clear)`,
    '',
    `To keep long-running autonomy stable, the system will (at most) inject up to ${args.promptsTotal} role=user “user prompts” to nudge you to curate a re-entry package and clear soon.`,
    '',
    `Countdown: ${args.promptsRemainingAfterThis} turns remaining after this. If you still do not clear_mind before the countdown ends, the system will automatically force clear_mind and start a new round (no Q4H, no suspension).`,
    '',
    'In this turn, do this as soon as possible (multiple calls are OK):',
    '1) Curate reminders via update_reminder / add_reminder to maintain a best-effort re-entry package.',
    '2) Then clear_mind to start a new round so work continues with a smaller context.',
    '',
    'Quick actions:',
    '- update_reminder({ "reminder_no": 1, "content": "<updated reminder>" })  (preferred)',
    '- add_reminder({ "content": "<new reminder>", "position": 0 })',
    '- clear_mind({ "reminder_content": "" })  (optional: empty is OK; curated reminders are preserved)',
    '',
    reentryTemplateEn,
  ].join('\n');
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
