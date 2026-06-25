import { formatLanguageName, type LanguageCode } from '@longrun-ai/kernel/types/language';

export function formatSystemNoticePrefix(language: LanguageCode): string {
  return language === 'zh' ? '【系统提示】' : '[System notice]';
}

export function isAgentFacingCriticalUserInterjectionRemediationGuideContent(
  content: string,
): boolean {
  return (
    content.startsWith(`${formatSystemNoticePrefix('zh')} 上下文状态：🔴 告急；收到用户插话`) ||
    content.startsWith(
      `${formatSystemNoticePrefix('en')} Context state: 🔴 critical; user interjection received`,
    )
  );
}

export function formatAutoMaintainedReminderManualMirrorBan(language: LanguageCode): string {
  return language === 'zh'
    ? '这条状态由系统维护；禁止把它抄进、改写进、或同步维护到你手工创建的提醒项里。'
    : 'This state is system-maintained; do not copy, rewrite, or separately maintain it in manual reminders.';
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
      '刚才那轮诉请已被你后续发出的新要求取代；Dominds 已登记这次更新。',
      '如果目标支线正忙，更新会在下一次安全推进边界进入目标支线；请把目标支线里的更新气泡作为可见确认点。',
    ].join('\n');
  }
  return [
    prefix,
    'That earlier request has been superseded by your later updated request; Dominds has registered the update.',
    'If the target Side Dialog is busy, the update will enter it at the next safe drive boundary. Use the target Side Dialog update bubble as the visible confirmation point.',
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
  // Business scenario: after clear_mind or critical auto-clear, the model is in a fresh course
  // but still sees a Dominds-inserted notice as the latest "user" message. If the copy sounds
  // like an implementation command ("runtime instruction"), models tend to acknowledge it or churn
  // reminders as a task. Say the user-visible business state instead: Dominds started a new course,
  // this is not a user request, first reconcile bridge reminders only if needed, then resume work.
  if (language === 'zh') {
    const prefix =
      args.source === 'clear_mind'
        ? `你刚清理头脑，开启了第 ${args.nextCourse} 程对话。`
        : `Dominds 因上下文已告急而自动开启了第 ${args.nextCourse} 程对话。`;
    return (
      `${noticePrefix} ${prefix} ` +
      '这是 Dominds 的换程提示，不是新的用户诉求；不要把这条提示当成新的待办，也不要只回复“收到/好的/我会先整理提醒项”。' +
      '现在已经进入新一程：如果见到上一程的上下文吃紧/告急状况记录，此时既已消除。第一步先看固定“本路主线目标”提醒（若当前是主线），或读取当前对话范围（scope=dialog）的支线接续包提醒项（若当前是支线），按其中写明的目标恢复当前这一路对话，不要仅凭同一差遣牒里的其它主线或支线内容改道。' +
      '随后复核并在必要时整理接续包提醒项，以清醒头脑删除冗余、纠正偏激或失真的过桥思路、压缩成高质量提醒项；若提醒项已经足够清晰，就不要为了整理而整理。' +
      '完成这一步后，直接按照固定主线目标提醒或支线接续包提醒项里的目标继续推进；除非任务自然需要对用户交付结果，否则不要为这条提示单独回复。'
    );
  }

  const prefix =
    args.source === 'clear_mind'
      ? `This is dialog course #${args.nextCourse}. You just cleared your mind.`
      : `Dominds auto-started dialog course #${args.nextCourse} because context was critical.`;
  return (
    `${noticePrefix} ${prefix} ` +
    'This is a Dominds course-transition notice, not a new user request; do not treat it as a new to-do, and do not reply with a standalone "acknowledged/ok/I will reorganize the reminders first". ' +
    'You are now in a new course: if you see records that the previous course was context-tight or context-critical, that condition is now resolved. First read the fixed Main Dialog goal reminder when this is a Main Dialog, or the current-dialog scoped (scope=dialog) Side Dialog continuation-package reminders when this is a Side Dialog, and resume this specific dialog from that goal instead of drifting into other Main/Side Dialog work that shares the same Taskdoc. ' +
    'Then review and, if needed, rewrite any continuation-package reminders with a clear head, remove redundancy, correct biased or distorted bridge notes, and compress them into high-quality reminders; if the reminders are already clear enough, do not churn on them. ' +
    'After that, continue directly from the fixed Main Dialog goal reminder or the Side Dialog continuation-package goal; unless the task naturally calls for a user-facing delivery, do not send a standalone reply just for this notice.'
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
      `${noticePrefix} 这是 Dominds 的自动续推提示，不是新的用户诉求。`,
      '不要把这条提示当成新的待办，也不要只回复“收到/好的/我先想想/我会先整理一下”。',
      '请直接按下面的引导继续推进任务；若形成结论，必须尽快落地为实际动作，不要停在“只汇报决定/只确认收到”。',
      '',
      '---',
      '',
      trimmed,
    ].join('\n');
  }

  return [
    `${noticePrefix} This is a Dominds auto-continue notice, not a new user request.`,
    'Do not treat this notice as a new to-do, and do not reply with a standalone "acknowledged/ok/I will think first/I will organize things first".',
    'Follow the guidance below and continue the task directly; if you reach a conclusion, turn it into concrete action promptly instead of stopping at a decision report or acknowledgement.',
    '',
    '---',
    '',
    trimmed,
  ].join('\n');
}

export function formatReminderContextGuide(language: LanguageCode): string {
  // Business scenario: reminder records are injected near ordinary dialog messages so the model
  // can keep useful state, but the UI shows them outside the chat transcript. The copy must make
  // that product fact plain without exposing provider/role plumbing: reminders are current-work
  // references, not new user requests, and they should not trigger standalone acknowledgements.
  if (language === 'zh') {
    return [
      `${formatSystemNoticePrefix(language)} 提醒项上下文块开始`,
      'Dominds 是你当前所在的自主运行环境；它会把运行中需要你看到的提醒、提示和状态放进上下文。',
      '以下是 Dominds 为你放到当前上下文里的可见提醒项。它们不是用户的新诉求/指令，也不是聊天正文。',
      '在 WebUI 中，用户通过独立的 Reminder 小组件/面板项看到这些提醒，并能把它们和聊天正文区分开。',
      '请把提醒项作为手头工作/状态参考；只有实际改变你的判断、计划或风险的信息，才需要提炼进后续有实质内容的对外回复。不要为了提醒项单独回复“收到/已了解/静默吸收”。',
    ].join('\n');
  }

  return [
    `${formatSystemNoticePrefix(language)} Reminder context block begins`,
    'Dominds is the autonomous runtime environment you are currently working in; it places needed reminders, notices, and state into your context.',
    'The following visible reminders were added to the current context by Dominds. They are not new user requests/instructions, and not chat transcript text.',
    'In the WebUI, the user sees these reminders through a separate Reminder widget/panel item and can distinguish them from the chat transcript.',
    'Use reminders as current-work/state references; only carry information into a later substantive outward reply when it materially changes your current judgment, plan, or risk. Do not send a standalone "acknowledged/noted/silently absorbed" reply for reminder items.',
  ].join('\n');
}

function formatReminderItemProjectionNote(language: LanguageCode): string {
  return language === 'zh' ? 'Dominds 提醒项说明：' : 'Dominds reminder note:';
}

export type ReminderContextFollowingMessage =
  | Readonly<{ kind: 'user_message' }>
  | Readonly<{ kind: 'human_answer' }>
  | Readonly<{ kind: 'runtime_notice' }>
  | Readonly<{ kind: 'none' }>;

export type ReminderContextHealth =
  | Readonly<{ kind: 'normal' }>
  | Readonly<{ kind: 'caution' }>
  | Readonly<{ kind: 'critical' }>;

export type ReminderContextDialogScope =
  | Readonly<{ kind: 'main_dialog' }>
  | Readonly<{ kind: 'side_dialog' }>;

export type ReminderContextBusiness =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'active_reply_obligation' }>
  | Readonly<{ kind: 'pending_user_interjection' }>
  | Readonly<{ kind: 'pending_user_interjection_with_active_reply' }>
  | Readonly<{ kind: 'user_followup_after_completed_handoff' }>;

