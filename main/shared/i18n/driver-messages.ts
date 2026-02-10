import { formatLanguageName, type LanguageCode } from '../types/language';
import type { TellaskMalformedReason } from '../types/tellask';

export function formatCurrentUserLanguagePreference(
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
  return `User-visible response language: ${uiName}. Internal work language remains: ${workingName} (system prompt, teammate comms, function tools).`;
}

export function formatReminderItemGuide(
  language: LanguageCode,
  index: number,
  content: string,
  options?: { meta?: unknown },
): string {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // `options.meta` is persisted JSON coming from tools. Runtime shape checks are unavoidable here
  // to keep reminder ownership/management loosely coupled and extensible.
  const metaValue = options && 'meta' in options ? options.meta : undefined;
  const managedByToolRaw =
    isRecord(metaValue) && typeof metaValue['managedByTool'] === 'string'
      ? metaValue['managedByTool'].trim()
      : undefined;
  const sourceRaw =
    isRecord(metaValue) && typeof metaValue['source'] === 'string'
      ? metaValue['source'].trim()
      : undefined;
  const managementTool =
    managedByToolRaw && managedByToolRaw.length > 0
      ? managedByToolRaw
      : sourceRaw && sourceRaw.length > 0
        ? sourceRaw
        : undefined;

  const updateExampleRaw =
    isRecord(metaValue) && typeof metaValue['updateExample'] === 'string'
      ? metaValue['updateExample'].trim()
      : undefined;
  const editValue = isRecord(metaValue) ? metaValue['edit'] : undefined;
  const updateExampleFromEdit =
    isRecord(editValue) && typeof editValue['updateExample'] === 'string'
      ? editValue['updateExample'].trim()
      : undefined;
  const updateExample =
    updateExampleRaw && updateExampleRaw.length > 0
      ? updateExampleRaw
      : updateExampleFromEdit && updateExampleFromEdit.length > 0
        ? updateExampleFromEdit
        : managementTool
          ? `${managementTool}({ ... })`
          : undefined;

  if (language === 'zh') {
    if (managementTool) {
      const updateExampleSafe = updateExample ?? `${managementTool}({ ... })`;
      return [
        `提醒项 #${index}（高优先级工作集）`,
        '',
        '原则：提醒项要短、要新、要能直接指导下一步行动。及时维护；不需要就删。',
        '',
        `提示：该提醒项由工具 ${managementTool} 管理；请使用 ${managementTool} 更新（不要用 update_reminder）。`,
        '',
        '快捷操作：',
        `- 更新：${updateExampleSafe}`,
        `- 删除：delete_reminder({ "reminder_no": ${index} })`,
        '',
        '---',
        content,
      ].join('\n');
    }
    return [
      `提醒项 #${index}（高优先级工作集）`,
      '',
      '原则：提醒项要短、要新、要能直接指导下一步行动。及时维护；不需要就删。',
      '',
      '快捷操作：',
      `- 更新：update_reminder({ "reminder_no": ${index}, "content": "..." })`,
      `- 删除：delete_reminder({ "reminder_no": ${index} })`,
      '',
      '---',
      content,
    ].join('\n');
  }

  if (managementTool) {
    const updateExampleSafe = updateExample ?? `${managementTool}({ ... })`;
    return `REMINDER ITEM #${index} (HIGH-PRIORITY WORKING SET)

Principle: reminders should be high-value and not stale; keep them updated and delete when not needed.

Note: this reminder is managed by tool ${managementTool}; update it via ${managementTool} (not update_reminder).

Quick actions:
- Update: ${updateExampleSafe}
- Delete: delete_reminder({ "reminder_no": ${index} })
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

export function formatQ4HDiligencePushBudgetExhausted(
  language: LanguageCode,
  args: { maxInjectCount: number },
): string {
  const maxInjectCount = args.maxInjectCount;
  if (language === 'zh') {
    return [`[系统通知] 已经鞭策了 ${maxInjectCount} 次，智能体仍不听劝。`].join('\n');
  }

  return [
    `[System notification] After ${maxInjectCount} Diligence Push attempts, the agent is still not moved.`,
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
      `- 若你要找队友：请确认呼号（如 \`!?@pangu\` / \`!?@tellasker\` / \`!?@self\`）。`
    );
  }
  return (
    `Error: tellask is reserved for teammate tellasks (\`!?@<teammate>\`).\n` +
    `- Current target: \`@${firstMention}\` is not a known teammate call sign.\n` +
    `- If you intended to call a tool: use native function-calling; do not emit \`!?@tool\` in text.\n` +
    `- If you intended to call a teammate: double-check the call sign (e.g. \`!?@pangu\` / \`!?@tellasker\` / \`!?@self\`).`
  );
}

