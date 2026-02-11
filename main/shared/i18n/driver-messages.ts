import { formatLanguageName, type LanguageCode } from '../types/language';

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
      `错误：诉请（tellask）仅用于队友诉请（tellask-special 函数）。\n` +
      `- 当前目标：\`@${firstMention}\` 不是已知队友呼号。\n` +
      `- 若你要调用工具：请使用原生 function-calling（函数工具）。\n` +
      `- 若你要找队友：请使用 tellask-special 函数并确认 targetAgentId（如 \`pangu\`），支线回问请用 \`tellaskBack\`。`
    );
  }
  return (
    `Error: tellask is reserved for teammate tellasks (tellask-special functions).\n` +
    `- Current target: \`@${firstMention}\` is not a known teammate call sign.\n` +
    `- If you intended to call a tool: use native function-calling.\n` +
    `- If you intended to call a teammate: use tellask-special functions and verify targetAgentId (e.g. \`pangu\`); use \`tellaskBack\` for ask-back.`
  );
}

export function formatDomindsNoteQ4HRegisterFailed(
  language: LanguageCode,
  args: { error: string },
): string {
  const error = args.error;
  if (language === 'zh') {
    return (
      `错误：Q4H（\`askHuman\`）登记失败。\n` +
      `- 原因：${error}\n` +
      `- 建议：请重试；若持续失败，可删除该对话的 \`q4h.yaml\`（会丢失该对话的待答问题），或查看服务端日志。`
    );
  }

  return (
    `Error: failed to register Q4H (\`askHuman\`).\n` +
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
      'Dominds 提示：`tellaskBack` 只在支线对话中有效，用于向“诉请者”（发起本次诉请的对话）回问澄清。\n' +
      '你当前不在支线对话中，因此没有“诉请者”可回问。\n' +
      '（注：诉请者不一定是主线对话；差遣牒 `*.tsk/` 通常由主线对话维护人统一更新。）'
    );
  }
  return (
    'Dominds note: `tellaskBack` is only valid inside a sideline dialog and asks back to the tellasker (the dialog that issued the current Tellask) for clarification. ' +
    'You are currently not in a sideline dialog, so there is no tellasker to call.'
  );
}

export function formatDomindsNoteDirectSelfCall(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      '错误：不允许通过 `tellask` / `tellaskSessionless` 对当前 agent 发起自诉请。\n' +
      '- 若你要发起扪心自问（FBR），请使用 `freshBootsReasoning({ tellaskContent })`。\n' +
      '- `tellask` / `tellaskSessionless` 仅用于队友诉请（targetAgentId 必须是队友 id）。'
    );
  }
  return (
    'Error: self-targeted calls via `tellask` / `tellaskSessionless` are not allowed.\n' +
    '- For FBR, use `freshBootsReasoning({ tellaskContent })`.\n' +
    '- `tellask` / `tellaskSessionless` are teammate-only (targetAgentId must be a teammate id).'
  );
}

export function formatDomindsNoteFbrDisabled(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      '错误：当前团队配置不允许你使用 `freshBootsReasoning` 发起扪心自问（FBR）。\n' +
      '- 请联系团队管理者调整配置后再试。\n' +
      '- 你仍可使用其它队友诉请函数（tellask/tellaskSessionless）或在当前对话中直接分析并给出结论。'
    );
  }
  return (
    'Error: `freshBootsReasoning` (FBR) is disabled by your team configuration.\n' +
    '- Ask your team manager to adjust the team config, then retry `freshBootsReasoning`.\n' +
    '- You can still tellask other teammates via tellask functions (`tellask` / `tellaskSessionless`) or provide analysis directly in the current dialog.'
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
        ? '检测到你在 FBR 支线对话里尝试发起诉请（tellask 系列）。'
        : kind === 'tool'
          ? '检测到你在 FBR 支线对话里尝试调用函数工具。'
          : kind === 'tellask_and_tool'
            ? '检测到你在 FBR 支线对话里同时尝试发起诉请与函数工具调用。'
            : '内部错误：无法安全驱动 FBR 支线对话。';
    return [
      'ERR_FBR_TOOLLESS_VIOLATION',
      `Dominds 提示：当前是扪心自问（FBR）支线对话（无工具模式）。${detail}`,
      '',
      '- 本对话无任何工具：禁止函数工具调用。',
      '- 本对话禁止任何 tellask-special 函数（包括 `tellaskBack` / `tellask` / `tellaskSessionless` / `askHuman`）。',
      '- 请只基于诉请正文（以及本支线对话自身的会话历史，如有）进行推理与总结。',
    ].join('\n');
  }

  const detail =
    kind === 'tellask'
      ? 'Detected a tellask-special invocation attempt inside an FBR sideline dialog.'
      : kind === 'tool'
        ? 'Detected a function tool call attempt inside an FBR sideline dialog.'
        : kind === 'tellask_and_tool'
          ? 'Detected both tellask-special and tool-call attempts inside an FBR sideline dialog.'
          : 'Internal error: cannot safely drive the FBR sideline dialog.';

  return [
    'ERR_FBR_TOOLLESS_VIOLATION',
    `Dominds note: this is a tool-less FBR sideline dialog (triggered by \`freshBootsReasoning\`). ${detail}`,
    '',
    '- No tools are available: do not emit function tool calls.',
    '- No tellask-special functions are allowed (`tellaskBack` / `tellask` / `tellaskSessionless` / `askHuman`).',
    '- Provide pure reasoning and a summary grounded in the tellask body (and this sideline dialog’s own tellaskSession history, if any).',
  ].join('\n');
}