// Keep these as separate axes instead of a handful of booleans because the footer is
// LLM-facing copy, not an internal debug dump. Each axis answers one question the model should
// not have to infer from nearby transcript:
// - followingMessage: what kind of message, if any, appears immediately after this reminder block;
// - contextHealth: whether old reminder content must yield to course-transition remediation;
// - dialogScope: whether this is a Main Dialog or Side Dialog;
// - business: whether there is an unfinished handoff, an unanswered user interjection, or a
//   completed handoff followed by a user follow-up.
//
// dialogScope must be programmatically supplied by runtime. In the reminder-only continuation
// case, Main Dialogs and Side Dialogs have different valid clarification paths: Main Dialogs can
// ask the human directly when needed, while Side Dialogs should first ask their requester via
// tellaskBack when the missing piece belongs to the requester. Leaving "if you are in a Side
// Dialog" in the model-facing footer makes the model infer a fact the runtime already knows, and
// that ambiguity has caused reminder-churn / wrong Q4H routing.
//
// The completed-handoff follow-up case exists because a finished sideline handoff can still
// leave reminder-maintenance references visible. If the footer only says "this is reminder
// context" or "continue autonomously", the model may keep adding/deleting reminders even though
// the old handoff has already been reported back and the user is simply talking again. Runtime
// must classify that case precisely here and say it plainly in the footer. The same business
// state can appear with followingMessage=user_message on the first turn and with
// followingMessage=none on a later tool-followup turn; both should keep the same "talk with the
// user normally" expectation.
export type ReminderContextFooterState = Readonly<{
  followingMessage: ReminderContextFollowingMessage;
  contextHealth: ReminderContextHealth;
  dialogScope: ReminderContextDialogScope;
  business: ReminderContextBusiness;
}>;

function formatZhReminderBusinessTail(business: ReminderContextBusiness): string {
  switch (business.kind) {
    case 'none':
      return '';
    case 'user_followup_after_completed_handoff':
      // Runtime has already identified a real user message after the earlier handoff was
      // reported back as complete. This is not an active reply-obligation state anymore: the
      // model should simply communicate with the user according to the current message.
      //
      // Business reason for this exact footer: a completed Sideline Dialog often still carries
      // reminder/status text from the long-line handoff. When a user later asks "what happened?"
      // or gives a new instruction in that same dialog, the model may see those reminders and
      // keep advancing the old handoff instead of answering the visible user. Runtime can tell
      // from durable state that the handoff was already delivered, so the footer must say the
      // business state directly: old handoff done, current message belongs to the user.
      //
      // Keep the wording deliberately neutral about reminders and tools. A user may explicitly
      // ask the agent to reorganize reminders so a later long-running handoff can resume from a
      // corrected state. If this footer said "do not organize reminders" or "only answer", it
      // would block a valid user request and recreate the same kind of over-specific guidance
      // bug in the opposite direction.
      return '现在是用户在追问你。前面那件转交任务已经回报完成了，不需要再推进；请按用户这条消息正常交流和处理。';
    case 'pending_user_interjection':
      // No special handoff state is competing with the user; the shortest useful instruction
      // is simply to answer the still-unanswered user interjection.
      return '当前仍有真实用户插话尚未得到可见回复；先完成对用户插话的回应。';
    case 'pending_user_interjection_with_active_reply':
      // A user interjection is pending while a handoff is still active. The user still gets the
      // next visible answer; reply closure only happens if answering that user message naturally
      // becomes the final handoff delivery.
      return '当前仍有真实用户插话尚未得到可见回复，同时还有回贴任务未完成；先完成对用户插话的回应，只有在这条用户插话本身已经自然到达最终交付时，才进入回贴收口。';
    case 'active_reply_obligation':
      // There is still an unfinished handoff, but no user interjection is pending. Say this is
      // a final-delivery constraint, not a command to abandon necessary current work.
      return '当前仍有回贴任务未完成；它是最终交付要求，不是要求你立刻停止当前必要工作，但到达最终交付时必须按 Dominds 指定方式收口。';
    default: {
      const _exhaustive: never = business;
      throw new Error(`Unhandled zh reminder business state: ${String(_exhaustive)}`);
    }
  }
}

function formatEnReminderBusinessTail(business: ReminderContextBusiness): string {
  switch (business.kind) {
    case 'none':
      return '';
    case 'user_followup_after_completed_handoff':
      // Runtime has already identified a real user message after the earlier handoff was
      // reported back as complete. This is not an active reply-obligation state anymore: the
      // model should simply communicate with the user according to the current message.
      //
      // Business reason for this exact footer: a completed Sideline Dialog often still carries
      // reminder/status text from the long-line handoff. When a user later asks "what happened?"
      // or gives a new instruction in that same dialog, the model may see those reminders and
      // keep advancing the old handoff instead of answering the visible user. Runtime can tell
      // from durable state that the handoff was already delivered, so the footer must say the
      // business state directly: old handoff done, current message belongs to the user.
      //
      // Keep the wording deliberately neutral about reminders and tools. A user may explicitly
      // ask the agent to reorganize reminders so a later long-running handoff can resume from a
      // corrected state. If this footer said "do not organize reminders" or "only answer", it
      // would block a valid user request and recreate the same kind of over-specific guidance
      // bug in the opposite direction.
      return 'The user is asking you a follow-up now. The earlier handed-off task has already been reported back as complete, so there is nothing more to advance there. Talk with the user normally and handle this current message.';
    case 'pending_user_interjection':
      // No special handoff state is competing with the user; the shortest useful instruction
      // is simply to answer the still-unanswered user interjection.
      return "There is still a real user interjection without a visible reply; finish answering the user's interjection first.";
    case 'pending_user_interjection_with_active_reply':
      // A user interjection is pending while a handoff is still active. The user still gets the
      // next visible answer; reply closure only happens if answering that user message naturally
      // becomes the final handoff delivery.
      return "There is still a real user interjection without a visible reply, while a reply task is also unfinished; finish answering the user's interjection first, and enter reply closure only if this user interjection itself naturally reaches final delivery.";
    case 'active_reply_obligation':
      // There is still an unfinished handoff, but no user interjection is pending. Say this is
      // a final-delivery constraint, not a command to abandon necessary current work.
      return 'A reply task is still unfinished; it is a final-delivery requirement, not a demand to stop necessary current work immediately, but final delivery must close through the path Dominds names.';
    default: {
      const _exhaustive: never = business;
      throw new Error(`Unhandled en reminder business state: ${String(_exhaustive)}`);
    }
  }
}

function formatZhReminderContextHealthTail(contextHealth: ReminderContextHealth): string {
  switch (contextHealth.kind) {
    case 'normal':
      return '';
    case 'caution':
      // In tight context, reminders may contain stale next steps that were meant as bridge
      // notes. The model should preserve/prepare course transition instead of expanding the
      // same course by following old reminder content.
      return '当前上下文已吃紧：提醒项正文里的“下一步/接续动作/任务安排”默认都是给下一程以清醒头脑复核后执行的，不是让你在本程继续跑。不要为了执行提醒项里的旧下一步继续扩张上下文；本程最高优先级是按上下文吃紧处置要求保全接续信息，并尽快 `clear_mind`。';
    case 'critical':
      // Critical context is stricter than caution: do not do ordinary work from reminders;
      // preserve what matters and clear the course immediately.
      return '当前上下文已告急：提醒项正文里的“下一步/接续动作/任务安排”默认都是给下一程以清醒头脑复核后执行的，不是让你在本程继续跑。不要执行提醒项里的旧下一步、旧诉请或旧工具重试；本程最高优先级是按上下文告急处置要求保全接续信息，并立即 `clear_mind`。';
    default: {
      const _exhaustive: never = contextHealth;
      throw new Error(`Unhandled zh reminder context health state: ${String(_exhaustive)}`);
    }
  }
}

function formatEnReminderContextHealthTail(contextHealth: ReminderContextHealth): string {
  switch (contextHealth.kind) {
    case 'normal':
      return '';
    case 'caution':
      // In tight context, reminders may contain stale next steps that were meant as bridge
      // notes. The model should preserve/prepare course transition instead of expanding the
      // same course by following old reminder content.
      return 'Context is tight: any "next step", continuation action, or task plan inside reminders is meant for the next course to review and run with a clear head, not for this course to keep executing. Do not expand context by performing old next steps from reminders; this course must first preserve the continuation details required by the tight-context guidance, then call `clear_mind` soon.';
    case 'critical':
      // Critical context is stricter than caution: do not do ordinary work from reminders;
      // preserve what matters and clear the course immediately.
      return 'Context is critical: any "next step", continuation action, or task plan inside reminders is meant for the next course to review and run with a clear head, not for this course to keep executing. Do not perform old next steps, old handed-off requests, or old tool retries from reminders; this course must first preserve the continuation details required by the critical-context guidance, then call `clear_mind` immediately.';
    default: {
      const _exhaustive: never = contextHealth;
      throw new Error(`Unhandled en reminder context health state: ${String(_exhaustive)}`);
    }
  }
}

function joinReminderFooterTails(language: LanguageCode, tails: readonly string[]): string {
  const nonEmptyTails = tails.filter((tail) => tail !== '');
  if (nonEmptyTails.length === 0) return '';
  return language === 'zh' ? nonEmptyTails.join('') : nonEmptyTails.join(' ');
}

