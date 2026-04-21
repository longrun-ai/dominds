import { formatLanguageName, type LanguageCode } from '@longrun-ai/kernel/types/language';

export function formatSystemNoticePrefix(language: LanguageCode): string {
  return language === 'zh' ? '【系统提示】' : '[System notice]';
}

export function formatCurrentUserLanguagePreference(
  workingLanguage: LanguageCode,
  uiLanguage: LanguageCode,
): string {
  const uiName = formatLanguageName(uiLanguage, workingLanguage);
  const workingName = formatLanguageName(workingLanguage, workingLanguage);
  const prefix = formatSystemNoticePrefix(workingLanguage);
  if (workingLanguage === 'zh') {
    if (uiLanguage === workingLanguage) {
      return [
        prefix,
        '这是浏览器里的界面语言设置，不是新的用户指令；不要停下当前工作，也不要单独回复确认，只需在后续继续任务时遵守。',
        `你对用户的可见回复语言应使用：${uiName}。`,
      ].join('\n');
    }
    return [
      prefix,
      '这是浏览器里的界面语言设置，不是新的用户指令；不要停下当前工作，也不要单独回复确认，只需在后续继续任务时遵守。',
      `你对用户的可见回复语言应使用：${uiName}。`,
      `你的内部工作语言保持为：${workingName}（用于系统提示、队友诉请与工具调用）。`,
    ].join('\n');
  }

  if (uiLanguage === workingLanguage) {
    return [
      prefix,
      'This comes from a browser UI language change, not a new user instruction. Do not stop the current work or send a standalone acknowledgement; just follow it in subsequent work.',
      `Your user-visible reply language should be: ${uiName}.`,
    ].join('\n');
  }
  return [
    prefix,
    'This comes from a browser UI language change, not a new user instruction. Do not stop the current work or send a standalone acknowledgement; just follow it in subsequent work.',
    `Your user-visible reply language should be: ${uiName}.`,
    `Your internal work language remains: ${workingName} (system prompt, teammate comms, function tools).`,
  ].join('\n');
}

export function formatUserLanguagePreferenceChangedNotice(
  workingLanguage: LanguageCode,
  previousUiLanguage: LanguageCode,
  nextUiLanguage: LanguageCode,
): string {
  const previousName = formatLanguageName(previousUiLanguage, workingLanguage);
  const nextName = formatLanguageName(nextUiLanguage, workingLanguage);
  const prefix = formatSystemNoticePrefix(workingLanguage);
  if (workingLanguage === 'zh') {
    return [
      prefix,
      '这是浏览器里的界面语言切换，不是新的用户指令；不要停下当前工作，不要只回复“收到/好的”，也不要把这条提示当成新的待办。',
      `用户的界面语言已从 ${previousName} 切换为 ${nextName}。`,
      `从现在起，你对用户的可见回复语言应使用：${nextName}。`,
      '继续推进当前任务本身。',
    ].join('\n');
  }
  return [
    prefix,
    'This is a browser UI language change, not a new user instruction. Do not stop the current work, do not reply with a standalone "acknowledged/ok", and do not treat this notice as a new to-do.',
    `The user UI language changed from ${previousName} to ${nextName}.`,
    `From now on, your user-visible reply language should be: ${nextName}.`,
    'Continue the current task itself.',
  ].join('\n');
}

export function formatRegisteredTellaskCallerUpdateNotice(language: LanguageCode): string {
  const prefix = formatSystemNoticePrefix(language);
  if (language === 'zh') {
    return [
      prefix,
      '刚才那轮诉请不用再等了；对方接下来会按你刚更新的要求继续处理，后续请以最新要求为准。',
    ].join('\n');
  }
  return [
    prefix,
    'You no longer need to wait on that earlier request. The teammate will continue under your updated request, so treat the latest request as the one now in effect.',
  ].join('\n');
}

export function formatRegisteredTellaskCalleeUpdateNotice(language: LanguageCode): string {
  const prefix = formatSystemNoticePrefix(language);
  if (language === 'zh') {
    return [
      prefix,
      '你的工作要求刚刚更新了。',
      '这不是一条需要你单独回复的消息；不要停在“收到/好的”之类的确认上。',
      '请继续处理下面这份最新完整要求，并以它为准推进后续工作。',
    ].join('\n');
  }
  return [
    prefix,
    'Your working request has just been updated.',
    'This is not a message to acknowledge on its own; do not stop at a standalone "acknowledged/ok" reply.',
    'Continue the work using the latest full request below as the one to follow.',
  ].join('\n');
}

