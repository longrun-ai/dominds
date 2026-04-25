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

export function formatRegisteredTellaskTellaskerUpdateNotice(language: LanguageCode): string {
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

export function formatRegisteredTellaskTellaskeeUpdateNotice(language: LanguageCode): string {
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
      `${formatSystemNoticePrefix(language)} 提醒项上下文块开始`,
      '以下是当前可见提醒项的运行时上下文投影。由于当前 LLM Provider 通常不支持 role=environment，Dominds 默认把系统运行时提醒包装投影为 role=user；个别提醒项可由其 owner 按自身契约选择 role。无论最终 role 如何，它们都不是新的用户指令/诉求，也不是聊天正文。',
      '在 WebUI 中，用户通过独立的 Reminder 小组件/面板项看到这些提醒，并能把它们和聊天正文区分开。',
      '请把提醒项作为工作集/状态参考；只有实际改变你的判断、计划或风险的信息，才需要提炼进后续有实质内容的对外回复。不要为了提醒项单独回复“收到/已了解/静默吸收”。',
    ].join('\n');
  }

  return [
    `${formatSystemNoticePrefix(language)} Reminder context block begins`,
    'The following visible reminders are runtime-added context projections. Because current LLM providers usually do not support role=environment, Dominds projects default system-runtime reminder wrappers as role=user; individual reminder owners may choose the role required by their own contract. Regardless of their final role, these reminders are not new user instructions or requests, and not chat transcript text.',
    'In the WebUI, the user sees these reminders through a separate Reminder widget/panel item and can distinguish them from the chat transcript.',
    'Use reminders as workset/state references; only carry information into a later substantive outward reply when it materially changes your current judgment, plan, or risk. Do not send a standalone "acknowledged/noted/silently absorbed" reply for reminder items.',
  ].join('\n');
}

function formatReminderItemProjectionNote(language: LanguageCode): string {
  return language === 'zh' ? '运行时提醒项投影：' : 'Runtime reminder projection:';
}