function formatZhNormalAutoContinueByDialogScope(scope: ReminderContextDialogScope): string {
  switch (scope.kind) {
    case 'main_dialog':
      // Main Dialogs own the broad task and do not have a requester to tellaskBack. Business
      // scenario: this is a tool-followup turn with no new user/runtime message, and stale
      // reminders can distort the model's next-step choice. Tell the model to first reconcile
      // reminders that affect the current judgment, then proceed from the corrected task state.
      // This is deliberately positive wording: users may ask the agent to fix reminders, and a
      // stale reminder should be corrected instead of preserved by a blanket "do not maintain
      // reminders" warning.
      return '当前是主线对话。先校对会影响当前判断的提醒项：如果某条提醒项已经过时、失真、互相冲突或会误导当前行动，就先修正或删除；其余提醒项只作为背景参考。然后按校正后的真实任务状态行动：已有明确、相关且有价值的任务动作就继续执行；确实缺少人类本人澄清、裁决、验收口径、授权或输入时，用 `askHuman({ tellaskContent })` 提出一个最小且可回答的问题；如果既不缺这些信息、也没有真实任务动作，就交给 Dominds 按主线安排处理，鞭策开启时会继续续推，鞭策关闭且没有真实动作时可以自然收住。';
    case 'side_dialog':
      // Side Dialogs are answering a requester. Business scenario: in a reminder-only
      // tool-followup turn, runtime already knows this is a Sideline Dialog, so the model should
      // not infer whether askHuman or tellaskBack is appropriate. First reconcile reminders that
      // could mislead the current answer; then ask the requester before the human whenever the
      // requester can supply the missing requirement/decision/criteria/input.
      return '当前是支线对话。先校对会影响当前判断的提醒项：如果某条提醒项已经过时、失真、互相冲突或会误导当前行动，就先修正或删除；其余提醒项只作为背景参考。然后按校正后的真实任务状态行动：已有明确、相关且有价值的任务动作就继续执行；若缺少需求澄清、业务裁决、验收口径、授权或输入，先判断缺的东西该由谁补：如果诉请者能补需求澄清、业务裁决、验收口径或缺失输入，先按当前工具规则考虑 `tellaskBack({ tellaskContent })` 回问诉请者；只有确实需要人类本人澄清、决策、授权或输入时，才用 `askHuman({ tellaskContent })` 提出一个最小且可回答的问题；如果既不缺这些信息、也没有真实任务动作，就交给 Dominds 按支线安排处理：需要回贴时会收到回贴提醒，已完成且无新诉求时可以自然收住。';
    default: {
      const _exhaustive: never = scope;
      throw new Error(`Unhandled zh reminder dialog scope: ${String(_exhaustive)}`);
    }
  }
}

function formatEnNormalAutoContinueByDialogScope(scope: ReminderContextDialogScope): string {
  switch (scope.kind) {
    case 'main_dialog':
      // Main Dialogs own the broad task and do not have a requester to tellaskBack. Business
      // scenario: this is a tool-followup turn with no new user/runtime message, and stale
      // reminders can distort the model's next-step choice. Tell the model to first reconcile
      // reminders that affect the current judgment, then proceed from the corrected task state.
      // This is deliberately positive wording: users may ask the agent to fix reminders, and a
      // stale reminder should be corrected instead of preserved by a blanket "do not maintain
      // reminders" warning.
      return 'This is a Main Dialog. First check reminders that affect your current judgment: if a reminder is stale, distorted, conflicting, or would mislead the current action, correct or delete it; use the other reminders only as background reference. Then act from the corrected real task state: continue any clear, relevant, valuable task action; use `askHuman({ tellaskContent })` only when you truly need clarification, a decision, acceptance criteria, authorization, or input from the human, and ask one minimal, answerable question; if none of that is needed and there is no real task action, hand control back to Dominds mainline behavior, where diligence can continue it when enabled, and when diligence is disabled with no real action, it may naturally settle.';
    case 'side_dialog':
      // Side Dialogs are answering a requester. Business scenario: in a reminder-only
      // tool-followup turn, runtime already knows this is a Sideline Dialog, so the model should
      // not infer whether askHuman or tellaskBack is appropriate. First reconcile reminders that
      // could mislead the current answer; then ask the requester before the human whenever the
      // requester can supply the missing requirement/decision/criteria/input.
      return 'This is a Side Dialog. First check reminders that affect your current judgment: if a reminder is stale, distorted, conflicting, or would mislead the current action, correct or delete it; use the other reminders only as background reference. Then act from the corrected real task state: continue any clear, relevant, valuable task action. If you are missing clarification, a business decision, acceptance criteria, authorization, or input, first identify who should provide it: when the requester can provide the missing requirement clarification, business decision, acceptance criteria, or missing input, follow the current tool rules and consider `tellaskBack({ tellaskContent })` first; use `askHuman({ tellaskContent })` only when the needed clarification, decision, authorization, or input truly must come from the human. If none of that is needed and there is no real task action, hand control back to Dominds sideline behavior: it can receive reply reminders when a reply is needed, and when it is complete with no new request, it may naturally settle.';
    default: {
      const _exhaustive: never = scope;
      throw new Error(`Unhandled en reminder dialog scope: ${String(_exhaustive)}`);
    }
  }
}

export function formatReminderContextFooter(
  language: LanguageCode,
  state: ReminderContextFooterState,
): string {
  const contextHealthIsNormal = state.contextHealth.kind === 'normal';

  if (language === 'zh') {
    const base = `${formatSystemNoticePrefix(language)} 提醒项上下文块结束。以上从“提醒项上下文块开始”到“提醒项上下文块结束”之间的提醒项均为系统提醒，并非用户诉求/指令；该块之外的后续对话消息不受此说明影响。`;
    const contextHealthTail = formatZhReminderContextHealthTail(state.contextHealth);
    const businessTail = formatZhReminderBusinessTail(state.business);
    const statusTail = joinReminderFooterTails(language, [contextHealthTail, businessTail]);

    switch (state.followingMessage.kind) {
      case 'user_message':
        // The reminder block is inserted immediately before the real user message. This
        // branch prevents the reminder wrapper from lowering or re-labeling that message.
        return (
          `${base}本轮提醒项块之后会紧接一条本轮真实的新用户消息；后续消息是用户的新诉求/指令，不是提醒项投影。` +
          '提醒项块说明到此为止，不得外溢到那条消息：不要把后续用户消息称为“系统提示/没有新消息”，也不要因为本块说明而降低它的指令优先级。' +
          `请按那条用户消息的原始语义继续处理；若它要求更新你的职责、偏好或心智资产，应照常落实；若系统提示上下文吃紧或告急，先按那条系统要求处理，再做普通任务动作。${statusTail}`
        );
      case 'human_answer':
        // This is a human answer to an askHuman question, not a fresh open-ended request. The
        // model should use the answer to resume the waiting work without reclassifying it as a
        // new user instruction.
        return (
          `${base}本轮提醒项块之后会接着出现用户对一个提问的回答；那是用来继续等待中的工作，不是新的普通用户诉求/指令。` +
          `请用那条回答继续原本等待答案的任务，不要把提醒项块说明外溢到那条回答上。${statusTail}`
        );
      case 'runtime_notice':
        // Dominds notices are deliberate driver instructions. Keep them distinct from user
        // requests while allowing their own wording to drive the next action.
        return `${base}本轮提醒项块之后会接着出现一条 Dominds 提示；它不是用户的新诉求/指令，请按其中的要求继续推进。${statusTail}`;
      case 'none':
        if (!contextHealthIsNormal) {
          // When context is tight/critical, the context-preservation notice owns the turn. Do not add
          // ordinary continuation wording that could encourage more work from old reminders.
          return (
            `${base}本轮没有新的用户消息或 Dominds 提示；这是工具调用后的自动续推。` +
            `这里的“没有新消息”只说明本轮没有额外用户消息或 Dominds 提示。${statusTail}`
          );
        }
        // Normal tool-followup rounds may continue real business work, but reminder maintenance
        // paths are merely references. Runtime already knows whether this is a Main Dialog or Side
        // Dialog, so do not ask the model to self-classify before choosing askHuman vs tellaskBack.
        const scopeTail = formatZhNormalAutoContinueByDialogScope(state.dialogScope);
        return (
          `${base}本轮没有新的用户消息或 Dominds 提示；这是工具调用后的自动续推。` +
          scopeTail +
          `这里的“没有新消息”只说明本轮没有额外用户消息或 Dominds 提示。${businessTail}`
        );
      default: {
        const _exhaustive: never = state.followingMessage;
        throw new Error(`Unhandled zh reminder following-message state: ${String(_exhaustive)}`);
      }
    }
  }

  const base =
    `${formatSystemNoticePrefix(language)} Reminder context block ends. The reminder items between ` +
    '"Reminder context block begins" and "Reminder context block ends" are system reminders, ' +
    'not user requests/instructions; this reminder-block guidance does not apply to subsequent dialog messages outside this block. ';
  const contextHealthTail = formatEnReminderContextHealthTail(state.contextHealth);
  const businessTail = formatEnReminderBusinessTail(state.business);
  const statusTail = joinReminderFooterTails(language, [contextHealthTail, businessTail]);

  switch (state.followingMessage.kind) {
    case 'user_message':
      // The reminder block is inserted immediately before the real user message. This branch
      // prevents the reminder wrapper from lowering or re-labeling that message.
      return (
        `${base}A real new user message for this round immediately follows this reminder block; the following message is a new user request/instruction, not a reminder projection. ` +
        'The reminder-block guidance ends here and must not spill over onto that message: do not label the following user message as a "system notice" or "no new message", and do not lower its instruction priority because of this block. ' +
        `Handle that user message according to its original meaning; if it asks you to update your responsibilities, preferences, or mind assets, carry that out normally. If the system says context is tight or critical, follow that system guidance before ordinary task actions. ${statusTail}`
      );
    case 'human_answer':
      // This is a human answer to an askHuman question, not a fresh open-ended request. The
      // model should use the answer to resume the waiting work without reclassifying it as a
      // new user instruction.
      return (
        `${base}A human answer to one of your questions follows this reminder block; it is for resuming the waiting work, not a new ordinary user request/instruction. ` +
        `Use that answer to continue the task that was waiting for it, and do not let the reminder-block guidance spill over onto that answer. ${statusTail}`
      );
    case 'runtime_notice':
      // Dominds notices are deliberate driver instructions. Keep them distinct from user requests
      // while allowing their own wording to drive the next action.
      return `${base}A Dominds notice follows this reminder block in this round; it is not a new user request/instruction, so follow that guidance and continue the work. ${statusTail}`;
    case 'none':
      if (!contextHealthIsNormal) {
        // When context is tight/critical, the context-preservation notice owns the turn. Do not add
        // ordinary continuation wording that could encourage more work from old reminders.
        return (
          `${base}There is no new user message or Dominds notice in this round; this is an automatic continuation after a tool call. ` +
          `Here, "no new message" only means this round has no extra user message or Dominds notice. ${statusTail}`
        );
      }
      // Normal tool-followup rounds may continue real business work, but reminder maintenance
      // paths are merely references. Runtime already knows whether this is a Main Dialog or Side
      // Dialog, so do not ask the model to self-classify before choosing askHuman vs tellaskBack.
      const scopeTail = formatEnNormalAutoContinueByDialogScope(state.dialogScope);
      return (
        `${base}There is no new user message or Dominds notice in this round; this is an automatic continuation after a tool call. ` +
        `${scopeTail} ` +
        `Here, "no new message" only means this round has no extra user message or Dominds notice. ${businessTail}`
      );
    default: {
      const _exhaustive: never = state.followingMessage;
      throw new Error(`Unhandled en reminder following-message state: ${String(_exhaustive)}`);
    }
  }
}

