import {
  formatReminderContextFooter,
  formatReminderContextGuide,
  formatReminderItemGuide,
  formatReminderMaintenanceReference,
} from '../../main/runtime/driver-messages';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const zhContextGuide = formatReminderContextGuide('zh');
  assert(
    zhContextGuide.includes('提醒项上下文块开始'),
    'Expected zh reminder context guide to include paired block header',
  );
  assert(
    zhContextGuide.includes('当前可见提醒项的运行时上下文投影'),
    'Expected zh reminder context guide to explain runtime-added context projection',
  );
  assert(
    zhContextGuide.includes('它们都不是用户的新诉求/指令'),
    'Expected zh reminder context guide to clarify reminders are not new user requests/instructions',
  );
  assert(
    zhContextGuide.includes('用户通过独立的 Reminder 小组件/面板项看到这些提醒'),
    'Expected zh reminder context guide to explain separate Reminder widget presentation',
  );
  const zhContextFooter = formatReminderContextFooter('zh', {
    followingDialogState: 'user_message',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'normal',
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
  const zhAutoContinueFooter = formatReminderContextFooter('zh', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'normal',
  });
  assert(
    zhAutoContinueFooter.includes('本轮没有新的用户消息或运行时提示'),
    'Expected zh auto-continue reminder footer to explicitly say no new message follows',
  );
  assert(
    zhAutoContinueFooter.includes('若已有明确、相关且有价值的动作，就继续执行'),
    'Expected zh auto-continue reminder footer to make continuation conditional on relevant work',
  );
  assert(
    zhAutoContinueFooter.includes('不要为了避免“等待”而寻找无关小事'),
    'Expected zh auto-continue reminder footer to avoid pressuring agents into unrelated work',
  );
  assert(
    zhAutoContinueFooter.includes('不要把“没有新消息”理解为空系统提示'),
    'Expected zh auto-continue reminder footer to prevent empty system notice misread',
  );
  const zhRuntimeFooter = formatReminderContextFooter('zh', {
    followingDialogState: 'runtime_notice',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'normal',
  });
  assert(
    zhRuntimeFooter.includes('本轮提醒项块之后会接着出现一条运行时提示'),
    'Expected zh reminder context footer to explicitly identify following runtime notice',
  );
  const zhInterjectionPendingFooter = formatReminderContextFooter('zh', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: true,
    interDialogReplyObligation: 'parked_by_user_interjection',
    contextHealthState: 'normal',
  });
  assert(
    zhInterjectionPendingFooter.includes('真实用户插话尚未得到可见回复'),
    'Expected zh reminder footer to surface pending user interjection reply',
  );
  assert(
    zhInterjectionPendingFooter.includes('跨对话回复义务已暂存'),
    'Expected zh reminder footer to describe parked inter-dialog reply obligation',
  );
  const zhInterjectionActiveFooter = formatReminderContextFooter('zh', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: true,
    interDialogReplyObligation: 'active',
    contextHealthState: 'normal',
  });
  assert(
    zhInterjectionActiveFooter.includes('同时存在跨对话回复义务'),
    'Expected zh reminder footer to describe active inter-dialog reply obligation while user interjection is pending',
  );
  const zhActiveReplyFooter = formatReminderContextFooter('zh', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'active',
    contextHealthState: 'normal',
  });
  assert(
    zhActiveReplyFooter.includes('当前仍有跨对话回复义务'),
    'Expected zh reminder footer to surface active inter-dialog reply obligation',
  );
  const zhCautionFooter = formatReminderContextFooter('zh', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'caution',
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
    !zhCautionFooter.includes('若已有明确、相关且有价值的动作，就继续执行'),
    'Expected zh caution footer not to encourage ordinary continuation from reminders',
  );
  const zhCriticalFooter = formatReminderContextFooter('zh', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'critical',
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
    zh.includes('你设置了提醒项，让运行时系统提醒你'),
    'Expected zh reminder guide to address the model in second person',
  );
  assert(
    zh.includes('【系统提示】 提醒项 [rem02abc]'),
    'Expected zh reminder guide to include standard system notice prefix',
  );
  assert(
    zh.includes('运行时提醒项投影：'),
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
    zhMaintenanceReference.includes('我把下面的提醒项维护通道仅作为操作参考'),
    'Expected zh maintenance reference to use first-person assistant framing',
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
    zhTask.includes('当前差遣牒任务内、所有由你主理的对话里提醒你'),
    'Expected zh task reminder guide to explain same-task persistence',
  );
  assert(
    zhTask.includes('当前任务的手头工作提示'),
    'Expected zh task reminder guide to use current-work wording',
  );

  const zhAgent = formatReminderItemGuide('zh', 'rem12abc', '紧急全局提醒\n', {
    scope: 'agent',
  });
  assert(zhAgent.includes('智能体范围'), 'Expected zh agent reminder guide to mark agent scope');
  assert(
    zhAgent.includes('紧急、短期、全局刺眼提醒'),
    'Expected zh agent reminder guide to constrain agent scope',
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
    zhToolManaged.includes('运行时提醒项投影：'),
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
    enContextGuide.includes('visible reminders are runtime-added context projections'),
    'Expected en reminder context guide to explain runtime-added context projection',
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
  const enContextFooter = formatReminderContextFooter('en', {
    followingDialogState: 'user_message',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'normal',
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
  const enAutoContinueFooter = formatReminderContextFooter('en', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'normal',
  });
  assert(
    enAutoContinueFooter.includes('There is no new user message or runtime notice in this round'),
    'Expected en auto-continue reminder footer to explicitly say no new message follows',
  );
  assert(
    enAutoContinueFooter.includes('if there is a clear, relevant, valuable action'),
    'Expected en auto-continue reminder footer to make continuation conditional on relevant work',
  );
  assert(
    enAutoContinueFooter.includes('do not invent unrelated work just to avoid "waiting"'),
    'Expected en auto-continue reminder footer to avoid pressuring agents into unrelated work',
  );
  assert(
    enAutoContinueFooter.includes('Do not interpret the absence of a new message'),
    'Expected en auto-continue reminder footer to prevent empty system notice misread',
  );
  const enRuntimeFooter = formatReminderContextFooter('en', {
    followingDialogState: 'runtime_notice',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'normal',
  });
  assert(
    enRuntimeFooter.includes('A runtime notice follows this reminder block in this round'),
    'Expected en reminder context footer to explicitly identify following runtime notice',
  );
  assert(
    enRuntimeFooter.includes('not a new user request/instruction'),
    'Expected en runtime reminder footer to clarify runtime notices are not new user requests/instructions',
  );
  const enInterjectionPendingFooter = formatReminderContextFooter('en', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: true,
    interDialogReplyObligation: 'parked_by_user_interjection',
    contextHealthState: 'normal',
  });
  assert(
    enInterjectionPendingFooter.includes('real user interjection without a visible reply'),
    'Expected en reminder footer to surface pending user interjection reply',
  );
  assert(
    enInterjectionPendingFooter.includes('earlier inter-dialog reply obligation is parked'),
    'Expected en reminder footer to describe parked inter-dialog reply obligation',
  );
  const enInterjectionActiveFooter = formatReminderContextFooter('en', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: true,
    interDialogReplyObligation: 'active',
    contextHealthState: 'normal',
  });
  assert(
    enInterjectionActiveFooter.includes('while an inter-dialog reply obligation also exists'),
    'Expected en reminder footer to describe active inter-dialog reply obligation while user interjection is pending',
  );
  const enActiveReplyFooter = formatReminderContextFooter('en', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'active',
    contextHealthState: 'normal',
  });
  assert(
    enActiveReplyFooter.includes('An inter-dialog reply obligation is still active'),
    'Expected en reminder footer to surface active inter-dialog reply obligation',
  );
  const enCautionFooter = formatReminderContextFooter('en', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'caution',
  });
  assert(
    enCautionFooter.includes('Context health is tight'),
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
    !enCautionFooter.includes('if there is a clear, relevant, valuable action'),
    'Expected en caution footer not to encourage ordinary continuation from reminders',
  );
  const enCriticalFooter = formatReminderContextFooter('en', {
    followingDialogState: 'none',
    pendingUserInterjectionReply: false,
    interDialogReplyObligation: 'none',
    contextHealthState: 'critical',
  });
  assert(
    enCriticalFooter.includes('Context health is critical'),
    'Expected en critical footer to surface critical context health',
  );
  assert(
    enCriticalFooter.includes('Do not perform old next steps, old inter-dialog requests'),
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
    en.includes('You set a reminder so the runtime system can remind you'),
    'Expected en reminder guide to address the model in second person',
  );
  assert(
    en.includes('[System notice] REMINDER [rem02abc]'),
    'Expected en reminder guide to include standard system notice prefix',
  );
  assert(
    en.includes('Runtime reminder projection:'),
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
    enMaintenanceReference.includes('I treat the following reminder-maintenance channels'),
    'Expected en maintenance reference to use first-person assistant framing',
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
    enTask.includes('every dialog you lead for the current Taskdoc'),
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

  const enToolManaged = formatReminderItemGuide('en', 'rem03abc', 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' } },
  });
  assert(
    enToolManaged.includes('do not explicitly acknowledge, restate, or summarize it'),
    'Expected en tool-managed reminder to discourage standalone acknowledgment',
  );
  assert(
    enToolManaged.includes('Runtime reminder projection:'),
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