export function formatReminderContextFooter(language: LanguageCode): string {
  return language === 'zh'
    ? `${formatSystemNoticePrefix(language)} 提醒项上下文块结束。以上从“提醒项上下文块开始”到“提醒项上下文块结束”之间的提醒项均为系统提醒，并非用户指令；该块之外的后续对话消息不受此说明影响。真正的用户指令（若有）在后续对话消息中的用户消息里。`
    : `${formatSystemNoticePrefix(language)} Reminder context block ends. The reminder items between "Reminder context block begins" and "Reminder context block ends" are system reminders, not user instructions; this note does not apply to subsequent dialog messages outside this block. Any real user instruction, if present, is in the user messages that follow.`;
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
        ? `如果你要删除这条提醒项，不能用 delete_reminder；请执行：${deleteAltInstruction}`
        : isPendingTellaskReminder && pendingTellaskCount === 0
          ? `如果你已确认这里只是清理噪音、并非要推进动作，可执行：delete_reminder({ "reminder_id": "${reminderId}" })`
          : `如果你要删除这条提醒项，可执行：delete_reminder({ "reminder_id": "${reminderId}" })`
      : deleteAltInstruction
        ? `If you need to delete this reminder, do not use delete_reminder; run: ${deleteAltInstruction}`
        : isPendingTellaskReminder && pendingTellaskCount === 0
          ? `If you have confirmed this is only noise cleanup and not an action step, you may run: delete_reminder({ "reminder_id": "${reminderId}" })`
          : `If you need to delete this reminder, run: delete_reminder({ "reminder_id": "${reminderId}" })`;
  const projectionNote = formatReminderItemProjectionNote(language);
  const enProjectionPrefix = `${projectionNote} `;
  const systemPrefix = formatSystemNoticePrefix(language);

  if (language === 'zh') {
    if (managementTool) {
      const updateInstructionSafe = updateInstruction ?? `${managementTool}({ ... })`;
      return [
        `${systemPrefix} 提醒项 [${reminderId}]（工具状态）`,
        '',
        `${projectionNote}当前运行环境中有一条由工具 ${managementTool} 管理的状态提醒项。请把它当作环境/工具状态参考，不要当作你自己写的工作便签。`,
        '',
        '默认不要在对外回复里专门确认、复述或总结它；只有它实际改变你的判断、计划或风险时，才提炼真正相关的部分。',
        '',
        `这条提醒项由工具 ${managementTool} 管理；如果你要调整它，就用 ${managementTool}（不要用 update_reminder）。`,
        '',
        `如果你要更新这条提醒项，可执行：${updateInstructionSafe}`,
        deleteInstruction,
        '',
        '---',
        content,
      ].join('\n');
    }
    if (updateInstruction) {
      return [
        `${systemPrefix} 提醒项 [${reminderId}]`,
        '',
        `${projectionNote}当前运行环境中有一条带有 meta 控制更新规则的提醒项。请把它当作状态参考，不要用 update_reminder 直接改写内容。`,
        '',
        `如果你要更新这条提醒项，不能用 update_reminder；请按此处理：${updateInstruction}`,
        deleteInstruction,
        '',
        '---',
        content,
      ].join('\n');
    }
    if (isContinuationPackageReminder) {
      return [
        `${systemPrefix} 提醒项 [${reminderId}]（换程接续信息）`,
        '',
        `${projectionNote}你设置了换程接续提醒项，让运行时系统在新一程提醒你恢复工作。请把它当作快速恢复工作的接续包，不要自动当成当前必须立刻执行的新指令。`,
        '',
        '你应优先保留下一步行动、关键定位、运行/验证信息、容易丢的临时细节；不要重复差遣牒已覆盖的内容。进入新一程后，你的第一步是以清醒头脑重新审视并整理更新：删除冗余、纠正偏激/失真思路、压缩成高质量提醒项。若目前只是粗略过桥笔记，进入新一程后必须尽快收敛。',
        '',
        `如果你要更新这份接续包，可执行：update_reminder({ "reminder_id": "${reminderId}", "content": "..." })`,
        deleteInstruction,
        '',
        '---',
        content,
      ].join('\n');
    }
    return [
      `${systemPrefix} 提醒项 [${reminderId}]${scope === 'personal' ? '（个人范围）' : ''}`,
      '',
      scope === 'personal'
        ? `${projectionNote}你设置了个人范围提醒项，让运行时系统在所有由你主理的后续对话里提醒你。请把它当作你的工作集提示，不要自动当成系统下发的下一步动作。`
        : `${projectionNote}你设置了提醒项，让运行时系统提醒你。请把它当作用来保留当前对话里容易丢的工作信息的工作集提示，不要自动当成系统下发的下一步动作。`,
      '',
      scope === 'personal'
        ? '你应保持简洁、及时更新；不再需要时就删除。若它只对当前对话有效，应改写成 dialog 范围提醒而不是长期堆在个人范围里。'
        : '你应保持简洁、及时更新；不再需要时就删除。若后续准备换程，也可以把它整理成接续包。',
      '',
      `如果你要更新这条提醒项，可执行：update_reminder({ "reminder_id": "${reminderId}", "content": "..." })`,
      deleteInstruction,
      '',
      '---',
      content,
    ].join('\n');
  }

  if (managementTool) {
    const updateInstructionSafe = updateInstruction ?? `${managementTool}({ ... })`;
    return `${systemPrefix} REMINDER [${reminderId}] (TOOL STATE)

${enProjectionPrefix}The current runtime environment has a tool-managed state reminder from ${managementTool}. Treat it as environment/tool state, not as your self-authored work note.

By default, do not explicitly acknowledge, restate, or summarize it in your outward reply; only extract the parts that materially change your current judgment, plan, or risk.

This reminder is managed by tool ${managementTool}; if you need to change it, use ${managementTool} instead of update_reminder.

If you need to update this reminder, run: ${updateInstructionSafe}
${deleteInstruction}
---
${content}`;
  }
  if (updateInstruction) {
    return `${systemPrefix} REMINDER [${reminderId}]

${enProjectionPrefix}The current runtime environment has a reminder with a meta-controlled update path. Treat it as state/reference, and do not rewrite it directly with update_reminder.

If you need to update this reminder, do not use update_reminder; follow instead: ${updateInstruction}
${deleteInstruction}
---
${content}`;
  }
  if (isContinuationPackageReminder) {
    return `${systemPrefix} REMINDER [${reminderId}] (CONTINUATION PACKAGE)

${enProjectionPrefix}You set a continuation reminder so the runtime system can remind you when work resumes in a new course. Treat it as resume information for the next course, not as an automatic must-do command.

Keep the next step, key pointers, run/verify info, and easy-to-lose volatile details here. Do not duplicate Taskdoc content. In the new course, your first step is to review and rewrite this with a clear head: remove redundancy, correct biased or distorted bridge notes, and compress it into a high-quality reminder. If this is only a rough bridge note, reconcile it early in the new course.

If you need to update this package, run: update_reminder({ "reminder_id": "${reminderId}", "content": "..." })
${deleteInstruction}
---
${content}`;
  }
  return `${systemPrefix} REMINDER [${reminderId}]${scope === 'personal' ? ' (PERSONAL SCOPE)' : ''}

${
  scope === 'personal'
    ? `${enProjectionPrefix}You set a personal-scope reminder so the runtime system can remind you in every later dialog you lead. Treat it as your workset reference, not as an automatically assigned next action.`
    : `${enProjectionPrefix}You set a reminder so the runtime system can remind you. Treat it as your workset reference for easy-to-lose work details in the current dialog, not as an automatically assigned next action.`
}

${
  scope === 'personal'
    ? 'Keep it concise, refresh it when needed, and delete it when obsolete. If it is only useful for the current dialog, rewrite it into dialog scope instead of letting personal scope accumulate noise.'
    : 'Keep it concise, refresh it when needed, and delete it when obsolete. If you are preparing a new course, you can also rewrite it into a continuation package.'
}

If you need to update this reminder, run: update_reminder({ "reminder_id": "${reminderId}", "content": "..." })
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

export type ContextHealthV3RemediationDialogScope = 'mainDialog' | 'sideDialog';
export type ContextHealthV3RemediationGuideArgs =
  | { kind: 'caution'; mode: 'soft'; dialogScope: ContextHealthV3RemediationDialogScope }
  | {
      kind: 'critical';
      mode: 'countdown';
      dialogScope: ContextHealthV3RemediationDialogScope;
      promptsRemainingAfterThis: number;
      promptsTotal: number;
    };
export function formatAgentFacingContextHealthV3RemediationGuide(
  language: LanguageCode,
  args: ContextHealthV3RemediationGuideArgs,
): string {
  const isSideDialog = args.dialogScope === 'sideDialog';
  if (language === 'zh') {
    if (args.kind === 'caution' && args.mode === 'soft') {
      if (isSideDialog) {
        return [
          `${formatSystemNoticePrefix(language)} 上下文状态：🟡 吃紧`,
          '',
          '这是一条运行时处置指令，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的处置动作。',
          '',
          '影响：对话历史中的工具调用/结果信息很多已经过时，成为你的思考负担。',
          '',
          '行动：你当前处于支线对话。本程不要维护差遣牒，也不要整理差遣牒更新提案；当前目标是维护足够详尽的接续包提醒项，然后主动 clear_mind 开启新一程继续工作。',
          '',
          '提醒项应覆盖：当前对话历史中下一程需要知道的讨论细节、下一步行动、关键定位信息、运行/验证信息、临时路径/ID/样例输入，以及任何恢复工作容易丢的判断依据。提醒项长度没有技术限制，宁可完整一些；允许写成多条粗略提醒项，不必在当前程强行压成单条。',
          '',
          '当前已处于吃紧处置阶段：不要继续扩张上下文，也不要提前进入“按接续包做清醒复核”的模式；真正清理冗余、合并提醒项，放到系统开启新一程后再做。',
          '',
          '操作：',
          '- 优先新增详尽接续包提醒项：add_reminder({ "content": "..." })',
          '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
        ].join('\n');
      }

      return [
        `${formatSystemNoticePrefix(language)} 上下文状态：🟡 吃紧`,
        '',
        '这是一条运行时处置指令，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的处置动作。',
        '',
        '影响：对话历史中的工具调用/结果信息很多已经过时，成为你的思考负担。',
        '',
        '行动：你当前处于主线对话。先把当前对话历史中尚未落实到文档、且下一程需要知会的讨论细节落到差遣牒合适章节。然后再把差遣牒仍未覆盖、但恢复工作会丢的信息记进新提醒项过桥（下一步行动 + 关键定位信息 + 运行/验证信息 + 容易丢的临时细节）；允许先带着一定冗余，也允许先写成多条粗略提醒项，不必在当前程强行压成单条。',
        '',
        '当前已处于吃紧处置阶段：不要继续扩张上下文，也不要提前进入“按接续包做清醒复核”的模式；那是系统真正开启新一程后的第一步。当前程的目标是先把未落文档的讨论细节补进差遣牒，再把差遣牒仍未覆盖、但恢复工作会丢的信息带过桥；真正清理冗余、合并提醒项，放到新一程再做。然后主动 clear_mind，开启新一程对话继续工作。',
        '',
        '操作：',
        '- 优先新增差遣牒章节保存讨论细节：do_mind({ "category": "<category>", "selector": "<selector>", "content": "..." })',
        '- 只有在确实需要改写已有章节、且已对照当前差遣牒内容完成合并时，才更新：change_mind({ ... })',
        '- 优先新增过桥提醒项：add_reminder({ "content": "..." })',
        '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
      ].join('\n');
    }

    if (isSideDialog) {
      return [
        `${formatSystemNoticePrefix(language)} 上下文状态：🔴 告急`,
        '',
        '这是一条运行时处置指令，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的处置动作。',
        '',
        `系统最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动清理头脑开启新一程对话。`,
        '',
        '行动：你当前处于支线对话。本程不要维护差遣牒，也不要整理差遣牒更新提案；当前目标是尽快维护足够详尽的接续包提醒项，然后 clear_mind。',
        '',
        '提醒项应覆盖：当前对话历史中下一程需要知道的讨论细节、下一步行动、关键定位信息、运行/验证信息、临时路径/ID/样例输入，以及任何恢复工作容易丢的判断依据。提醒项长度没有技术限制，宁可完整一些；允许写成多条粗略提醒项，甚至带一定冗余也可以，不必在当前程强行整理干净。',
        '',
        '操作：',
        '- 优先新增详尽接续包提醒项：add_reminder({ "content": "..." })',
        '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
        '- clear_mind({})',
        '',
        '当前处于告急处置阶段时，不要提前做“新一程清醒复核”；系统真正开启新一程后，第一步才是重新审视并整理：删除冗余、纠正偏激/失真思路、合并并压缩成高质量提醒项。',
      ].join('\n');
    }

    return [
      `${formatSystemNoticePrefix(language)} 上下文状态：🔴 告急`,
      '',
      '这是一条运行时处置指令，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的处置动作。',
      '',
      `系统最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动清理头脑开启新一程对话。`,
      '',
      '行动：你当前处于主线对话。尽快保住易丢信息，然后 clear_mind。当前处于告急处置阶段时，先把当前对话历史中尚未落实到文档、且下一程需要知会的讨论细节落到差遣牒合适章节。然后再把差遣牒仍未覆盖、但恢复工作会丢的信息新增提醒项带过桥；允许先保留多条粗略提醒项，甚至带一定冗余也可以，不必在当前程强行整理干净。',
      '',
      '操作：',
      '- 优先新增差遣牒章节保存讨论细节：do_mind({ "category": "<category>", "selector": "<selector>", "content": "..." })',
      '- 只有在确实需要改写已有章节、且已对照当前差遣牒内容完成合并时，才更新：change_mind({ ... })',
      '- 优先新增过桥提醒项：add_reminder({ "content": "..." })',
      '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
      '- clear_mind({})',
      '',
      '接续包要点：下一步行动 + 关键定位信息 + 运行验证方式 + 容易丢的临时细节；不要重复差遣牒已有内容，本程刚落入差遣牒的讨论细节只需提示下一程先查差遣牒。当前处于告急处置阶段时，不要提前做“新一程清醒复核”；系统真正开启新一程后，第一步才是重新审视并整理：删除冗余、纠正偏激/失真思路、合并并压缩成高质量提醒项。',
    ].join('\n');
  }

  if (args.kind === 'caution' && args.mode === 'soft') {
    if (isSideDialog) {
      return [
        `${formatSystemNoticePrefix(language)} Context state: 🟡 caution`,
        '',
        'This is a runtime remediation instruction, not a new user request; do not reply with a standalone "acknowledged/ok/I will organize reminders first", and instead perform the remediation actions directly.',
        '',
        'Impact: stale call/results in dialog history are creating cognitive noise.',
        '',
        'Action: you are in a Side Dialog. Do not maintain Taskdoc in this course, and do not draft Taskdoc update proposals. The current goal is to maintain sufficiently detailed continuation-package reminders, then proactively clear_mind to start a new dialog course.',
        '',
        'Reminders should cover: discussion details from current dialog history that the next course needs to know, next actions, key pointers, run/verify info, volatile paths/IDs/sample inputs, and any reasoning needed to resume safely. Reminder length has no technical limit, so prefer being complete; rough multi-reminder carry-over is acceptable, and you do not need to force everything into one clean reminder in the current course.',
        '',
        'You are already in caution remediation for the current course, so do not keep expanding context and do not switch early into “clear-headed continuation-package review” mode; reminder cleanup and dedup belong to the new course.',
        '',
        'Operations:',
        '- Prefer adding a detailed continuation-package reminder first: add_reminder({ "content": "..." })',
        '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
      ].join('\n');
    }

    return [
      `${formatSystemNoticePrefix(language)} Context state: 🟡 caution`,
      '',
      'This is a runtime remediation instruction, not a new user request; do not reply with a standalone "acknowledged/ok/I will organize reminders first", and instead perform the remediation actions directly.',
      '',
      'Impact: stale call/results in dialog history are creating cognitive noise.',
      '',
      'Action: you are in the Main Dialog. First record current-dialog discussion details that are not yet documented but the next course needs to know into the appropriate Taskdoc sections. Then write information still not covered by Taskdoc but easy to lose into new bridge reminders (next step + key pointers + run/verify info + easy-to-lose volatile details). Some redundancy is acceptable, and rough multi-reminder carry-over is acceptable too; do not force everything into one clean reminder in the current course.',
      '',
      'You are already in caution remediation for the current course, so do not keep expanding context and do not switch early into “clear-headed continuation-package review” mode; that is the first step only after the system actually starts the new course. In the current course, the goal is to first fill Taskdoc with undocumented discussion details, then carry forward details still not covered by Taskdoc; reminder cleanup and dedup belong to the new course. Then proactively clear_mind to start a new dialog course.',
      '',
      'Operations:',
      '- Prefer creating a new Taskdoc section for discussion details: do_mind({ "category": "<category>", "selector": "<selector>", "content": "..." })',
      '- Only update when an existing section truly needs rewriting and you have merged against the current Taskdoc content: change_mind({ ... })',
      '- Prefer adding a bridge reminder first: add_reminder({ "content": "..." })',
      '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
    ].join('\n');
  }

  if (isSideDialog) {
    return [
      `${formatSystemNoticePrefix(language)} Context state: 🔴 critical`,
      '',
      'This is a runtime remediation instruction, not a new user request; do not reply with a standalone "acknowledged/ok/I will organize reminders first", and instead perform the remediation actions directly.',
      '',
      `System will remind you ${args.promptsRemainingAfterThis} more time(s), then automatically clear mind.`,
      '',
      'Action: you are in a Side Dialog. Do not maintain Taskdoc in this course, and do not draft Taskdoc update proposals. The current goal is to maintain sufficiently detailed continuation-package reminders as soon as possible, then clear_mind.',
      '',
      'Reminders should cover: discussion details from current dialog history that the next course needs to know, next actions, key pointers, run/verify info, volatile paths/IDs/sample inputs, and any reasoning needed to resume safely. Reminder length has no technical limit, so prefer being complete; multiple rough reminders, including some redundancy, are acceptable as a bridge.',
      '',
      'Operations:',
      '- Prefer adding a detailed continuation-package reminder first: add_reminder({ "content": "..." })',
      '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
      '- clear_mind({})',
      '',
      'During critical remediation in the current course, do not start the new-course cleanup early; once the system actually starts the new course, the first step is to reconcile rough bridge reminders by removing redundancy, correcting biased or distorted bridge notes, and merging/compressing them into high-quality reminders.',
    ].join('\n');
  }

  return [
    `${formatSystemNoticePrefix(language)} Context state: 🔴 critical`,
    '',
    'This is a runtime remediation instruction, not a new user request; do not reply with a standalone "acknowledged/ok/I will organize reminders first", and instead perform the remediation actions directly.',
    '',
    `System will remind you ${args.promptsRemainingAfterThis} more time(s), then automatically clear mind.`,
    '',
    'Action: you are in the Main Dialog. Preserve easy-to-lose information, then clear_mind. In critical remediation, first record current-dialog discussion details that are not yet documented but the next course needs to know into the appropriate Taskdoc sections. Then add bridge reminders for information still not covered by Taskdoc but easy to lose. Multiple rough reminders, including some redundancy, are acceptable as a bridge; do not spend the current course forcing them into a clean final package.',
    '',
    'Operations:',
    '- Prefer creating a new Taskdoc section for discussion details: do_mind({ "category": "<category>", "selector": "<selector>", "content": "..." })',
    '- Only update when an existing section truly needs rewriting and you have merged against the current Taskdoc content: change_mind({ ... })',
    '- Prefer adding a bridge reminder first: add_reminder({ "content": "..." })',
    '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
    '- clear_mind({})',
    '',
    'Continuation package: next step + key pointers + run/verify info + easy-to-lose volatile details. Do not duplicate Taskdoc content; for discussion details just written into Taskdoc in this course, only remind the next course to review Taskdoc first. During critical remediation in the current course, do not start the new-course cleanup early; once the system actually starts the new course, the first step is to reconcile rough bridge reminders by removing redundancy, correcting biased or distorted bridge notes, and merging/compressing them into high-quality reminders.',
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
      ? 'Detected a tellask-special invocation attempt inside an FBR Side Dialog.'
      : kind === 'tool'
        ? 'Detected a function tool call attempt inside an FBR Side Dialog.'
        : kind === 'tellask_and_tool'
          ? 'Detected both tellask-special and tool-call attempts inside an FBR Side Dialog.'
          : 'Internal error: cannot safely drive the FBR Side Dialog.';

  return [
    'ERR_FBR_TOOLLESS_VIOLATION',
    `Dominds note: this is a tool-less FBR Side Dialog (triggered by \`freshBootsReasoning\`). ${detail}`,
    '',
    '- No tools are available: do not emit function tool calls.',
    '- No tellask-special functions are allowed (`tellaskBack` / `tellask` / `tellaskSessionless` / `askHuman`).',
    '- Provide pure reasoning and a summary grounded in the tellask body (and this Side Dialog’s own tellaskSession history, if any).',
  ].join('\n');
}