export type ReminderMaintenanceReferenceItem = Readonly<{
  id: string;
  meta?: unknown;
}>;

type ReminderMaintenanceInstructions = Readonly<{
  updateInstruction?: string;
  deleteInstruction: string;
}>;

function isReminderGuideMetaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getReminderMaintenanceInstructions(
  language: LanguageCode,
  reminderId: string,
  meta: unknown,
): ReminderMaintenanceInstructions {
  const metaValue = meta;
  const isPendingTellaskReminder =
    isReminderGuideMetaRecord(metaValue) && metaValue['kind'] === 'pending_tellask';
  const pendingTellaskCount =
    isPendingTellaskReminder && typeof metaValue['pendingCount'] === 'number'
      ? metaValue['pendingCount']
      : undefined;
  const managerValue = isReminderGuideMetaRecord(metaValue) ? metaValue['manager'] : undefined;
  const managementTool =
    isReminderGuideMetaRecord(managerValue) && typeof managerValue['tool'] === 'string'
      ? managerValue['tool'].trim()
      : undefined;

  const updateValue = isReminderGuideMetaRecord(metaValue) ? metaValue['update'] : undefined;
  const updateAltInstruction =
    isReminderGuideMetaRecord(updateValue) && typeof updateValue['altInstruction'] === 'string'
      ? updateValue['altInstruction'].trim()
      : undefined;
  const metaKind = isReminderGuideMetaRecord(metaValue) ? metaValue['kind'] : undefined;
  const serverIdValue = isReminderGuideMetaRecord(metaValue) ? metaValue['serverId'] : undefined;
  const mcpReleaseInstruction =
    typeof serverIdValue === 'string' && serverIdValue.trim() !== ''
      ? `mcp_release({"serverId":"${serverIdValue.trim()}"})`
      : 'mcp_release({"serverId":"<serverId>"})';
  const updateInstruction =
    metaKind === 'mcp_lease'
      ? language === 'zh'
        ? 'MCP lease 状态由系统维护，不用 update_reminder 修改'
        : 'MCP lease state is system-maintained; I do not edit it with update_reminder'
      : updateAltInstruction && updateAltInstruction.length > 0
        ? updateAltInstruction
        : managementTool
          ? `${managementTool}({ ... })`
          : undefined;
  const deleteValue = isReminderGuideMetaRecord(metaValue) ? metaValue['delete'] : undefined;
  const deleteAltInstruction =
    isReminderGuideMetaRecord(deleteValue) && typeof deleteValue['altInstruction'] === 'string'
      ? deleteValue['altInstruction'].trim()
      : undefined;
  const daemonCompleted =
    metaKind === 'daemon' &&
    isReminderGuideMetaRecord(metaValue) &&
    metaValue['completed'] === true;
  const deleteInstruction =
    language === 'zh'
      ? isPendingTellaskReminder && pendingTellaskCount !== undefined && pendingTellaskCount > 0
        ? '删除通道：当前仍有进行中诉请；我不能用 delete_reminder 删除。要改变某一路长线诉请时，我复用同一 sessionSlug 再发 tellask；tellaskSessionless 不能修改或停止旧任务。'
        : deleteAltInstruction
          ? `删除通道：我不用 delete_reminder；我执行：${deleteAltInstruction}`
          : metaKind === 'mcp_lease'
            ? `删除通道：我不用 delete_reminder 释放资源；确认当前对话近期不再需要这个 MCP 连接时，我执行：${mcpReleaseInstruction}`
            : daemonCompleted
              ? `删除通道：确认已知悉 daemon 终态后，可清理：delete_reminder({ "reminder_id": "${reminderId}" })`
              : isPendingTellaskReminder && pendingTellaskCount === 0
                ? `清理噪音时我可删除：delete_reminder({ "reminder_id": "${reminderId}" })`
                : `删除通道：delete_reminder({ "reminder_id": "${reminderId}" })`
      : isPendingTellaskReminder && pendingTellaskCount !== undefined && pendingTellaskCount > 0
        ? 'Delete path: there are still in-flight Tellasks; I cannot delete this reminder with delete_reminder. To change a sessioned tellask, I send another tellask with the same sessionSlug; tellaskSessionless cannot modify or stop an earlier task.'
        : deleteAltInstruction
          ? `Delete path: I do not use delete_reminder; I run: ${deleteAltInstruction}`
          : metaKind === 'mcp_lease'
            ? `Delete path: I do not release resources by deleting the reminder; when this dialog will not need this MCP connection soon, I run: ${mcpReleaseInstruction}`
            : daemonCompleted
              ? `Delete path: after I have acknowledged the daemon terminal state, I may clean up: delete_reminder({ "reminder_id": "${reminderId}" })`
              : isPendingTellaskReminder && pendingTellaskCount === 0
                ? `Noise cleanup delete path: I may run delete_reminder({ "reminder_id": "${reminderId}" })`
                : `Delete path: delete_reminder({ "reminder_id": "${reminderId}" })`;
  return { updateInstruction, deleteInstruction };
}

