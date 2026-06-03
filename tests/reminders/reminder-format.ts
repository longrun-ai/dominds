import {
  formatReminderContextFooter,
  formatReminderContextGuide,
  formatReminderItemGuide,
  formatReminderMaintenanceReference,
  formatSharedReminderUpdateImpactNotice,
  type ReminderContextFooterState,
} from '../../main/runtime/driver-messages';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type ReminderFooterStateWithoutScope = Omit<ReminderContextFooterState, 'dialogScope'>;

function formatMainReminderContextFooter(
  language: 'zh' | 'en',
  state: ReminderFooterStateWithoutScope,
): string {
  return formatReminderContextFooter(language, {
    dialogScope: { kind: 'main_dialog' },
    ...state,
  });
}

function formatSideReminderContextFooter(
  language: 'zh' | 'en',
  state: ReminderFooterStateWithoutScope,
): string {
  return formatReminderContextFooter(language, {
    dialogScope: { kind: 'side_dialog' },
    ...state,
  });
}

async function main() {
  const zhContextGuide = formatReminderContextGuide('zh');
  assert(
    zhContextGuide.includes('提醒项上下文块开始'),
    'Expected zh reminder context guide to include paired block header',
  );
  assert(
    zhContextGuide.includes('Dominds 为你放到当前上下文里的可见提醒项'),
    'Expected zh reminder context guide to explain Dominds-added reminder context',
  );
  assert(
    zhContextGuide.includes('Dominds 是你当前所在的自主运行环境'),
    'Expected zh reminder context guide to explain Dominds as the runtime environment',
  );
  assert(
    zhContextGuide.includes('它们不是用户的新诉求/指令'),
    'Expected zh reminder context guide to clarify reminders are not new user requests/instructions',
  );
  assert(
    zhContextGuide.includes('用户通过独立的 Reminder 小组件/面板项看到这些提醒'),
    'Expected zh reminder context guide to explain separate Reminder widget presentation',
  );
  const zhContextFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'user_message' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhContextFooter.includes('从“提醒项上下文块开始”到“提醒项上下文块结束”之间'),
    'Expected zh reminder context footer to scope the warning to the reminder block',
  );
  assert(
    zhContextFooter.includes('并非用户诉求/指令'),
    'Expected zh reminder context footer to warn that the block is not a user request/instruction',
  );
  assert(
    zhContextFooter.includes('后续消息是用户的新诉求/指令，不是提醒项投影'),
    'Expected zh reminder context footer to explicitly identify following user message',
  );
  assert(
    zhContextFooter.includes('提醒项块说明到此为止，不得外溢到那条消息'),
    'Expected zh reminder context footer to prevent reminder-block guidance from spilling onto the real user message',
  );
  assert(
    zhContextFooter.includes('若它要求更新你的职责、偏好或心智资产，应照常落实'),
    'Expected zh reminder context footer to preserve real user-message obligations after the reminder block',
  );
  const zhAutoContinueFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'none' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhAutoContinueFooter.includes('本轮没有新的用户消息或 Dominds 提示'),
    'Expected zh auto-continue reminder footer to explicitly say no new message follows',
  );
  assert(
    zhAutoContinueFooter.includes('先校对会影响当前判断的提醒项'),
    'Expected zh auto-continue reminder footer to first reconcile reminders that affect judgment',
  );
  assert(
    zhAutoContinueFooter.includes('过时、失真、互相冲突或会误导当前行动'),
    'Expected zh auto-continue reminder footer to repair stale or misleading reminders',
  );
  assert(
    !zhAutoContinueFooter.includes('不要把提醒项维护当成续推动作'),
    'Expected zh auto-continue reminder footer not to contain the stale reminder-maintenance prohibition',
  );
  assert(
    zhAutoContinueFooter.includes('当前是主线对话'),
    'Expected zh main auto-continue reminder footer to say the dialog scope directly',
  );
  assert(
    !zhAutoContinueFooter.includes('tellaskBack'),
    'Expected zh main auto-continue reminder footer not to mention Side Dialog tellaskBack',
  );
  assert(
    zhAutoContinueFooter.includes('用 `askHuman({ tellaskContent })`'),
    'Expected zh main auto-continue reminder footer to reserve askHuman for truly human input',
  );
  assert(
    zhAutoContinueFooter.includes('鞭策开启时会继续续推'),
    'Expected zh auto-continue reminder footer to preserve Main Dialog diligence keep-alive',
  );
  assert(
    !zhAutoContinueFooter.includes('需要回贴时会收到回贴提醒'),
    'Expected zh main auto-continue reminder footer not to include Side Dialog reply-reminder wording',
  );
  assert(
    zhAutoContinueFooter.includes('交给 Dominds 按主线安排处理'),
    'Expected zh auto-continue reminder footer to hand back to mainline behavior when there is no real action',
  );
  assert(
    zhAutoContinueFooter.includes('这里的“没有新消息”只说明本轮没有额外用户消息或 Dominds 提示'),
    'Expected zh auto-continue reminder footer to explain the no-new-message state positively',
  );
  const zhSideAutoContinueFooter = formatSideReminderContextFooter('zh', {
    followingMessage: { kind: 'none' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhSideAutoContinueFooter.includes('当前是支线对话'),
    'Expected zh side auto-continue reminder footer to say the dialog scope directly',
  );
  assert(
    zhSideAutoContinueFooter.includes('先按当前工具规则考虑 `tellaskBack({ tellaskContent })`'),
    'Expected zh side auto-continue reminder footer to prefer tellaskBack for requester clarification',
  );
  assert(
    zhSideAutoContinueFooter.includes('才用 `askHuman({ tellaskContent })`'),
    'Expected zh side auto-continue reminder footer to reserve askHuman for truly human input',
  );
  assert(
    zhSideAutoContinueFooter.includes('需要回贴时会收到回贴提醒'),
    'Expected zh side auto-continue reminder footer to preserve Side Dialog reply reminders',
  );
  assert(
    zhSideAutoContinueFooter.includes('交给 Dominds 按支线安排处理'),
    'Expected zh side auto-continue reminder footer to hand back to sideline behavior when there is no real action',
  );
  assert(
    !zhSideAutoContinueFooter.includes('鞭策开启时会继续续推'),
    'Expected zh side auto-continue reminder footer not to include Main Dialog diligence wording',
  );
  const zhRuntimeFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'runtime_notice' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhRuntimeFooter.includes('本轮提醒项块之后会接着出现一条 Dominds 提示'),
    'Expected zh reminder context footer to explicitly identify following Dominds notice',
  );
  const zhHumanAnswerFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'human_answer' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhHumanAnswerFooter.includes('用户对一个提问的回答'),
    'Expected zh reminder context footer to explicitly identify following human answer',
  );
  assert(
    zhHumanAnswerFooter.includes('不是新的普通用户诉求/指令'),
    'Expected zh human-answer footer not to treat the answer as a fresh ordinary user request',
  );
  const zhInterjectionPendingFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'none' },
    business: { kind: 'pending_user_interjection_with_active_reply' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhInterjectionPendingFooter.includes('真实用户插话尚未得到可见回复'),
    'Expected zh reminder footer to surface pending user interjection reply',
  );
  assert(
    zhInterjectionPendingFooter.includes('同时还有回贴任务未完成'),
    'Expected zh reminder footer to describe active handoff while user interjection is pending',
  );
  const zhInterjectionActiveFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'none' },
    business: { kind: 'pending_user_interjection_with_active_reply' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhInterjectionActiveFooter.includes('同时还有回贴任务未完成'),
    'Expected zh reminder footer to describe active handoff while user interjection is pending',
  );
  assert(
    !zhInterjectionActiveFooter.includes('前面那件转交任务已经回报完成了'),
    'Expected zh active handoff footer not to use completed-handoff follow-up wording',
  );
  const zhCompletedSideReplyUserMessageFooter = formatSideReminderContextFooter('zh', {
    followingMessage: { kind: 'user_message' },
    business: { kind: 'user_followup_after_completed_handoff' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhCompletedSideReplyUserMessageFooter.includes('后续消息是用户的新诉求/指令'),
    'Expected zh completed-side-reply footer before a real user message to preserve that user message',
  );
  assert(
    zhCompletedSideReplyUserMessageFooter.includes('现在是用户在追问你'),
    'Expected zh completed-side-reply footer before a real user message to state the follow-up scenario',
  );
  assert(
    !zhCompletedSideReplyUserMessageFooter.includes('本轮没有新的用户消息或 Dominds 提示'),
    'Expected zh completed-side-reply footer before a real user message not to use auto-continuation wording',
  );
  const zhCompletedSideReplyInterjectionFooter = formatSideReminderContextFooter('zh', {
    followingMessage: { kind: 'none' },
    business: { kind: 'user_followup_after_completed_handoff' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhCompletedSideReplyInterjectionFooter.includes('现在是用户在追问你'),
    'Expected zh completed-side-reply footer to state the already-classified user follow-up scenario plainly',
  );
  assert(
    zhCompletedSideReplyInterjectionFooter.includes('请按用户这条消息正常交流和处理'),
    'Expected zh completed-side-reply footer to make normal user interaction the current goal',
  );
  assert(
    !zhCompletedSideReplyInterjectionFooter.includes('不要把整理提醒项当成当前目标'),
    'Expected zh completed-side-reply footer not to forbid reminder cleanup requested by the user',
  );
  assert(
    !zhCompletedSideReplyInterjectionFooter.includes('不要整理提醒项'),
    'Expected zh completed-side-reply footer not to ban reminder organization',
  );
  assert(
    !zhCompletedSideReplyInterjectionFooter.includes('不要调用工具'),
    'Expected zh completed-side-reply footer not to forbid tool calls needed to answer the follow-up',
  );
  assert(
    !zhCompletedSideReplyInterjectionFooter.includes('跨对话回复义务'),
    'Expected zh completed-side-reply footer to avoid technical reply-obligation wording',
  );
  assert(
    !zhCompletedSideReplyInterjectionFooter.includes('reply'),
    'Expected zh completed-side-reply footer to avoid reply-tool jargon',
  );
  const zhActiveReplyFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'none' },
    business: { kind: 'active_reply_obligation' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    zhActiveReplyFooter.includes('当前仍有回贴任务未完成'),
    'Expected zh reminder footer to surface active handoff',
  );
  const zhCautionFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'none' },
    business: { kind: 'none' },
    contextHealth: { kind: 'caution' },
  });
  assert(
    zhCautionFooter.includes('当前上下文已吃紧'),
    'Expected zh caution footer to surface tight context health',
  );
  assert(
    zhCautionFooter.includes('默认都是给下一程以清醒头脑复核后执行的'),
    'Expected zh caution footer to say reminder next steps are for the next course',
  );
  assert(
    zhCautionFooter.includes('不要为了执行提醒项里的旧下一步继续扩张上下文'),
    'Expected zh caution footer to prevent executing reminder next steps before clear_mind',
  );
  assert(
    zhCautionFooter.includes('尽快 `clear_mind`'),
    'Expected zh caution footer to prioritize clear_mind',
  );
  assert(
    !zhCautionFooter.includes('若已有明确、相关且有价值的任务动作，就继续执行'),
    'Expected zh caution footer not to encourage ordinary continuation from reminders',
  );
  const zhCriticalFooter = formatMainReminderContextFooter('zh', {
    followingMessage: { kind: 'none' },
    business: { kind: 'none' },
    contextHealth: { kind: 'critical' },
  });
  assert(
    zhCriticalFooter.includes('当前上下文已告急'),
    'Expected zh critical footer to surface critical context health',
  );
  assert(
    zhCriticalFooter.includes('不要执行提醒项里的旧下一步、旧诉请或旧工具重试'),
    'Expected zh critical footer to block old reminder actions',
  );
  assert(
    zhCriticalFooter.includes('立即 `clear_mind`'),
    'Expected zh critical footer to require immediate clear_mind',
  );

  const zh = formatReminderItemGuide('zh', 'rem02abc', '保持缩进：\n  - A\n  - B\n');
  assert(zh.includes('提醒项 [rem02abc]'), 'Expected zh reminder guide to include reminder id');
  assert(zh.includes('保持缩进'), 'Expected zh reminder guide to include content');
  assert(zh.includes('\n  - A\n'), 'Expected zh reminder guide to preserve whitespace');
  assert(
    zh.includes('你设置了提醒项，Dominds 会在需要时提醒你'),
    'Expected zh reminder guide to address the model in second person',
  );
  assert(
    zh.includes('【系统提示】 提醒项 [rem02abc]'),
    'Expected zh reminder guide to include standard system notice prefix',
  );
  assert(
    zh.includes('Dominds 提醒项说明：'),
    'Expected zh reminder guide to include a compact self-contained per-item projection note',
  );
  const deprecatedZhWorkset = '\u5de5\u4f5c\u96c6';
  assert(
    !zh.includes(deprecatedZhWorkset),
    'Expected zh reminder guide not to use work-set wording',
  );
  assert(
    !zh.includes('快捷操作：'),
    'Expected zh reminder guide to avoid imperative quick-action label',
  );
  assert(!zh.includes('可选操作：'), 'Expected zh reminder guide to omit action section labels');
  assert(
    !zh.includes('update_reminder({ "reminder_id": "rem02abc"'),
    'Expected zh reminder item guide not to carry update_reminder action text',
  );
  assert(
    !zh.includes('delete_reminder({ "reminder_id": "rem02abc"'),
    'Expected zh reminder item guide not to carry delete_reminder action text',
  );
  const zhMaintenanceReference = formatReminderMaintenanceReference('zh', [
    { id: 'rem01abc', meta: { manager: { tool: 'some_tool' } } },
    {
      id: 'rem07abc',
      meta: {
        kind: 'pending_tellask',
        pendingCount: 0,
        update: { altInstruction: '等待系统自动刷新' },
      },
    },
    {
      id: 'rem08abc',
      meta: {
        kind: 'pending_tellask',
        pendingCount: 1,
        update: {
          altInstruction: '只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道',
        },
        delete: {
          altInstruction:
            '当前仍有进行中诉请；我不能用 delete_reminder 删除。只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道',
        },
      },
    },
    {
      id: 'rem10abc',
      meta: {
        kind: 'daemon',
        update: { altInstruction: 'get_daemon_output({ "pid": 321 })' },
        delete: { altInstruction: 'stop_daemon({ "pid": 321 })' },
      },
    },
    {
      id: 'rem11abc',
      meta: {
        kind: 'daemon',
        completed: true,
        update: { altInstruction: 'get_daemon_output({ "pid": 654 })' },
      },
    },
    { id: 'rem13abc', meta: { kind: 'mcp_lease', serverId: 'sdk_stdio' } },
  ]);
  assert(zhMaintenanceReference !== undefined, 'Expected zh reminder maintenance reference');
  assert(
    zhMaintenanceReference.includes('下面列出这些提醒项可用的修正、更新或删除方式'),
    'Expected zh maintenance reference to present concrete maintenance paths',
  );
  assert(
    zhMaintenanceReference.includes('过时、失真、重复或会误导当前判断'),
    'Expected zh maintenance reference to allow stale or misleading reminder repair',
  );
  assert(
    !zhMaintenanceReference.includes('不会只为了清理/整理提醒项而继续调用提醒项工具'),
    'Expected zh maintenance reference not to contain the stale reminder-cleanup prohibition',
  );
  assert(
    !zhMaintenanceReference.includes('只有你已经决定'),
    'Expected zh maintenance reference not to use second-person wording',
  );
  assert(
    zhMaintenanceReference.includes('reminder_id=rem01abc'),
    'Expected zh maintenance reference to identify reminder_id for tool-managed reminder',
  );
  assert(
    zhMaintenanceReference.includes('some_tool({ ... })'),
    'Expected zh maintenance reference to preserve manager-tool update path',
  );
  assert(
    zhMaintenanceReference.includes(
      '清理噪音时我可删除：delete_reminder({ "reminder_id": "rem07abc" })',
    ),
    'Expected zh zero-inflight tellask maintenance reference to allow optional noise cleanup',
  );
  assert(
    zhMaintenanceReference.includes('当前仍有进行中诉请；我不能用 delete_reminder 删除'),
    'Expected zh active tellask maintenance reference to distinguish cannot-delete state',
  );
  assert(
    zhMaintenanceReference.includes('stop_daemon({ "pid": 321 })'),
    'Expected zh running daemon maintenance reference to use stop_daemon instead of delete_reminder',
  );
  assert(
    zhMaintenanceReference.includes(
      '确认已知悉 daemon 终态后，可清理：delete_reminder({ "reminder_id": "rem11abc" })',
    ),
    'Expected zh completed daemon maintenance reference to allow cleanup after terminal state acknowledgement',
  );
  assert(
    zhMaintenanceReference.includes('mcp_release({"serverId":"sdk_stdio"})'),
    'Expected zh MCP lease maintenance reference to use mcp_release instead of delete_reminder',
  );
  const zhTask = formatReminderItemGuide('zh', 'rem09abc', '记住当前任务部署命令\n', {
    scope: 'task',
  });
  assert(zhTask.includes('任务范围'), 'Expected zh task reminder guide to mark task scope');
  assert(
    zhTask.includes('当前差遣牒任务内的相关对话里提醒你'),
    'Expected zh task reminder guide to explain same-task persistence',
  );
  assert(
    zhTask.includes('当前任务的手头工作提示'),
    'Expected zh task reminder guide to use current-work wording',
  );
  assert(
    zhTask.includes('改写成对话范围提醒'),
    'Expected zh task reminder guide to use user-facing dialog-scope wording',
  );
  assert(
    !zhTask.includes('dialog 范围提醒'),
    'Expected zh task reminder guide not to expose implementation wording for dialog scope',
  );

  const zhAgent = formatReminderItemGuide('zh', 'rem12abc', '紧急全局提醒\n', {
    scope: 'agent',
  });
  assert(zhAgent.includes('智能体范围'), 'Expected zh agent reminder guide to mark agent scope');
  assert(
    zhAgent.includes('紧急、短期、全局刺眼提醒'),
    'Expected zh agent reminder guide to constrain agent scope',
  );

  const zhTaskParallelImpact = formatSharedReminderUpdateImpactNotice('zh', {
    reminderId: 'rem09abc',
    scope: 'task',
    audience: 'updater',
  });
  assert(
    zhTaskParallelImpact.includes('当前进行时存在同一智能体在当前差遣牒任务内的其它并行对话'),
    'Expected zh task parallel-impact notice to limit impact to same-task dialogs',
  );
  assert(
    zhTaskParallelImpact.includes('另建对话范围提醒项'),
    'Expected zh parallel-impact notice to recommend dialog-scope reminder for private content',
  );
  assert(
    zhTaskParallelImpact.includes('仅在本对话范围可见'),
    'Expected zh parallel-impact notice to state dialog-local visibility',
  );

  const zhAgentParallelImpact = formatSharedReminderUpdateImpactNotice('zh', {
    reminderId: 'rem12abc',
    scope: 'agent',
    audience: 'peer',
  });
  assert(
    zhAgentParallelImpact.includes('当前进行时存在同一智能体的其它并行对话'),
    'Expected zh agent parallel-impact notice to mention same-agent parallel dialogs',
  );
  assert(
    zhAgentParallelImpact.includes('刚更新了它'),
    'Expected zh peer impact notice to describe another dialog update',
  );

  const zhToolManaged = formatReminderItemGuide('zh', 'rem01abc', 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' } },
  });
  assert(
    zhToolManaged.includes('some_tool'),
    'Expected tool-managed reminder to mention management tool (zh)',
  );
  assert(
    !zhToolManaged.includes('- 更新：update_reminder'),
    'Expected tool-managed reminder not to suggest update_reminder as the update action (zh)',
  );
  assert(
    zhToolManaged.includes('工具状态'),
    'Expected tool-managed reminder to use neutral tool-state framing (zh)',
  );
  assert(
    zhToolManaged.includes('默认不要在对外回复里专门确认、复述或总结它'),
    'Expected zh tool-managed reminder to discourage standalone acknowledgment',
  );
  assert(
    zhToolManaged.includes('Dominds 提醒项说明：'),
    'Expected zh tool-managed reminder to include compact self-contained per-item projection note',
  );

  const zhPendingActiveGuard = formatReminderItemGuide('zh', 'rem08abc', '进行中诉请内容\n', {
    meta: {
      update: {
        altInstruction: '只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道',
      },
      delete: {
        altInstruction:
          '当前仍有进行中诉请；我不能用 delete_reminder 删除。只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道',
      },
    },
  });
  assert(
    !zhPendingActiveGuard.includes('delete_reminder({ "reminder_id": "rem08abc" })'),
    'Expected zh active pending-tellask guide not to suggest delete_reminder',
  );

  const zhContinuation = formatReminderItemGuide('zh', 'rem05abc', '接续信息\n', {
    meta: { kind: 'continuation_package', createdBy: 'clear_mind' },
  });
  assert(
    zhContinuation.includes('换程接续信息'),
    'Expected continuation reminder to use continuation label (zh)',
  );
  assert(
    zhContinuation.includes('不要自动当成当前必须立刻执行的新指令'),
    'Expected continuation reminder to clarify it is not an immediate command (zh)',
  );
  assert(
    zhContinuation.includes('进入新一程后，你的第一步是以清醒头脑重新审视并整理更新'),
    'Expected continuation reminder to require new-course first-step cleanup (zh)',
  );

  const enContextGuide = formatReminderContextGuide('en');
  assert(
    enContextGuide.includes('Reminder context block begins'),
    'Expected en reminder context guide to include paired block header',
  );
  assert(
    enContextGuide.includes('visible reminders were added to the current context by Dominds'),
    'Expected en reminder context guide to explain Dominds-added reminder context',
  );
  assert(
    enContextGuide.includes('Dominds is the autonomous runtime environment'),
    'Expected en reminder context guide to explain Dominds as the runtime environment',
  );
  assert(
    enContextGuide.includes('not new user requests/instructions'),
    'Expected en reminder context guide to clarify reminders are not new user requests/instructions',
  );
  assert(
    enContextGuide.includes(
      'the user sees these reminders through a separate Reminder widget/panel item',
    ),
    'Expected en reminder context guide to explain separate Reminder widget presentation',
  );
  const enContextFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'user_message' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enContextFooter.includes(
      'between "Reminder context block begins" and "Reminder context block ends"',
    ),
    'Expected en reminder context footer to scope the warning to the reminder block',
  );
  assert(
    enContextFooter.includes('not user requests/instructions'),
    'Expected en reminder context footer to warn that the block is not a user request/instruction',
  );
  assert(
    enContextFooter.includes(
      'the following message is a new user request/instruction, not a reminder projection',
    ),
    'Expected en reminder context footer to explicitly identify following user message',
  );
  assert(
    enContextFooter.includes('must not spill over onto that message'),
    'Expected en reminder context footer to prevent reminder-block guidance from spilling onto the real user message',
  );
  assert(
    enContextFooter.includes('responsibilities, preferences, or mind assets'),
    'Expected en reminder context footer to preserve real user-message obligations after the reminder block',
  );
  const enAutoContinueFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'none' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enAutoContinueFooter.includes('There is no new user message or Dominds notice in this round'),
    'Expected en auto-continue reminder footer to explicitly say no new message follows',
  );
  assert(
    enAutoContinueFooter.includes('First check reminders that affect your current judgment'),
    'Expected en auto-continue reminder footer to first reconcile reminders that affect judgment',
  );
  assert(
    enAutoContinueFooter.includes('stale, distorted, conflicting, or would mislead'),
    'Expected en auto-continue reminder footer to repair stale or misleading reminders',
  );
  assert(
    !enAutoContinueFooter.includes('do not treat reminder maintenance as task progress'),
    'Expected en auto-continue reminder footer not to contain the stale reminder-maintenance prohibition',
  );
  assert(
    enAutoContinueFooter.includes('This is a Main Dialog'),
    'Expected en main auto-continue reminder footer to say the dialog scope directly',
  );
  assert(
    !enAutoContinueFooter.includes('tellaskBack'),
    'Expected en main auto-continue reminder footer not to mention Side Dialog tellaskBack',
  );
  assert(
    enAutoContinueFooter.includes('use `askHuman({ tellaskContent })` only when'),
    'Expected en main auto-continue reminder footer to reserve askHuman for truly human input',
  );
  assert(
    enAutoContinueFooter.includes('diligence can continue it when enabled'),
    'Expected en auto-continue reminder footer to preserve Main Dialog diligence keep-alive',
  );
  assert(
    !enAutoContinueFooter.includes('receive reply reminders'),
    'Expected en main auto-continue reminder footer not to include Side Dialog reply-reminder wording',
  );
  assert(
    enAutoContinueFooter.includes('hand control back to Dominds mainline behavior'),
    'Expected en auto-continue reminder footer to hand back to mainline behavior when there is no real action',
  );
  assert(
    enAutoContinueFooter.includes(
      'Here, "no new message" only means this round has no extra user message or Dominds notice',
    ),
    'Expected en auto-continue reminder footer to explain the no-new-message state positively',
  );
  const enSideAutoContinueFooter = formatSideReminderContextFooter('en', {
    followingMessage: { kind: 'none' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enSideAutoContinueFooter.includes('This is a Side Dialog'),
    'Expected en side auto-continue reminder footer to say the dialog scope directly',
  );
  assert(
    enSideAutoContinueFooter.includes('consider `tellaskBack({ tellaskContent })` first'),
    'Expected en side auto-continue reminder footer to prefer tellaskBack for requester clarification',
  );
  assert(
    enSideAutoContinueFooter.includes('use `askHuman({ tellaskContent })` only when'),
    'Expected en side auto-continue reminder footer to reserve askHuman for truly human input',
  );
  assert(
    enSideAutoContinueFooter.includes('receive reply reminders when a reply is needed'),
    'Expected en side auto-continue reminder footer to preserve Side Dialog reply reminders',
  );
  assert(
    enSideAutoContinueFooter.includes('hand control back to Dominds sideline behavior'),
    'Expected en side auto-continue reminder footer to hand back to sideline behavior when there is no real action',
  );
  assert(
    !enSideAutoContinueFooter.includes('diligence can continue it when enabled'),
    'Expected en side auto-continue reminder footer not to include Main Dialog diligence wording',
  );
  const enRuntimeFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'runtime_notice' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enRuntimeFooter.includes('A Dominds notice follows this reminder block in this round'),
    'Expected en reminder context footer to explicitly identify following Dominds notice',
  );
  assert(
    enRuntimeFooter.includes('not a new user request/instruction'),
    'Expected en Dominds reminder footer to clarify Dominds notices are not new user requests/instructions',
  );
  const enHumanAnswerFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'human_answer' },
    business: { kind: 'none' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enHumanAnswerFooter.includes('A human answer to one of your questions follows'),
    'Expected en reminder context footer to explicitly identify following human answer',
  );
  assert(
    enHumanAnswerFooter.includes('not a new ordinary user request/instruction'),
    'Expected en human-answer footer not to treat the answer as a fresh ordinary user request',
  );
  const enInterjectionPendingFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'none' },
    business: { kind: 'pending_user_interjection_with_active_reply' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enInterjectionPendingFooter.includes('real user interjection without a visible reply'),
    'Expected en reminder footer to surface pending user interjection reply',
  );
  assert(
    enInterjectionPendingFooter.includes('while a reply task is also unfinished'),
    'Expected en reminder footer to describe active handoff while user interjection is pending',
  );
  const enInterjectionActiveFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'none' },
    business: { kind: 'pending_user_interjection_with_active_reply' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enInterjectionActiveFooter.includes('while a reply task is also unfinished'),
    'Expected en reminder footer to describe active handoff while user interjection is pending',
  );
  assert(
    !enInterjectionActiveFooter.includes('has already been reported back as complete'),
    'Expected en active handoff footer not to use completed-handoff follow-up wording',
  );
  const enCompletedSideReplyUserMessageFooter = formatSideReminderContextFooter('en', {
    followingMessage: { kind: 'user_message' },
    business: { kind: 'user_followup_after_completed_handoff' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enCompletedSideReplyUserMessageFooter.includes(
      'the following message is a new user request/instruction',
    ),
    'Expected en completed-side-reply footer before a real user message to preserve that user message',
  );
  assert(
    enCompletedSideReplyUserMessageFooter.includes('The user is asking you a follow-up now'),
    'Expected en completed-side-reply footer before a real user message to state the follow-up scenario',
  );
  assert(
    !enCompletedSideReplyUserMessageFooter.includes(
      'There is no new user message or Dominds notice in this round',
    ),
    'Expected en completed-side-reply footer before a real user message not to use auto-continuation wording',
  );
  const enCompletedSideReplyInterjectionFooter = formatSideReminderContextFooter('en', {
    followingMessage: { kind: 'none' },
    business: { kind: 'user_followup_after_completed_handoff' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enCompletedSideReplyInterjectionFooter.includes('The user is asking you a follow-up now'),
    'Expected en completed-side-reply footer to state the already-classified user follow-up scenario plainly',
  );
  assert(
    enCompletedSideReplyInterjectionFooter.includes(
      'Talk with the user normally and handle this current message',
    ),
    'Expected en completed-side-reply footer to make normal user interaction the current goal',
  );
  assert(
    !enCompletedSideReplyInterjectionFooter.includes('treat reminder cleanup as the current goal'),
    'Expected en completed-side-reply footer not to forbid reminder cleanup requested by the user',
  );
  assert(
    !enCompletedSideReplyInterjectionFooter.includes('do not organize reminders'),
    'Expected en completed-side-reply footer not to ban reminder organization',
  );
  assert(
    !enCompletedSideReplyInterjectionFooter.includes('do not call tools'),
    'Expected en completed-side-reply footer not to forbid tool calls needed to answer the follow-up',
  );
  assert(
    !enCompletedSideReplyInterjectionFooter.includes('inter-dialog reply obligation'),
    'Expected en completed-side-reply footer to avoid technical reply-obligation wording',
  );
  assert(
    !enCompletedSideReplyInterjectionFooter.includes('reply*'),
    'Expected en completed-side-reply footer to avoid reply-tool jargon',
  );
  const enActiveReplyFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'none' },
    business: { kind: 'active_reply_obligation' },
    contextHealth: { kind: 'normal' },
  });
  assert(
    enActiveReplyFooter.includes('A reply task is still unfinished'),
    'Expected en reminder footer to surface active handoff',
  );
  const enCautionFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'none' },
    business: { kind: 'none' },
    contextHealth: { kind: 'caution' },
  });
  assert(
    enCautionFooter.includes('Context is tight'),
    'Expected en caution footer to surface tight context health',
  );
  assert(
    enCautionFooter.includes('meant for the next course to review and run with a clear head'),
    'Expected en caution footer to say reminder next steps are for the next course',
  );
  assert(
    enCautionFooter.includes('Do not expand context by performing old next steps from reminders'),
    'Expected en caution footer to prevent executing reminder next steps before clear_mind',
  );
  assert(
    enCautionFooter.includes('call `clear_mind` soon'),
    'Expected en caution footer to prioritize clear_mind',
  );
  assert(
    !enCautionFooter.includes('if there is a clear, relevant, valuable actual task action'),
    'Expected en caution footer not to encourage ordinary continuation from reminders',
  );
  const enCriticalFooter = formatMainReminderContextFooter('en', {
    followingMessage: { kind: 'none' },
    business: { kind: 'none' },
    contextHealth: { kind: 'critical' },
  });
  assert(
    enCriticalFooter.includes('Context is critical'),
    'Expected en critical footer to surface critical context health',
  );
  assert(
    enCriticalFooter.includes('Do not perform old next steps, old handed-off requests'),
    'Expected en critical footer to block old reminder actions',
  );
  assert(
    enCriticalFooter.includes('call `clear_mind` immediately'),
    'Expected en critical footer to require immediate clear_mind',
  );

  const en = formatReminderItemGuide('en', 'rem02abc', 'Keep indentation:\n  - A\n  - B\n');
  assert(en.includes('REMINDER [rem02abc]'), 'Expected en reminder guide to include reminder id');
  assert(en.includes('Keep indentation'), 'Expected en reminder guide to include content');
  assert(
    en.includes('You set a reminder so Dominds can remind you when needed'),
    'Expected en reminder guide to address the model in second person',
  );
  assert(
    en.includes('[System notice] REMINDER [rem02abc]'),
    'Expected en reminder guide to include standard system notice prefix',
  );
  assert(
    en.includes('Dominds reminder note:'),
    'Expected en reminder guide to include a compact self-contained per-item projection note',
  );
  assert(
    !en.includes('HIGH-PRIORITY WORKING SET'),
    'Expected en reminder guide not to use work-queue framing',
  );
  const deprecatedEnWorkset = 'work' + 'set';
  assert(
    !en.includes(deprecatedEnWorkset),
    'Expected en reminder guide not to use deprecated work-set wording',
  );
  assert(
    !en.includes('Optional actions:'),
    'Expected en reminder guide to omit action section labels',
  );
  assert(
    !en.includes('update_reminder({ "reminder_id": "rem02abc"'),
    'Expected en reminder item guide not to carry update_reminder action text',
  );
  assert(
    !en.includes('delete_reminder({ "reminder_id": "rem02abc"'),
    'Expected en reminder item guide not to carry delete_reminder action text',
  );
  const enMaintenanceReference = formatReminderMaintenanceReference('en', [
    { id: 'rem03abc', meta: { manager: { tool: 'some_tool' } } },
    {
      id: 'rem07abc',
      meta: {
        kind: 'pending_tellask',
        pendingCount: 0,
        update: { altInstruction: 'wait for system refresh' },
      },
    },
    {
      id: 'rem08abc',
      meta: {
        kind: 'pending_tellask',
        pendingCount: 1,
        update: {
          altInstruction:
            'only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
        },
        delete: {
          altInstruction:
            'there are still in-flight Tellasks; I cannot delete this reminder with delete_reminder. Only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
        },
      },
    },
    {
      id: 'rem10abc',
      meta: {
        kind: 'daemon',
        update: { altInstruction: 'get_daemon_output({ "pid": 321 })' },
        delete: { altInstruction: 'stop_daemon({ "pid": 321 })' },
      },
    },
    {
      id: 'rem11abc',
      meta: {
        kind: 'daemon',
        completed: true,
        update: { altInstruction: 'get_daemon_output({ "pid": 654 })' },
      },
    },
    { id: 'rem13abc', meta: { kind: 'mcp_lease', serverId: 'sdk_stdio' } },
  ]);
  assert(enMaintenanceReference !== undefined, 'Expected en reminder maintenance reference');
  assert(
    enMaintenanceReference.includes(
      'The following are the available ways to correct, update, or delete these reminders',
    ),
    'Expected en maintenance reference to present concrete maintenance paths',
  );
  assert(
    enMaintenanceReference.includes('stale, distorted, duplicate, or would mislead'),
    'Expected en maintenance reference to allow stale or misleading reminder repair',
  );
  assert(
    !enMaintenanceReference.includes(
      'I do not keep calling reminder tools solely to clean up or organize reminders',
    ),
    'Expected en maintenance reference not to contain the stale reminder-cleanup prohibition',
  );
  assert(
    enMaintenanceReference.includes('reminder_id=rem03abc'),
    'Expected en maintenance reference to identify reminder_id for tool-managed reminder',
  );
  assert(
    enMaintenanceReference.includes('some_tool({ ... })'),
    'Expected en maintenance reference to preserve manager-tool update path',
  );
  assert(
    enMaintenanceReference.includes(
      'Noise cleanup delete path: I may run delete_reminder({ "reminder_id": "rem07abc" })',
    ),
    'Expected en zero-inflight tellask maintenance reference to allow optional noise cleanup',
  );
  assert(
    enMaintenanceReference.includes(
      'there are still in-flight Tellasks; I cannot delete this reminder with delete_reminder',
    ),
    'Expected en active tellask maintenance reference to distinguish cannot-delete state',
  );
  assert(
    enMaintenanceReference.includes('stop_daemon({ "pid": 321 })'),
    'Expected en running daemon maintenance reference to use stop_daemon instead of delete_reminder',
  );
  assert(
    enMaintenanceReference.includes('after I have acknowledged the daemon terminal state'),
    'Expected en completed daemon maintenance reference to allow cleanup after terminal state acknowledgement',
  );
  assert(
    enMaintenanceReference.includes('mcp_release({"serverId":"sdk_stdio"})'),
    'Expected en MCP lease maintenance reference to use mcp_release instead of delete_reminder',
  );
  const enTask = formatReminderItemGuide('en', 'rem09abc', 'Remember the deploy command\n', {
    scope: 'task',
  });
  assert(enTask.includes('TASK SCOPE'), 'Expected en task reminder guide to mark task scope');
  assert(
    enTask.includes('across relevant dialogs for the current Taskdoc'),
    'Expected en task reminder guide to explain same-task persistence',
  );
  assert(
    enTask.includes('current-work reference'),
    'Expected en task reminder guide to use current-work wording',
  );

  const enAgent = formatReminderItemGuide('en', 'rem12abc', 'Urgent global cue\n', {
    scope: 'agent',
  });
  assert(enAgent.includes('AGENT SCOPE'), 'Expected en agent reminder guide to mark agent scope');
  assert(
    enAgent.includes('urgent, short-lived, globally visible cues'),
    'Expected en agent reminder guide to constrain agent scope',
  );

  const enTaskParallelImpact = formatSharedReminderUpdateImpactNotice('en', {
    reminderId: 'rem09abc',
    scope: 'task',
    audience: 'updater',
  });
  assert(
    enTaskParallelImpact.includes(
      'current in-flight work has other parallel dialogs for the same agent and Taskdoc',
    ),
    'Expected en task parallel-impact notice to limit impact to same-task dialogs',
  );
  assert(
    enTaskParallelImpact.includes('create a dialog-scope reminder instead'),
    'Expected en parallel-impact notice to recommend dialog-scope reminder for private content',
  );
  assert(
    enTaskParallelImpact.includes('visible only inside this dialog'),
    'Expected en parallel-impact notice to state dialog-local visibility',
  );

  const enAgentParallelImpact = formatSharedReminderUpdateImpactNotice('en', {
    reminderId: 'rem12abc',
    scope: 'agent',
    audience: 'peer',
  });
  assert(
    enAgentParallelImpact.includes(
      'current in-flight work has other parallel dialogs for the same agent',
    ),
    'Expected en agent parallel-impact notice to mention same-agent parallel dialogs',
  );
  assert(
    enAgentParallelImpact.includes('Another parallel dialog for the same agent just updated it'),
    'Expected en peer impact notice to describe another dialog update',
  );

  const enToolManaged = formatReminderItemGuide('en', 'rem03abc', 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' } },
  });
  assert(
    enToolManaged.includes('do not explicitly acknowledge, restate, or summarize it'),
    'Expected en tool-managed reminder to discourage standalone acknowledgment',
  );
  assert(
    enToolManaged.includes('Dominds reminder note:'),
    'Expected en tool-managed reminder to include compact self-contained per-item projection note',
  );
  assert(
    !enToolManaged.includes('- Update: update_reminder'),
    'Expected en tool-managed reminder not to suggest update_reminder as the update action',
  );
  assert(
    enToolManaged.includes('(TOOL STATE)'),
    'Expected en tool-managed reminder to use tool-state framing',
  );

  const enPendingActiveGuard = formatReminderItemGuide(
    'en',
    'rem08abc',
    'In-flight tellask content\n',
    {
      meta: {
        update: {
          altInstruction:
            'only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
        },
        delete: {
          altInstruction:
            'there are still in-flight Tellasks; I cannot delete this reminder with delete_reminder. Only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
        },
      },
    },
  );
  assert(
    !enPendingActiveGuard.includes('delete_reminder({ "reminder_id": "rem08abc" })'),
    'Expected en active pending-tellask guide not to suggest delete_reminder',
  );

  const enContinuation = formatReminderItemGuide('en', 'rem05abc', 'Continuation details\n', {
    meta: { kind: 'continuation_package', createdBy: 'clear_mind' },
  });
  assert(
    enContinuation.includes('(CONTINUATION PACKAGE)'),
    'Expected continuation reminder to use continuation label (en)',
  );
  assert(
    enContinuation.includes('not as an automatic must-do command'),
    'Expected continuation reminder to clarify it is not an immediate command (en)',
  );
  assert(
    enContinuation.includes('your first step is to review and rewrite this with a clear head'),
    'Expected continuation reminder to require new-course first-step cleanup (en)',
  );

  console.log('✓ Reminder formatting test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