export function formatDomindsNoteQ4HRegisterFailed(
  language: LanguageCode,
  args: { error: string },
): string {
  const error = args.error;
  if (language === 'zh') {
    return (
      `错误：Q4H（\`@human\`）登记失败。\n` +
      `- 原因：${error}\n` +
      `- 建议：请重试；若持续失败，可删除该对话的 \`q4h.yaml\`（会丢失该对话的待答问题），或查看服务端日志。`
    );
  }

  return (
    `Error: failed to register Q4H (\`@human\`).\n` +
    `- Reason: ${error}\n` +
    `- Next: retry; if this keeps failing, delete the dialog's \`q4h.yaml\` (will drop pending questions) or check server logs.`
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
export function formatAgentFacingContextHealthV3RemediationGuide(
  language: LanguageCode,
  args: ContextHealthV3RemediationGuideArgs,
): string {
  if (language === 'zh') {
    if (args.kind === 'caution' && args.mode === 'soft') {
      return [
        '[系统通知] 上下文状态：🟡 吃紧',
        '',
        '影响：对话历史中的工具调用/结果信息很多已经过时，成为你的思考负担。',
        '',
        '行动：尽快准备接续包（下一步行动 + 关键定位信息），维护进提醒项。',
        '',
        '然后主动 clear_mind，开启新一程对话继续工作。',
        '',
        '操作：',
        '- update_reminder({ "reminder_no": 1, "content": "..." })（推荐）',
        '- add_reminder({ "content": "...", "position": 0 })',
      ].join('\n');
    }

    return [
      '[系统通知] 上下文状态：🔴 告急',
      '',
      `系统最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动清理头脑开启新一程对话。`,
      '',
      '行动：尽快把接续包维护进提醒项，然后 clear_mind。',
      '',
      '操作：',
      '- update_reminder({ "reminder_no": 1, "content": "..." })',
      '- add_reminder({ "content": "...", "position": 0 })',
      '- clear_mind({})',
      '',
      '接续包要点：下一步行动 + 关键定位信息 + 运行验证方式。',
    ].join('\n');
  }

  if (args.kind === 'caution' && args.mode === 'soft') {
    return [
      '[System notification] Context state: 🟡 caution',
      '',
      'Impact: stale call/results in dialog history are creating cognitive noise.',
      '',
      'Action: prepare a continuation package (next step + key pointers) and maintain it in reminders.',
      '',
      'Then proactively clear_mind to start a new dialog course.',
      '',
      'Operations:',
      '- update_reminder({ "reminder_no": 1, "content": "..." })',
      '- add_reminder({ "content": "...", "position": 0 })',
    ].join('\n');
  }

  return [
    '[System notification] Context state: 🔴 critical',
    '',
    `System will remind you ${args.promptsRemainingAfterThis} more time(s), then automatically clear mind.`,
    '',
    'Action: maintain a continuation package in reminders, then clear_mind.',
    '',
    'Operations:',
    '- update_reminder({ "reminder_no": 1, "content": "..." })',
    '- add_reminder({ "content": "...", "position": 0 })',
    '- clear_mind({})',
    '',
    'Continuation package: next step + key pointers + run/verify info.',
  ].join('\n');
}

export function formatDomindsNoteTellaskerOnlyInSidelineDialog(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`!?@tellasker` 只在支线对话中有效，用于向“诉请者”（发起本次诉请的对话）回问澄清。\n' +
      '你当前不在支线对话中，因此没有“诉请者”可回问。\n' +
      '（注：诉请者不一定是主线对话；差遣牒 `*.tsk/` 通常由主线对话维护人统一更新。）'
    );
  }
  return (
    'Dominds note: `!?@tellasker` is only valid inside a sideline dialog and tellasks back to the tellasker (the dialog that issued the current Tellask) for clarification. ' +
    'You are currently not in a sideline dialog, so there is no tellasker to call.'
  );
}

export function formatDomindsNoteTellaskerNoTellaskSession(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：`!?@tellasker` 是回问诉请（TellaskBack），不接受 `!tellaskSession`。' +
      '请使用不带 `!tellaskSession` 的 `!?@tellasker`；若你需要可恢复的多轮协作，请使用长线诉请：`!?@self !tellaskSession <tellaskSession>` / `!?@<agentId> !tellaskSession <tellaskSession>`。'
    );
  }
  return (
    'Dominds note: `!?@tellasker` is a TellaskBack and does not accept `!tellaskSession`. ' +
    'Use `!?@tellasker` with NO `!tellaskSession`, or use `!?@self !tellaskSession <tellaskSession>` / `!?@<agentId> !tellaskSession <tellaskSession>` for a resumable Tellask Session.'
  );
}