export function formatReminderMaintenanceReference(
  language: LanguageCode,
  reminders: readonly ReminderMaintenanceReferenceItem[],
): string | undefined {
  const lines: string[] = [];
  for (const reminder of reminders) {
    const { updateInstruction, deleteInstruction } = getReminderMaintenanceInstructions(
      language,
      reminder.id,
      reminder.meta,
    );
    if (language === 'zh') {
      if (updateInstruction) {
        lines.push(
          `- reminder_id=${reminder.id}：我若要更新/调整这条提醒项，参考：${updateInstruction}`,
        );
      } else {
        lines.push(
          `- reminder_id=${reminder.id}：我若要更新/调整这条提醒项，参考：update_reminder({ "reminder_id": "${reminder.id}", "content": "..." })`,
        );
      }
      lines.push(
        `- reminder_id=${reminder.id}：我若要删除/清理这条提醒项，参考：${deleteInstruction}`,
      );
    } else {
      if (updateInstruction) {
        lines.push(
          `- reminder_id=${reminder.id}: if I update/change this reminder, I follow: ${updateInstruction}`,
        );
      } else {
        lines.push(
          `- reminder_id=${reminder.id}: if I update/change this reminder, I follow: update_reminder({ "reminder_id": "${reminder.id}", "content": "..." })`,
        );
      }
      lines.push(
        `- reminder_id=${reminder.id}: if I delete/clean up this reminder, I follow: ${deleteInstruction}`,
      );
    }
  }
  if (lines.length === 0) return undefined;

  // Business scenario: this block exposes exact reminder_id maintenance channels. The footer
  // decides what the model should do next; this note only tells the model how to repair a concrete
  // reminder when the current user message, Dominds notice, or task state makes that repair useful.
  // Keep it positive: stale reminders should be fixed, while accurate reminders remain references.
  if (language === 'zh') {
    return [
      `${formatSystemNoticePrefix(language)} 下面列出这些提醒项可用的修正、更新或删除方式，按 reminder_id 对照使用。处理真实用户消息、Dominds 提示或当前任务时，如果某条提醒项已经过时、失真、重复或会误导当前判断，就用对应方式维护；如果它仍然准确，就把它当作参考继续处理当前场景。`,
      '',
      ...lines,
    ].join('\n');
  }

  return [
    `${formatSystemNoticePrefix(language)} The following are the available ways to correct, update, or delete these reminders; use the matching reminder_id. While handling a real user message, Dominds notice, or current task, if a reminder is stale, distorted, duplicate, or would mislead your current judgment, maintain it through the matching path; if it is still accurate, use it as a reference and continue with the current situation.`,
    '',
    ...lines,
  ].join('\n');
}

export function formatSharedReminderUpdateImpactNotice(
  language: LanguageCode,
  args: {
    reminderId: string;
    scope: 'task' | 'agent' | 'runtime';
    audience: 'updater' | 'peer';
  },
): string {
  const reminderId = args.reminderId;
  const scope = args.scope;
  if (language === 'zh') {
    const scopeName =
      scope === 'task' ? '任务范围' : scope === 'agent' ? '智能体范围' : '运行时范围';
    const impactedDialogs =
      scope === 'task'
        ? '当前进行时存在同一智能体在当前差遣牒任务内的其它并行对话'
        : '当前进行时存在同一智能体的其它并行对话';
    if (args.audience === 'updater') {
      return `共享范围影响：你刚更新的 reminder_id=${reminderId} 是${scopeName}提醒项，不是当前对话私有；${impactedDialogs}，其它能看到这条提醒项的对话也会看到这次更新。请考虑使用 migrate_reminder({ "reminder_id": "${reminderId}", "scope": "dialog" }) 确保提醒项的影响范围合理；若新内容只应影响当前对话，迁移后系统会从共享范围撤下，并保留为仅本对话可见的提醒项。`;
    }
    return [
      `${formatSystemNoticePrefix(language)} 共享范围提醒项已更新`,
      '',
      `reminder_id=${reminderId} 是${scopeName}提醒项，不是当前对话私有；${impactedDialogs}。同一智能体的某个并行对话刚更新了它，你所在对话也会看到这次更新。`,
      '这条共享提醒项这次实际上由另一对话维护；你应自行判断它与本对话当前上下文是否有关，只采纳确实相关的部分。',
      `请把它作为最新共享参考。若这次更新看起来只适合更新者所在对话，不要在本对话替它修正共享内容；可提醒更新者在其对话中使用 migrate_reminder({ "reminder_id": "${reminderId}", "scope": "dialog" }) 迁回对话范围，从而从其它并行对话撤下。本对话若另有私有状态，请另建对话范围提醒项。`,
    ].join('\n');
  }

  const scopeName =
    scope === 'task' ? 'task-scope' : scope === 'agent' ? 'agent-scope' : 'runtime-scope';
  const impactedDialogs =
    scope === 'task'
      ? 'The current in-flight work has other parallel dialogs for the same agent and Taskdoc'
      : 'The current in-flight work has other parallel dialogs for the same agent';
  if (args.audience === 'updater') {
    return `Shared-scope impact: the reminder you just updated, reminder_id=${reminderId}, is ${scopeName}, not private to the current dialog. ${impactedDialogs}, so other dialogs that can see this reminder will see this update too. Consider running migrate_reminder({ "reminder_id": "${reminderId}", "scope": "dialog" }) to make sure the reminder's impact scope is appropriate; if the new content should affect only the current dialog, Dominds will withdraw it from shared scope and keep it visible only in this dialog after migration.`;
  }
  return [
    `${formatSystemNoticePrefix(language)} Shared-scope reminder updated`,
    '',
    `reminder_id=${reminderId} is ${scopeName}, not private to the current dialog. ${impactedDialogs}. Another parallel dialog for the same agent just updated it, so this dialog will see the update too.`,
    'This shared reminder was actually maintained by another dialog this time; decide for yourself whether it is relevant to this dialog context, and use only the parts that are truly relevant.',
    `Use it as the latest shared reference. If this update appears to fit only the updater's dialog, do not correct the shared content from this dialog; you may ask the updater to run migrate_reminder({ "reminder_id": "${reminderId}", "scope": "dialog" }) in that dialog so Dominds withdraws it from other parallel dialogs. If this dialog has its own private state, create a separate dialog-scope reminder here.`,
  ].join('\n');
}

export function formatSharedReminderMigrationImpactNotice(
  language: LanguageCode,
  args: {
    reminderId: string;
    scope: 'task' | 'agent' | 'runtime';
  },
): string {
  const reminderId = args.reminderId;
  const scope = args.scope;
  if (language === 'zh') {
    const scopeName =
      scope === 'task' ? '任务范围' : scope === 'agent' ? '智能体范围' : '运行时范围';
    return [
      `${formatSystemNoticePrefix(language)} 共享范围提醒项已迁回其它对话`,
      '',
      `reminder_id=${reminderId} 原本是${scopeName}提醒项；更新者对话已将它迁回自己的对话范围，因此它不再是你所在对话可见的共享参考。`,
      '若本对话仍需要类似内容，请按本对话当前状态另建对话范围或任务范围提醒项；不要假设迁走后的内容仍适用于这里。',
    ].join('\n');
  }

  const scopeName =
    scope === 'task' ? 'task-scope' : scope === 'agent' ? 'agent-scope' : 'runtime-scope';
  return [
    `${formatSystemNoticePrefix(language)} Shared-scope reminder migrated back to another dialog`,
    '',
    `reminder_id=${reminderId} was ${scopeName}. The updater dialog has moved it back into its own dialog scope, so it is no longer a shared reference visible to this dialog.`,
    'If this dialog still needs similar content, create a dialog-scope or task-scope reminder that matches this dialog now; do not assume the migrated content still applies here.',
  ].join('\n');
}