export function formatNewCourseStartPrompt(
  language: LanguageCode,
  args: {
    nextCourse: number;
    source: 'clear_mind' | 'critical_auto_clear';
  },
): string {
  const noticePrefix = formatSystemNoticePrefix(language);
  if (language === 'zh') {
    const prefix =
      args.source === 'clear_mind'
        ? `你刚清理头脑，开启了第 ${args.nextCourse} 程对话。`
        : `系统因上下文已告急（critical）而自动开启了第 ${args.nextCourse} 程对话。`;
    return (
      `${noticePrefix} ${prefix} ` +
      '这是一条运行时换程指令，不是新的用户诉求；不要把这条提示当成新的待办，也不要只回复“收到/好的/我会先整理提醒项”。' +
      '现在已经进入新一程：第一步先复核并在必要时整理接续包提醒项，以清醒头脑删除冗余、纠正偏激或失真的过桥思路、压缩成高质量提醒项；若提醒项已经足够清晰，就不要为了整理而整理。' +
      '完成这一步后，直接继续推进原任务本身；除非任务自然需要对用户交付结果，否则不要为这条提示单独回复。'
    );
  }

  const prefix =
    args.source === 'clear_mind'
      ? `This is dialog course #${args.nextCourse}. You just cleared your mind.`
      : `System auto-started dialog course #${args.nextCourse} because context health is critical.`;
  return (
    `${noticePrefix} ${prefix} ` +
    'This is a runtime course-transition instruction, not a new user request; do not treat it as a new to-do, and do not reply with a standalone "acknowledged/ok/I will reorganize the reminders first". ' +
    'You are now in a new course: your first step is to review and, if needed, rewrite any continuation-package reminders with a clear head, remove redundancy, correct biased or distorted bridge notes, and compress them into high-quality reminders; if the reminders are already clear enough, do not churn on them. ' +
    'After that, continue the underlying task itself directly; unless the task naturally calls for a user-facing delivery, do not send a standalone reply just for this notice.'
  );
}

export function formatDiligenceAutoContinuePrompt(
  language: LanguageCode,
  diligenceText: string,
): string {
  const noticePrefix = formatSystemNoticePrefix(language);
  const trimmed = diligenceText.trim();
  if (trimmed === '') {
    throw new Error('diligenceText must not be empty');
  }

  if (language === 'zh') {
    return [
      `${noticePrefix} 这是一条运行时自动续推指令，不是新的用户诉求。`,
      '不要把这条提示当成新的待办，也不要只回复“收到/好的/我先想想/我会先整理一下”。',
      '请直接按下面的引导继续推进任务；若形成结论，必须尽快落地为实际动作，不要停在“只汇报决定/只确认收到”。',
      '',
      '---',
      '',
      trimmed,
    ].join('\n');
  }

  return [
    `${noticePrefix} This is a runtime auto-continue instruction, not a new user request.`,
    'Do not treat this notice as a new to-do, and do not reply with a standalone "acknowledged/ok/I will think first/I will organize things first".',
    'Follow the guidance below and continue the task directly; if you reach a conclusion, turn it into concrete action promptly instead of stopping at a decision report or acknowledgement.',
    '',
    '---',
    '',
    trimmed,
  ].join('\n');
}

export function formatReminderContextGuide(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      formatSystemNoticePrefix(language),
      '以下是当前可见提醒项的运行时上下文投影。它们会按各自语义进入模型上下文（例如 self-reminder 保持 assistant-side 工作集语义），但不是我刚刚生成给用户的聊天正文。',
      '在 WebUI 中，用户通过独立的 Reminder 小组件/面板项看到这些提醒，并能把它们和聊天正文区分开。',
      '提醒项只作为工作集/状态参考；只有实际改变当前判断、计划或风险的信息，才需要提炼进后续有实质内容的对外回复。',
    ].join('\n');
  }

  return [
    formatSystemNoticePrefix(language),
    'The following visible reminders are runtime-added context projections. They enter model context according to their own semantics (for example, self-reminders keep assistant-side workset semantics), but they are not chat text I just generated for the user.',
    'In the WebUI, the user sees these reminders through a separate Reminder widget/panel item and can distinguish them from the chat transcript.',
    'Use reminders as workset/state references; only carry information into a later substantive outward reply when it materially changes current judgment, plan, or risk.',
  ].join('\n');
}

function formatReminderItemProjectionNote(language: LanguageCode): string {
  return language === 'zh' ? 'Reminder 上下文投影条目：' : 'Reminder context projection item:';
}