export function formatDomindsNoteDirectSelfCall(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      'Dominds 提示：该诉请目标是当前 agent（自诉请/self-tellask）。' +
      '扪心自问 通常应使用 `!?@self`（不带 `!tellaskSession`）来创建一次性的初心会话；' +
      '仅在你明确需要可恢复的长期支线对话时才使用 `!?@self !tellaskSession <tellaskSession>`。该诉请将继续执行。'
    );
  }
  return (
    'Dominds note: This call targets the current agent (self-tellask). ' +
    'Fresh Boots Reasoning should usually use `!?@self` (no `!tellaskSession`) for an ephemeral fresh boots session; use ' +
    '`!?@self !tellaskSession <tellaskSession>` only when you explicitly want a resumable long-lived sideline dialog. This call will proceed.'
  );
}

export function formatDomindsNoteFbrDisabled(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      '错误：当前团队配置不允许你使用 `!?@self` 扪心自问（FBR）自诉请。\n' +
      '- 请联系团队管理者调整配置后再试。\n' +
      '- 你仍可使用其它队友诉请（`!?@<teammate>`）或在当前对话中直接分析并给出结论。'
    );
  }
  return (
    'Error: `!?@self` Fresh Boots Reasoning (FBR) is disabled by your team configuration.\n' +
    '- Ask your team manager to adjust the team config, then retry `!?@self`.\n' +
    '- You can still tellask other teammates (`!?@<teammate>`) or provide analysis directly in the current dialog.'
  );
}

export type FbrToollessViolationKind = 'tellask' | 'tool' | 'tellask_and_tool' | 'internal_error';

export function formatDomindsNoteFbrToollessViolation(
  language: LanguageCode,
  args: { kind: FbrToollessViolationKind },
): string {
  const kind = args.kind;
  if (language === 'zh') {
    const detail =
      kind === 'tellask'
        ? '检测到你在 FBR 支线对话里发起了队友诉请（`!?@...`）。'
        : kind === 'tool'
          ? '检测到你在 FBR 支线对话里尝试调用函数工具。'
          : kind === 'tellask_and_tool'
            ? '检测到你在 FBR 支线对话里同时尝试发起队友诉请与函数工具调用。'
            : '内部错误：无法安全驱动 FBR 支线对话。';
    return [
      'ERR_FBR_TOOLLESS_VIOLATION',
      `Dominds 提示：当前是扪心自问（FBR）支线对话（无工具模式）。${detail}`,
      '',
      '- 本对话无任何工具：禁止函数工具调用。',
      '- 本对话禁止任何队友诉请（包括 `!?@human` / `!?@tellasker` / `!?@self`）。',
      '- 请只基于诉请正文（以及本支线对话自身的会话历史，如有）进行推理与总结。',
    ].join('\n');
  }

  const detail =
    kind === 'tellask'
      ? 'Detected a teammate tellask (`!?@...`) emitted inside an FBR sideline dialog.'
      : kind === 'tool'
        ? 'Detected a function tool call attempt inside an FBR sideline dialog.'
        : kind === 'tellask_and_tool'
          ? 'Detected both tellask and tool-call attempts inside an FBR sideline dialog.'
          : 'Internal error: cannot safely drive the FBR sideline dialog.';

  return [
    'ERR_FBR_TOOLLESS_VIOLATION',
    `Dominds note: this is a tool-less @self FBR sideline dialog. ${detail}`,
    '',
    '- No tools are available: do not emit function tool calls.',
    '- No tellasks are allowed (including `!?@human` / `!?@tellasker` / `!?@self`).',
    '- Provide pure reasoning and a summary grounded in the tellask body (and this sideline dialog’s own tellaskSession history, if any).',
  ].join('\n');
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
      '在队友诉请中，headline 里出现的队友呼号会被视为 collective targets 并被分发（所有目标共享同一 tellaskHead+tellaskBody）。\n' +
      '请确认这些呼号是否存在于团队目录中；若你只是想写字面上的 @something，请用反引号包裹（例如 `@something`）。'
    );
  }
  return (
    'ERR_INVALID_MULTI_TEAMMATE_TARGETS\n' +
    `Dominds note: This teammate tellask includes unknown teammate id(s): ${unknown}\n\n` +
    'In teammate tellasks, teammate mentions inside the headline are treated as collective targets and fanned out (shared tellaskHead+tellaskBody).\n' +
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