export function formatReminderItemGuide(
  language: LanguageCode,
  reminderId: string,
  content: string,
  options?: { meta?: unknown; scope?: 'dialog' | 'task' | 'agent' | 'runtime' },
): string {
  // `options.meta` is persisted JSON coming from tools. Runtime shape checks are unavoidable here
  // to keep reminder ownership/management loosely coupled and extensible.
  const metaValue = options && 'meta' in options ? options.meta : undefined;
  const scope = options?.scope;
  const isContinuationPackageReminder =
    isReminderGuideMetaRecord(metaValue) && metaValue['kind'] === 'continuation_package';
  const managerValue = isReminderGuideMetaRecord(metaValue) ? metaValue['manager'] : undefined;
  const managementTool =
    isReminderGuideMetaRecord(managerValue) && typeof managerValue['tool'] === 'string'
      ? managerValue['tool'].trim()
      : undefined;
  const { updateInstruction } = getReminderMaintenanceInstructions(language, reminderId, metaValue);
  const projectionNote = formatReminderItemProjectionNote(language);
  const enProjectionPrefix = `${projectionNote} `;
  const systemPrefix = formatSystemNoticePrefix(language);

  if (language === 'zh') {
    if (managementTool) {
      return [
        `${systemPrefix} 提醒项 [${reminderId}]（工具状态）`,
        '',
        `${projectionNote}当前运行环境中有一条由工具 ${managementTool} 管理的状态提醒项。请把它当作环境/工具状态参考，不要当作你自己写的工作便签。`,
        formatAutoMaintainedReminderManualMirrorBan(language),
        '',
        '默认不要在对外回复里专门确认、复述或总结它；只有它实际改变你的判断、计划或风险时，才提炼真正相关的部分。',
        '',
        '---',
        content,
      ].join('\n');
    }
    if (updateInstruction) {
      return [
        `${systemPrefix} 提醒项 [${reminderId}]`,
        '',
        `${projectionNote}当前运行环境中有一条带有 meta 控制更新规则的提醒项。请把它当作状态参考，具体维护通道以前置维护参考为准。`,
        formatAutoMaintainedReminderManualMirrorBan(language),
        '',
        '---',
        content,
      ].join('\n');
    }
    if (isContinuationPackageReminder) {
      return [
        `${systemPrefix} 提醒项 [${reminderId}]（换程接续信息）`,
        '',
        `${projectionNote}你设置了换程接续提醒项，Dominds 会在新一程提醒你恢复工作。请把它当作快速恢复工作的接续包，不要自动当成当前必须立刻执行的新指令。`,
        '',
        '你应优先保留下一步行动、关键定位、运行/验证信息、容易丢的临时细节；不要重复差遣牒已覆盖的内容。进入新一程后，你的第一步是以清醒头脑重新审视并整理更新：删除冗余、纠正偏激/失真思路、压缩成高质量提醒项。若目前只是粗略过桥笔记，进入新一程后必须尽快收敛。',
        '',
        '---',
        content,
      ].join('\n');
    }
    const scopeLabel =
      scope === 'task' ? '（任务范围）' : scope === 'agent' ? '（智能体范围）' : '';
    const scopeGuide =
      scope === 'task'
        ? `${projectionNote}你设置了任务范围提醒项，Dominds 会在当前差遣牒任务内的相关对话里提醒你。请把它当作当前任务的手头工作提示，不要自动当成系统下发的下一步动作。`
        : scope === 'agent'
          ? `${projectionNote}你设置了智能体范围提醒项，Dominds 会在由你主理的后续对话里提醒你。它只适合紧急、短期、全局刺眼提醒；不要用来记录普通任务状态，也不要自动当成系统下发的下一步动作。`
          : `${projectionNote}你设置了提醒项，Dominds 会在需要时提醒你。请把它当作用来保留当前对话里容易丢的手头工作信息的提示，不要自动当成系统下发的下一步动作。`;
    const scopeMaintenance =
      scope === 'task'
        ? '你应保持简洁、及时更新；不再需要时就删除。若它只对当前对话有效，应改写成对话范围提醒；若需要全队同步当前任务状态，应写入差遣牒 progress，而不是扩大提醒范围。'
        : scope === 'agent'
          ? '你应主动保持极少量、短期、强相关；不再需要时必须删除。普通任务进展不要放在 agent 范围，当前任务内跨对话可见请改用 task 范围。'
          : '你应保持简洁、及时更新；不再需要时就删除。若后续准备换程，也可以把它整理成接续包。';
    return [
      `${systemPrefix} 提醒项 [${reminderId}]${scopeLabel}`,
      '',
      scopeGuide,
      '',
      scopeMaintenance,
      '',
      '---',
      content,
    ].join('\n');
  }

  if (managementTool) {
    return `${systemPrefix} REMINDER [${reminderId}] (TOOL STATE)

${enProjectionPrefix}Dominds currently has a tool-managed state reminder from ${managementTool}. Treat it as environment/tool state, not as your self-authored work note.

${formatAutoMaintainedReminderManualMirrorBan(language)}

By default, do not explicitly acknowledge, restate, or summarize it in your outward reply; only extract the parts that materially change your current judgment, plan, or risk.

---
${content}`;
  }
  if (updateInstruction) {
    return `${systemPrefix} REMINDER [${reminderId}]

${enProjectionPrefix}Dominds currently has a reminder with a managed update path. Treat it as state/reference; use the preceding maintenance reference for its maintenance channel.

${formatAutoMaintainedReminderManualMirrorBan(language)}

---
${content}`;
  }
  if (isContinuationPackageReminder) {
    return `${systemPrefix} REMINDER [${reminderId}] (CONTINUATION PACKAGE)

${enProjectionPrefix}You set a continuation reminder so Dominds can remind you when work resumes in a new course. Treat it as resume information for the next course, not as an automatic must-do command.

Keep the next step, key pointers, run/verify info, and easy-to-lose volatile details here. Do not duplicate Taskdoc content. In the new course, your first step is to review and rewrite this with a clear head: remove redundancy, correct biased or distorted bridge notes, and compress it into a high-quality reminder. If this is only a rough bridge note, reconcile it early in the new course.

---
${content}`;
  }
  const scopeLabel = scope === 'task' ? ' (TASK SCOPE)' : scope === 'agent' ? ' (AGENT SCOPE)' : '';
  const scopeGuide =
    scope === 'task'
      ? `${enProjectionPrefix}You set a task-scope reminder so Dominds can remind you across relevant dialogs for the current Taskdoc. Treat it as a current-work reference for this task, not as an automatically assigned next action.`
      : scope === 'agent'
        ? `${enProjectionPrefix}You set an agent-scope reminder so Dominds can remind you across later dialogs you lead. This is only for urgent, short-lived, globally visible cues; do not use it for ordinary task state, and do not treat it as an automatically assigned next action.`
        : `${enProjectionPrefix}You set a reminder so Dominds can remind you when needed. Treat it as a current-work reference for easy-to-lose details in the current dialog, not as an automatically assigned next action.`;
  const scopeMaintenance =
    scope === 'task'
      ? 'Keep it concise, refresh it when needed, and delete it when obsolete. If it is only useful for the current dialog, rewrite it into dialog scope; if the team must synchronize current task state, update Taskdoc progress instead of broadening reminder scope.'
      : scope === 'agent'
        ? 'Keep this scope rare, short-lived, and strongly relevant; delete it as soon as it is no longer needed. Ordinary task progress does not belong in agent scope; use task scope for current-task cross-dialog visibility.'
        : 'Keep it concise, refresh it when needed, and delete it when obsolete. If you are preparing a new course, you can also rewrite it into a continuation package.';

  return `${systemPrefix} REMINDER [${reminderId}]${scopeLabel}

${scopeGuide}

${scopeMaintenance}

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
  // Business scenario: context-health prompts are inserted because the current course is close
  // to losing useful state. The model should treat them as an immediate preservation workflow,
  // but the old wording ("runtime remediation instruction") was unnecessarily technical and
  // encouraged shallow acknowledgements. Say the business reason plainly: Dominds is protecting
  // context, this is not a new user request, and the listed steps should be performed directly.
  if (language === 'zh') {
    if (args.kind === 'caution' && args.mode === 'soft') {
      if (isSideDialog) {
        return [
          `${formatSystemNoticePrefix(language)} 上下文状态：🟡 吃紧`,
          '',
          '这是 Dominds 为防止上下文丢失插入的保全提示，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的保全动作。',
          '',
          '影响：对话历史中的工具调用/结果信息很多已经过时，成为你的思考负担。',
          '',
          '行动：你当前处于支线对话。本程不要维护差遣牒，也不要整理差遣牒更新提案；当前目标是维护足够详尽的当前对话范围（scope=dialog）接续包提醒项，然后主动 clear_mind 开启新一程继续工作。',
          '',
          '重点提醒：接续包提醒项必须写明当前这一路支线对话的任务目标；同一差遣牒下可能还有同一智能体的其它主线/支线对话，下一程要靠 scope=dialog 提醒项继续本路对话，不能靠共享差遣牒猜目标。',
          '',
          '提醒项应覆盖：当前对话历史中下一程需要知道的任务目标、讨论细节、下一步行动、关键定位信息、运行/验证信息、临时路径/ID/样例输入，以及任何恢复工作容易丢的判断依据。提醒项没有固定长度限制，宁可完整一些；允许写成多条粗略提醒项，不必在当前程强行压成单条。',
          '',
          'Dominds 已提醒当前上下文吃紧：不要继续扩张上下文，也不要提前进入“按接续包做清醒复核”的模式；真正清理冗余、合并提醒项，放到 Dominds 开启新一程后再做。',
          '',
          '操作：',
          '- 优先新增详尽接续包提醒项：add_reminder({ "content": "...", "scope": "dialog" })',
          '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
        ].join('\n');
      }

      return [
        `${formatSystemNoticePrefix(language)} 上下文状态：🟡 吃紧`,
        '',
        '这是 Dominds 为防止上下文丢失插入的保全提示，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的保全动作。',
        '',
        '影响：对话历史中的工具调用/结果信息很多已经过时，成为你的思考负担。',
        '',
        '行动：你当前处于主线对话。先完整读取固定“本路主线目标”提醒：它要求先问人类就立即问，并用 set_dialog_goal 记录答案；它写“依差遣牒推进”但同时提示已有并行对话，也先问人类；只有没有并行确认提示时才按差遣牒继续；已有具体目标就按目标继续。然后只把确实需要同一差遣牒下其它对话/队友知会的讨论事实落到差遣牒合适章节；再把差遣牒仍未覆盖、但恢复本路对话会丢的信息记进 scope=dialog 新提醒项过桥（下一步行动 + 关键定位信息 + 运行/验证信息 + 容易丢的临时细节）；允许先带着一定冗余，也允许先写成多条粗略提醒项，不必在当前程强行压成单条。',
        '',
        'Dominds 已提醒当前上下文吃紧：不要继续扩张上下文，也不要提前进入“按接续包做清醒复核”的模式；那是 Dominds 真正开启新一程后的第一步。当前程的目标是先按固定“本路主线目标”提醒处理目标，再把需要共享的事实补进差遣牒，最后把差遣牒仍未覆盖、但恢复本路对话会丢的信息带过桥；真正清理冗余、合并提醒项，放到新一程再做。然后主动 clear_mind，开启新一程对话继续工作。',
        '',
        '操作：',
        '- 若固定“本路主线目标”提醒要求先问人类：问清后调用 set_dialog_goal({ "mode": "goal", "goal": "..." })',
        '- 优先新增差遣牒章节保存讨论细节：do_mind({ "category": "<category>", "selector": "<selector>", "content": "..." })',
        '- 只有在确实需要改写已有章节、且已对照当前差遣牒内容完成合并时，才先调用 recall_taskdoc({"selector":"<selector>"}) 取得 content_hash，再更新：change_mind({"selector":"<selector>","content":"...","previous_content_hash":"crc32:..."})',
        '- 优先新增当前对话 scope=dialog 过桥提醒项：add_reminder({ "content": "...", "scope": "dialog" })',
        '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
      ].join('\n');
    }

    if (isSideDialog) {
      return [
        `${formatSystemNoticePrefix(language)} 上下文状态：🔴 告急`,
        '',
        '这是 Dominds 为防止上下文丢失插入的保全提示，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的保全动作。',
        '',
        `Dominds 最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动清理头脑开启新一程对话。`,
        '',
        '行动：你当前处于支线对话。本程不要维护差遣牒，也不要整理差遣牒更新提案；当前目标是尽快维护足够详尽的当前对话范围（scope=dialog）接续包提醒项，然后 clear_mind。',
        '',
        '重点提醒：接续包提醒项必须写明当前这一路支线对话的任务目标；同一差遣牒下可能还有同一智能体的其它主线/支线对话，下一程要靠 scope=dialog 提醒项继续本路对话，不能靠共享差遣牒猜目标。',
        '',
        '提醒项应覆盖：当前对话历史中下一程需要知道的任务目标、讨论细节、下一步行动、关键定位信息、运行/验证信息、临时路径/ID/样例输入，以及任何恢复工作容易丢的判断依据。提醒项没有固定长度限制，宁可完整一些；允许写成多条粗略提醒项，甚至带一定冗余也可以，不必在当前程强行整理干净。',
        '',
        '操作：',
        '- 优先新增详尽接续包提醒项：add_reminder({ "content": "...", "scope": "dialog" })',
        '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
        '- clear_mind({})',
        '',
        'Dominds 已提醒当前上下文告急：不要提前做“新一程清醒复核”；Dominds 真正开启新一程后，第一步才是重新审视并整理：删除冗余、纠正偏激/失真思路、合并并压缩成高质量提醒项。',
      ].join('\n');
    }

    return [
      `${formatSystemNoticePrefix(language)} 上下文状态：🔴 告急`,
      '',
      '这是 Dominds 为防止上下文丢失插入的保全提示，不是新的用户诉求；不要只回复“收到/好的/我先整理提醒项”，而要直接执行下面的保全动作。',
      '',
      `Dominds 最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动清理头脑开启新一程对话。`,
      '',
      '行动：你当前处于主线对话。尽快保住易丢信息，然后 clear_mind。Dominds 已提醒当前上下文告急：先完整读取固定“本路主线目标”提醒；它要求先问人类就立即问，并用 set_dialog_goal 记录答案；它写“依差遣牒推进”但同时提示已有并行对话，也先问人类；只有没有并行确认提示时才按差遣牒继续；已有具体目标就按目标继续。然后只把确实需要同一差遣牒下其它对话/队友知会的讨论事实落到差遣牒合适章节；再把差遣牒仍未覆盖、但恢复本路对话会丢的信息新增 scope=dialog 提醒项带过桥；允许先保留多条粗略提醒项，甚至带一定冗余也可以，不必在当前程强行整理干净。',
      '',
      '操作：',
      '- 若固定“本路主线目标”提醒要求先问人类：问清后调用 set_dialog_goal({ "mode": "goal", "goal": "..." })',
      '- 优先新增差遣牒章节保存讨论细节：do_mind({ "category": "<category>", "selector": "<selector>", "content": "..." })',
      '- 只有在确实需要改写已有章节、且已对照当前差遣牒内容完成合并时，才先调用 recall_taskdoc({"selector":"<selector>"}) 取得 content_hash，再更新：change_mind({"selector":"<selector>","content":"...","previous_content_hash":"crc32:..."})',
      '- 优先新增当前对话 scope=dialog 过桥提醒项：add_reminder({ "content": "...", "scope": "dialog" })',
      '- 只有在确实能就地复用现有提醒项、且不会额外增加当前程认知负担时，才更新：update_reminder({ "reminder_id": "<现有 reminder_id>", "content": "..." })',
      '- clear_mind({})',
      '',
      '接续包要点：下一步行动 + 关键定位信息 + 运行验证方式 + 容易丢的临时细节；不要重复固定“本路主线目标”提醒和差遣牒已有内容，本程刚落入差遣牒的讨论细节只需提示下一程先查差遣牒。Dominds 已提醒当前上下文告急：不要提前做“新一程清醒复核”；Dominds 真正开启新一程后，第一步才是按固定“本路主线目标”提醒继续本路对话，并重新审视整理：删除冗余、纠正偏激/失真思路、合并并压缩成高质量提醒项。',
    ].join('\n');
  }

  if (args.kind === 'caution' && args.mode === 'soft') {
    if (isSideDialog) {
      return [
        `${formatSystemNoticePrefix(language)} Context state: 🟡 caution`,
        '',
        'This is a Dominds notice to prevent context loss, not a new user request. Do the steps below directly; do not answer only with "acknowledged/ok/I will organize reminders first".',
        '',
        'Impact: stale call/results in dialog history are creating cognitive noise.',
        '',
        'Action: you are in a Side Dialog. Do not maintain Taskdoc in this course, and do not draft Taskdoc update proposals. The current goal is to maintain sufficiently detailed current-dialog scoped (scope=dialog) continuation-package reminders, then proactively clear_mind to start a new dialog course.',
        '',
        'Priority reminder: the continuation-package reminder must state this specific Side Dialog task goal. The same Taskdoc may have other Main/Side Dialogs for the same agent, so the next course must continue this dialog from scope=dialog reminders instead of guessing the goal from the shared Taskdoc.',
        '',
        'Reminders should cover: the task goal, discussion details from current dialog history that the next course needs to know, next actions, key pointers, run/verify info, volatile paths/IDs/sample inputs, and any reasoning needed to resume safely. Reminders have no fixed length limit, so prefer being complete; rough multi-reminder carry-over is acceptable, and you do not need to force everything into one clean reminder in the current course.',
        '',
        'Dominds has already warned that context is tight for the current course, so do not keep expanding context and do not switch early into “clear-headed continuation-package review” mode; reminder cleanup and dedup belong to the new course.',
        '',
        'Operations:',
        '- Prefer adding a detailed continuation-package reminder first: add_reminder({ "content": "...", "scope": "dialog" })',
        '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
      ].join('\n');
    }

    return [
      `${formatSystemNoticePrefix(language)} Context state: 🟡 caution`,
      '',
      'This is a Dominds notice to prevent context loss, not a new user request. Do the steps below directly; do not answer only with "acknowledged/ok/I will organize reminders first".',
      '',
      'Impact: stale call/results in dialog history are creating cognitive noise.',
      '',
      'Action: you are in the Main Dialog. First read the full fixed Main Dialog goal reminder. If it says to ask the human first, ask immediately and record the answer with set_dialog_goal; if it says "proceed from the Taskdoc" but also says there is a parallel dialog, ask the human first; only proceed from the Taskdoc when there is no parallel-dialog note; if it already has a concrete goal, follow that goal. Then record only discussion facts that other dialogs/teammates sharing the same Taskdoc truly need to know into the appropriate Taskdoc sections. After that, write information still not covered by Taskdoc but easy to lose for resuming this dialog into scope=dialog bridge reminders (next step + key pointers + run/verify info + easy-to-lose volatile details). Some redundancy is acceptable, and rough multi-reminder carry-over is acceptable too; do not force everything into one clean reminder in the current course.',
      '',
      'Dominds has already warned that context is tight for the current course, so do not keep expanding context and do not switch early into “clear-headed continuation-package review” mode; that is the first step only after Dominds actually starts the new course. In the current course, the goal is to follow the fixed Main Dialog goal reminder, then fill Taskdoc only with facts that need to be shared, and finally carry forward details still not covered by Taskdoc but needed to resume this dialog; reminder cleanup and dedup belong to the new course. Then proactively clear_mind to start a new dialog course.',
      '',
      'Operations:',
      '- If the fixed Main Dialog goal reminder says to ask the human first: ask, then call set_dialog_goal({ "mode": "goal", "goal": "..." })',
      '- Prefer creating a new Taskdoc section for discussion details: do_mind({ "category": "<category>", "selector": "<selector>", "content": "..." })',
      '- Only update when an existing section truly needs rewriting and you have merged against the current Taskdoc content: first call recall_taskdoc({"selector":"<selector>"}) for content_hash, then change_mind({"selector":"<selector>","content":"...","previous_content_hash":"crc32:..."})',
      '- Prefer adding a current-dialog scope=dialog bridge reminder first: add_reminder({ "content": "...", "scope": "dialog" })',
      '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
    ].join('\n');
  }

  if (isSideDialog) {
    return [
      `${formatSystemNoticePrefix(language)} Context state: 🔴 critical`,
      '',
      'This is a Dominds notice to prevent context loss, not a new user request. Do the steps below directly; do not answer only with "acknowledged/ok/I will organize reminders first".',
      '',
      `Dominds will remind you ${args.promptsRemainingAfterThis} more time(s), then automatically clear mind.`,
      '',
      'Action: you are in a Side Dialog. Do not maintain Taskdoc in this course, and do not draft Taskdoc update proposals. The current goal is to maintain sufficiently detailed current-dialog scoped (scope=dialog) continuation-package reminders as soon as possible, then clear_mind.',
      '',
      'Priority reminder: the continuation-package reminder must state this specific Side Dialog task goal. The same Taskdoc may have other Main/Side Dialogs for the same agent, so the next course must continue this dialog from scope=dialog reminders instead of guessing the goal from the shared Taskdoc.',
      '',
      'Reminders should cover: the task goal, discussion details from current dialog history that the next course needs to know, next actions, key pointers, run/verify info, volatile paths/IDs/sample inputs, and any reasoning needed to resume safely. Reminders have no fixed length limit, so prefer being complete; multiple rough reminders, including some redundancy, are acceptable as a bridge.',
      '',
      'Operations:',
      '- Prefer adding a detailed continuation-package reminder first: add_reminder({ "content": "...", "scope": "dialog" })',
      '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
      '- clear_mind({})',
      '',
      'Because Dominds has warned that context is critical in the current course, do not start the new-course cleanup early; once Dominds actually starts the new course, the first step is to reconcile rough bridge reminders by removing redundancy, correcting biased or distorted bridge notes, and merging/compressing them into high-quality reminders.',
    ].join('\n');
  }

  return [
    `${formatSystemNoticePrefix(language)} Context state: 🔴 critical`,
    '',
    'This is a Dominds notice to prevent context loss, not a new user request. Do the steps below directly; do not answer only with "acknowledged/ok/I will organize reminders first".',
    '',
    `Dominds will remind you ${args.promptsRemainingAfterThis} more time(s), then automatically clear mind.`,
    '',
    'Action: you are in the Main Dialog. Preserve easy-to-lose information, then clear_mind. Because Dominds has warned that context is critical, first read the full fixed Main Dialog goal reminder. If it says to ask the human first, ask immediately and record the answer with set_dialog_goal; if it says "proceed from the Taskdoc" but also says there is a parallel dialog, ask the human first; only proceed from the Taskdoc when there is no parallel-dialog note; if it already has a concrete goal, follow that goal. Then record only discussion facts that other dialogs/teammates sharing the same Taskdoc truly need to know into the appropriate Taskdoc sections. After that, add scope=dialog bridge reminders for information still not covered by Taskdoc but easy to lose when resuming this dialog. Multiple rough reminders, including some redundancy, are acceptable as a bridge; do not spend the current course forcing them into a clean final package.',
    '',
    'Operations:',
    '- If the fixed Main Dialog goal reminder says to ask the human first: ask, then call set_dialog_goal({ "mode": "goal", "goal": "..." })',
    '- Prefer creating a new Taskdoc section for discussion details: do_mind({ "category": "<category>", "selector": "<selector>", "content": "..." })',
    '- Only update when an existing section truly needs rewriting and you have merged against the current Taskdoc content: first call recall_taskdoc({"selector":"<selector>"}) for content_hash, then change_mind({"selector":"<selector>","content":"...","previous_content_hash":"crc32:..."})',
    '- Prefer adding a current-dialog scope=dialog bridge reminder first: add_reminder({ "content": "...", "scope": "dialog" })',
    '- Only if an existing reminder is clearly the right place, and updating it would not add extra cognitive load in the current course: update_reminder({ "reminder_id": "<existing reminder_id>", "content": "..." })',
    '- clear_mind({})',
    '',
    'Continuation package: next step + key pointers + run/verify info + easy-to-lose volatile details. Do not duplicate the fixed Main Dialog goal reminder or Taskdoc content; for discussion details just written into Taskdoc in this course, only remind the next course to review Taskdoc first. Because Dominds has warned that context is critical in the current course, do not start the new-course cleanup early; once Dominds actually starts the new course, the first step is to continue this dialog from the fixed Main Dialog goal reminder and reconcile rough bridge reminders by removing redundancy, correcting biased or distorted bridge notes, and merging/compressing them into high-quality reminders.',
  ].join('\n');
}

export function formatAgentFacingCriticalUserInterjectionRemediationGuide(
  language: LanguageCode,
  args: {
    dialogScope: ContextHealthV3RemediationDialogScope;
    promptsRemainingAfterThis: number;
  },
): string {
  const isSideDialog = args.dialogScope === 'sideDialog';
  if (language === 'zh') {
    return [
      `${formatSystemNoticePrefix(language)} 上下文状态：🔴 告急；收到用户插话`,
      '',
      '本轮刚收到的用户消息是真实用户插话，不是普通的上下文保全提示；必须把它当作有效用户轮次处理，让用户看到你已经接住了这次插话。',
      '',
      `这次用户轮次已计入上下文告急倒计数。Dominds 最多再提醒你 ${args.promptsRemainingAfterThis} 次，之后将自动清理头脑开启新一程对话。`,
      '',
      isSideDialog
        ? '行动：先直接回应用户这条插话；不要继续扩张上下文，不要维护差遣牒，也不要整理差遣牒更新提案。若还需要保留接续信息，只维护足够详尽的接续包提醒项，然后尽快 clear_mind。'
        : '行动：先直接回应用户这条插话；不要继续扩张上下文。若仍有当前对话中尚未落实到文档、且下一程需要知会的讨论细节，先落到差遣牒合适章节；再把差遣牒仍未覆盖、但恢复工作会丢的信息新增提醒项带过桥，然后尽快 clear_mind。',
      '',
      '要求：不要因为告急状态沉默、挂起或只回复“收到/好的”。若必须调用工具才能回答用户，工具结果回来后继续给出用户可见回复；保持回答聚焦，并把清理/换程作为紧随其后的保全动作。',
    ].join('\n');
  }

  return [
    `${formatSystemNoticePrefix(language)} Context state: 🔴 critical; user interjection received`,
    '',
    'The user message just received in this turn is a real user interjection, not an ordinary context-preservation notice. Treat it as an effective user turn and make the system reaction visible to the user.',
    '',
    `This user turn has been counted toward the critical context-preservation countdown. Dominds will remind you ${args.promptsRemainingAfterThis} more time(s), then automatically clear mind.`,
    '',
    isSideDialog
      ? 'Action: answer this user interjection directly first. Do not expand context, do not maintain Taskdoc, and do not draft Taskdoc update proposals. If continuation info still needs preserving, maintain sufficiently detailed continuation-package reminders only, then clear_mind as soon as possible.'
      : 'Action: answer this user interjection directly first. Do not expand context. If current-dialog discussion details are still undocumented but the next course needs to know them, record them into the appropriate Taskdoc sections first; then add bridge reminders for information still not covered by Taskdoc but easy to lose, and clear_mind as soon as possible.',
    '',
    'Requirement: do not go silent, suspend, or reply only with "acknowledged/ok" because context is critical. If a tool call is necessary to answer the user, continue with a user-visible reply after the tool result returns; keep the answer focused, and perform cleanup/course transition immediately after that.',
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
      '- 本对话禁止任何 tellask-special 函数（包括 `tellaskBack` / `tellask` / `tellaskSessionless` / `askHuman` / `answerHuman`）。',
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
    '- No tellask-special functions are allowed (`tellaskBack` / `tellask` / `tellaskSessionless` / `askHuman` / `answerHuman`).',
    '- Provide pure reasoning and a summary grounded in the tellask body (and this Side Dialog’s own tellaskSession history, if any).',
  ].join('\n');
}