export function formatReminderItemGuide(
  language: LanguageCode,
  reminderId: string,
  content: string,
  options?: { meta?: unknown; scope?: 'dialog' | 'personal' | 'agent_shared' },
): string {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // `options.meta` is persisted JSON coming from tools. Runtime shape checks are unavoidable here
  // to keep reminder ownership/management loosely coupled and extensible.
  const metaValue = options && 'meta' in options ? options.meta : undefined;
  const scope = options?.scope;
  const isContinuationPackageReminder =
    isRecord(metaValue) && metaValue['kind'] === 'continuation_package';
  const isPendingTellaskReminder = isRecord(metaValue) && metaValue['kind'] === 'pending_tellask';
  const pendingTellaskCount =
    isPendingTellaskReminder && typeof metaValue['pendingCount'] === 'number'
      ? metaValue['pendingCount']
      : undefined;
  const managerValue = isRecord(metaValue) ? metaValue['manager'] : undefined;
  const managementTool =
    isRecord(managerValue) && typeof managerValue['tool'] === 'string'
      ? managerValue['tool'].trim()
      : undefined;

  const updateValue = isRecord(metaValue) ? metaValue['update'] : undefined;
  const updateAltInstruction =
    isRecord(updateValue) && typeof updateValue['altInstruction'] === 'string'
      ? updateValue['altInstruction'].trim()
      : undefined;
  const updateInstruction =
    updateAltInstruction && updateAltInstruction.length > 0
      ? updateAltInstruction
      : managementTool
        ? `${managementTool}({ ... })`
        : undefined;
  const deleteValue = isRecord(metaValue) ? metaValue['delete'] : undefined;
  const deleteAltInstruction =
    isRecord(deleteValue) && typeof deleteValue['altInstruction'] === 'string'
      ? deleteValue['altInstruction'].trim()
      : undefined;
  const deleteInstruction =
    language === 'zh'
      ? deleteAltInstruction
        ? `如果我要删除这条提醒项，不能用 delete_reminder；请执行：${deleteAltInstruction}`
        : isPendingTellaskReminder && pendingTellaskCount === 0
          ? `如果我已确认这里只是清理噪音、并非要推进动作，可执行：delete_reminder({ "reminder_id": "${reminderId}" })`
          : `如果我要删除这条提醒项，可执行：delete_reminder({ "reminder_id": "${reminderId}" })`
      : deleteAltInstruction
        ? `If I need to delete this reminder, I must not use delete_reminder; run: ${deleteAltInstruction}`
        : isPendingTellaskReminder && pendingTellaskCount === 0
          ? `If I have confirmed this is only noise cleanup and not an action step, I may run: delete_reminder({ "reminder_id": "${reminderId}" })`
          : `If I need to delete this reminder, run: delete_reminder({ "reminder_id": "${reminderId}" })`;
  const projectionNote = formatReminderItemProjectionNote(language);
  const enProjectionPrefix = `${projectionNote} `;

  if (language === 'zh') {
    if (managementTool) {
      const updateInstructionSafe = updateInstruction ?? `${managementTool}({ ... })`;
      return [
        `提醒项 [${reminderId}]（工具状态）`,
        '',
        `${projectionNote}我把这条当作工具维护的状态参考。默认不在对外回复里专门确认、复述或总结它；只有它实际改变当前判断、计划或风险时，我才提炼真正相关的部分。`,
        '',
        `这条提醒项由工具 ${managementTool} 管理；如果我要调整它，就用 ${managementTool}（不要用 update_reminder）。`,
        '',
        `如果我要更新这条提醒项，可执行：${updateInstructionSafe}`,
        deleteInstruction,
        '',
        '---',
        content,
      ].join('\n');
    }
    if (updateInstruction) {
      return [
        `提醒项 [${reminderId}]`,
        '',
        `${projectionNote}这是带有 meta 控制更新规则的提醒项。我仍把它当作状态参考，但不要用 update_reminder 直接改写内容。`,
        '',
        `如果我要更新这条提醒项，不能用 update_reminder；请按此处理：${updateInstruction}`,
        deleteInstruction,
        '',
        '---',
        content,
      ].join('\n');
    }
    if (isContinuationPackageReminder) {
      return [
        `提醒项 [${reminderId}]（换程接续信息）`,
        '',
        `${projectionNote}我把这条当作换程后快速恢复工作的接续包，不把它自动当成当前必须立刻执行的指令。`,
        '',
        '我应优先保留下一步行动、关键定位、运行/验证信息、容易丢的临时细节；不要重复差遣牒已覆盖的内容。进入新一程后，我的第一步就是以清醒头脑重新审视并整理更新：删除冗余、纠正偏激/失真思路、压缩成高质量提醒项。若目前只是粗略过桥笔记，进入新一程后我必须尽快收敛。',
        '',
        `如果我要更新这份接续包，可执行：update_reminder({ "reminder_id": "${reminderId}", "content": "..." })`,
        deleteInstruction,
        '',
        '---',
        content,
      ].join('\n');
    }
    return [
      `提醒项 [${reminderId}]${scope === 'personal' ? '（个人范围）' : ''}`,
      '',
      scope === 'personal'
        ? `${projectionNote}这是我给自己的个人范围显眼提示；在所有由我主理的后续对话里都会看到它。我不把它自动当成系统下发的下一步动作。`
        : `${projectionNote}这是我给自己的显眼提示，用于保留当前对话里容易丢的工作信息；我不把它自动当成系统下发的下一步动作。`,
      '',
      scope === 'personal'
        ? '我应保持简洁、及时更新；不再需要时就删除。若它只对当前对话有效，应改写成 dialog 范围提醒而不是长期堆在个人范围里。'
        : '我应保持简洁、及时更新；不再需要时就删除。若后续准备换程，也可以把它整理成接续包。',
      '',
      `如果我要更新这条提醒项，可执行：update_reminder({ "reminder_id": "${reminderId}", "content": "..." })`,
      deleteInstruction,
      '',
      '---',
      content,
    ].join('\n');
  }

  if (managementTool) {
    const updateInstructionSafe = updateInstruction ?? `${managementTool}({ ... })`;
    return `REMINDER [${reminderId}] (TOOL STATE)

${enProjectionPrefix}I treat this as a tool-maintained state reference. By default I should not explicitly acknowledge, restate, or summarize it in my outward reply; I should only extract the parts that materially change my current judgment, plan, or risk.

This reminder is managed by tool ${managementTool}; if I need to change it, I should use ${managementTool} instead of update_reminder.

If I need to update this reminder, run: ${updateInstructionSafe}
${deleteInstruction}
---
${content}`;
  }
  if (updateInstruction) {
    return `REMINDER [${reminderId}]

${enProjectionPrefix}This reminder has a meta-controlled update path. I should still treat it as state/reference, and I must not rewrite it directly with update_reminder.

If I need to update this reminder, I must not use update_reminder; follow instead: ${updateInstruction}
${deleteInstruction}
---
${content}`;
  }
  if (isContinuationPackageReminder) {
    return `REMINDER [${reminderId}] (CONTINUATION PACKAGE)

${enProjectionPrefix}I treat this as resume information for the next course, not as an automatic must-do command.

I should keep the next step, key pointers, run/verify info, and easy-to-lose volatile details here. I should not duplicate Taskdoc content. In the new course, my first step is to review and rewrite this with a clear head: remove redundancy, correct biased or distorted bridge notes, and compress it into a high-quality reminder. If this is only a rough bridge note, I should reconcile it early in the new course.

If I need to update this package, run: update_reminder({ "reminder_id": "${reminderId}", "content": "..." })
${deleteInstruction}
---
${content}`;
  }
  return `REMINDER [${reminderId}]${scope === 'personal' ? ' (PERSONAL SCOPE)' : ''}

${
  scope === 'personal'
    ? `${enProjectionPrefix}This is my conspicuous personal-scope reminder. I will keep seeing it in all later dialogs I lead, and I do not treat it as an automatically assigned next action.`
    : `${enProjectionPrefix}This is my conspicuous self-reminder for easy-to-lose work details in the current dialog. I do not treat it as an automatically assigned next action.`
}

${
  scope === 'personal'
    ? 'I should keep it concise, refresh it when needed, and delete it when obsolete. If it is only useful for the current dialog, I should rewrite it into dialog scope instead of letting personal scope accumulate noise.'
    : 'I should keep it concise, refresh it when needed, and delete it when obsolete. If I am preparing a new course, I can also rewrite it into a continuation package.'
}

If I need to update this reminder, run: update_reminder({ "reminder_id": "${reminderId}", "content": "..." })
${deleteInstruction}
---
${content}`;
}

