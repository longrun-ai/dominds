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

export function formatNewCourseStartPrompt(
  language: LanguageCode,
  args: {
    nextCourse: number;
    source: 'clear_mind' | 'critical_auto_clear';
  },
): string {
  if (language === 'zh') {
    const prefix =
      args.source === 'clear_mind'
        ? `你刚清理头脑，开启了第 ${args.nextCourse} 程对话。`
        : `系统因上下文已告急（critical）而自动开启了第 ${args.nextCourse} 程对话。`;
    return (
      `${prefix} ` +
      '第一步先复核并整理接续包提醒项：以清醒头脑删除冗余、纠正偏激或失真的过桥思路、压缩成高质量提醒项；再继续推进任务。'
    );
  }

  const prefix =
    args.source === 'clear_mind'
      ? `This is course #${args.nextCourse} of the dialog. You just cleared your mind.`
      : `System auto-started course #${args.nextCourse} of the dialog because context health is critical.`;
  return (
    `${prefix} ` +
    'Your first step is to review and rewrite any continuation-package reminders with a clear head: remove redundancy, correct biased or distorted bridge notes, compress them into high-quality reminders, and then continue the task.'
  );
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
  const isContinuationPackageReminder =
    isRecord(metaValue) && metaValue['kind'] === 'continuation_package';
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
        `提醒项 #${index}（工具状态）`,
        '',
        '说明：这是由工具维护的提醒展示，可视为当前状态参考；它不自动等于你现在必须立刻执行的指令。',
        '',
        `提示：该提醒项由工具 ${managementTool} 管理；如需调整，请使用 ${managementTool}（不要用 update_reminder）。`,
        '',
        `如需更新此提醒项，可执行：${updateExampleSafe}`,
        `如需删除此提醒项，可执行：delete_reminder({ "reminder_no": ${index} })`,
        '',
        '---',
        content,
      ].join('\n');
    }
    if (isContinuationPackageReminder) {
      return [
        `提醒项 #${index}（换程接续信息）`,
        '',
        '说明：这是用于换程后快速恢复工作的接续包，不自动等于当前必须立刻执行的指令。',
        '',
        '建议：优先保留下一步行动、关键定位、运行/验证信息、容易丢的临时细节；不要重复差遣牒已覆盖的内容。进入新一程后，第一步就要以清醒头脑重新审视并整理更新：删除冗余、纠正偏激/失真思路、压缩成高质量提醒项。若目前只是粗略过桥笔记，进入新一程后必须尽快收敛。',
        '',
        `如需更新此接续包，可执行：update_reminder({ "reminder_no": ${index}, "content": "..." })`,
        `如需删除此提醒项，可执行：delete_reminder({ "reminder_no": ${index} })`,
        '',
        '---',
        content,
      ].join('\n');
    }
    return [
      `提醒项 #${index}`,
      '',
      '说明：这是你给自己的显眼提示，用于保留当前对话里容易丢的工作信息；它不自动等于系统下发的下一步动作。',
      '',
      '建议：保持简洁、及时更新；不再需要时删除。若后续准备换程，也可以把它整理成接续包。',
      '',
      `如需更新此提醒项，可执行：update_reminder({ "reminder_no": ${index}, "content": "..." })`,
      `如需删除此提醒项，可执行：delete_reminder({ "reminder_no": ${index} })`,
      '',
      '---',
      content,
    ].join('\n');
  }

  if (managementTool) {
    const updateExampleSafe = updateExample ?? `${managementTool}({ ... })`;
    return `REMINDER ITEM #${index} (TOOL STATE)

Note: this is a tool-maintained reminder display. Treat it as state reference, not as an automatic must-do command.

This reminder is managed by tool ${managementTool}; if you need to change it, use ${managementTool} instead of update_reminder.

If you need to update this reminder, run: ${updateExampleSafe}
If you need to delete this reminder, run: delete_reminder({ "reminder_no": ${index} })
---
${content}`;
  }
  if (isContinuationPackageReminder) {
    return `REMINDER ITEM #${index} (CONTINUATION PACKAGE)

Note: this is resume information for the next course, not an automatic must-do command.

Guidance: keep the next step, key pointers, run/verify info, and easy-to-lose volatile details. Do not duplicate Taskdoc content. In the new course, your first step is to review and rewrite this with a clear head: remove redundancy, correct biased or distorted bridge notes, and compress it into a high-quality reminder. If this is only a rough bridge note, reconcile it early in the new course.

If you need to update this package, run: update_reminder({ "reminder_no": ${index}, "content": "..." })
If you need to delete this reminder, run: delete_reminder({ "reminder_no": ${index} })
---
${content}`;
  }
  return `REMINDER ITEM #${index}

Note: this is a conspicuous reminder to yourself for easy-to-lose work details in the current dialog. It is not an automatically assigned next action.

Guidance: keep it concise, refresh it when needed, and delete it when obsolete. If you are preparing a new course, you can also rewrite it into a continuation package.

If you need to update this reminder, run: update_reminder({ "reminder_no": ${index}, "content": "..." })
If you need to delete this reminder, run: delete_reminder({ "reminder_no": ${index} })
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
        '行动：先尽量保住易丢信息；如头脑还清楚，优先整理成结构化接续包提醒项（下一步行动 + 关键定位信息 + 运行/验证信息 + 容易丢的临时细节）。',
        '',
        '若你已经发乱，允许先记成多条粗略提醒项带到新一程；求稳比求整洁更重要。进入新一程后，第一步就是复核并整理提醒项：删除冗余、纠正偏激/失真思路、压缩成高质量提醒项，然后再继续工作。接续包只保留差遣牒未覆盖、但恢复工作会丢的信息。然后主动 clear_mind，开启新一程对话继续工作。',
        '',
        '操作：',
        '- update_reminder({ "reminder_no": 1, "content": "..." })（推荐）',
        '- add_reminder({ "content": "..." })',
      ].join('\n');
    }

    return [
      '[系统通知] 上下文状态：🔴 告急',
      '',
      `系统最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动清理头脑开启新一程对话。`,
      '',
      '行动：尽快保住易丢信息，然后 clear_mind。能整理就整理成结构化接续包提醒项；若已经发乱，先保留多条粗略提醒项也可以。',
      '',
      '操作：',
      '- update_reminder({ "reminder_no": 1, "content": "..." })',
      '- add_reminder({ "content": "..." })',
      '- clear_mind({})',
      '',
      '接续包要点：下一步行动 + 关键定位信息 + 运行验证方式 + 容易丢的临时细节；不要重复差遣牒已有内容。若先带多条粗略提醒项过桥，新一程第一步就要重新审视并整理：删除冗余、纠正偏激/失真思路、压缩成高质量提醒项。',
    ].join('\n');
  }

  if (args.kind === 'caution' && args.mode === 'soft') {
    return [
      '[System notification] Context state: 🟡 caution',
      '',
      'Impact: stale call/results in dialog history are creating cognitive noise.',
      '',
      'Action: first preserve easy-to-lose information; if you are still clear-headed, prefer a structured continuation-package reminder (next step + key pointers + run/verify info + easy-to-lose volatile details).',
      '',
      'If you are already muddled, multiple rough reminders are acceptable as a bridge; survival matters more than neatness. In the new course, your first step is to review and rewrite reminders: remove redundancy, correct biased or distorted bridge notes, compress them into high-quality reminders, and only then continue. Keep only details not already covered by Taskdoc. Then proactively clear_mind to start a new dialog course.',
      '',
      'Operations:',
      '- update_reminder({ "reminder_no": 1, "content": "..." })',
      '- add_reminder({ "content": "..." })',
    ].join('\n');
  }

  return [
    '[System notification] Context state: 🔴 critical',
    '',
    `System will remind you ${args.promptsRemainingAfterThis} more time(s), then automatically clear mind.`,
    '',
    'Action: preserve easy-to-lose information, then clear_mind. Prefer a structured continuation-package reminder if you can still think clearly; otherwise multiple rough reminders are acceptable as a bridge.',
    '',
    'Operations:',
    '- update_reminder({ "reminder_no": 1, "content": "..." })',
    '- add_reminder({ "content": "..." })',
    '- clear_mind({})',
    '',
    'Continuation package: next step + key pointers + run/verify info + easy-to-lose volatile details. Do not duplicate Taskdoc content. If you bridge with multiple rough reminders first, reconcile them at the start of the new course by removing redundancy, correcting biased or distorted bridge notes, and compressing them into high-quality reminders.',
  ].join('\n');
}

export function formatDomindsNoteDirectSelfCall(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      '错误：不允许通过 `tellask` / `tellaskSessionless` 对当前 agent 发起自诉请。\n' +
      '- 若你要发起扪心自问（FBR），请使用 `freshBootsReasoning({ tellaskContent, effort? })`。\n' +
      '- `tellask` / `tellaskSessionless` 仅用于队友诉请（targetAgentId 必须是队友 id）。'
    );
  }
  return (
    'Error: self-targeted calls via `tellask` / `tellaskSessionless` are not allowed.\n' +
    '- For FBR, use `freshBootsReasoning({ tellaskContent, effort? })`.\n' +
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