export function formatQ4HDiligencePushBudgetExhausted(
  language: LanguageCode,
  args: { maxInjectCount: number },
): string {
  const maxInjectCount = args.maxInjectCount;
  if (language === 'zh') {
    return [
      `${formatSystemNoticePrefix(language)} 已经鞭策了 ${maxInjectCount} 次，智能体仍不听劝。`,
    ].join('\n');
  }

  return [
    `${formatSystemNoticePrefix(language)} After ${maxInjectCount} Diligence Push attempts, the agent is still not moved.`,
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
        `${formatSystemNoticePrefix(language)} 上下文状态：🟡 吃紧`,
        '',
        '这是一条运行时处置指令，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的处置动作。',
        '',
        '影响：对话历史中的工具调用/结果信息很多已经过时，成为你的思考负担。',
        '',
        '行动：先尽量保住易丢信息。当前处于吃紧处置阶段时，优先把已经掌握的事实直接记进新提醒项过桥（下一步行动 + 关键定位信息 + 运行/验证信息 + 容易丢的临时细节）；允许先带着一定冗余，也允许先写成多条粗略提醒项，不必在当前程强行压成单条。',
        '',
        '当前已处于吃紧处置阶段：不要继续扩张上下文，也不要提前进入“按接续包做清醒复核”的模式；那是系统真正开启新一程后的第一步。当前程的目标是先把差遣牒未覆盖、但恢复工作会丢的信息带过桥；真正清理冗余、合并提醒项，放到新一程再做。然后主动 clear_mind，开启新一程对话继续工作。',
        '',
        '操作：',
        '- 优先新增过桥提醒项：add_reminder({ "content": "..." })',
        '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
      ].join('\n');
    }

    return [
      `${formatSystemNoticePrefix(language)} 上下文状态：🔴 告急`,
      '',
      '这是一条运行时处置指令，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的处置动作。',
      '',
      `系统最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动清理头脑开启新一程对话。`,
      '',
      '行动：尽快保住易丢信息，然后 clear_mind。当前处于告急处置阶段时，优先直接新增提醒项把事实带过桥；允许先保留多条粗略提醒项，甚至带一定冗余也可以，不必在当前程强行整理干净。',
      '',
      '操作：',
      '- 优先新增过桥提醒项：add_reminder({ "content": "..." })',
      '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
      '- clear_mind({})',
      '',
      '接续包要点：下一步行动 + 关键定位信息 + 运行验证方式 + 容易丢的临时细节；不要重复差遣牒已有内容。当前处于告急处置阶段时，不要提前做“新一程清醒复核”；系统真正开启新一程后，第一步才是重新审视并整理：删除冗余、纠正偏激/失真思路、合并并压缩成高质量提醒项。',
    ].join('\n');
  }

  if (args.kind === 'caution' && args.mode === 'soft') {
    return [
      `${formatSystemNoticePrefix(language)} Context state: 🟡 caution`,
      '',
      'This is a runtime remediation instruction, not a new user request; do not reply with a standalone "acknowledged/ok/I will organize reminders first", and instead perform the remediation actions directly.',
      '',
      'Impact: stale call/results in dialog history are creating cognitive noise.',
      '',
      'Action: first preserve easy-to-lose information. In caution remediation, prefer writing already observed facts into new bridge reminders directly (next step + key pointers + run/verify info + easy-to-lose volatile details). Some redundancy is acceptable, and rough multi-reminder carry-over is acceptable too; do not force everything into one clean reminder in the current course.',
      '',
      'You are already in caution remediation for the current course, so do not keep expanding context and do not switch early into “clear-headed continuation-package review” mode; that is the first step only after the system actually starts the new course. In the current course, the goal is to carry forward details not already covered by Taskdoc; reminder cleanup and dedup belong to the new course. Then proactively clear_mind to start a new dialog course.',
      '',
      'Operations:',
      '- Prefer adding a bridge reminder first: add_reminder({ "content": "..." })',
      '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
    ].join('\n');
  }

  return [
    `${formatSystemNoticePrefix(language)} Context state: 🔴 critical`,
    '',
    'This is a runtime remediation instruction, not a new user request; do not reply with a standalone "acknowledged/ok/I will organize reminders first", and instead perform the remediation actions directly.',
    '',
    `System will remind you ${args.promptsRemainingAfterThis} more time(s), then automatically clear mind.`,
    '',
    'Action: preserve easy-to-lose information, then clear_mind. In critical remediation, prefer adding bridge reminders directly. Multiple rough reminders, including some redundancy, are acceptable as a bridge; do not spend the current course forcing them into a clean final package.',
    '',
    'Operations:',
    '- Prefer adding a bridge reminder first: add_reminder({ "content": "..." })',
    '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
    '- clear_mind({})',
    '',
    'Continuation package: next step + key pointers + run/verify info + easy-to-lose volatile details. Do not duplicate Taskdoc content. During critical remediation in the current course, do not start the new-course cleanup early; once the system actually starts the new course, the first step is to reconcile rough bridge reminders by removing redundancy, correcting biased or distorted bridge notes, and merging/compressing them into high-quality reminders.',
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
