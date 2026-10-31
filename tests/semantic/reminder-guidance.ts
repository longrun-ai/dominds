import {
  formatReminderContextFooter,
  formatReminderContextGuide,
  formatReminderItemGuide,
  formatReminderMaintenanceReference,
  formatSharedReminderMigrationImpactNotice,
  formatSharedReminderUpdateImpactNotice,
  type ReminderContextFooterState,
} from '../../main/runtime/driver-messages';
import { writeSemanticEvidence, type SemanticEvidence } from '../helpers/semantic-evidence';

// Evidence producer only. Neither successful rendering nor this process judges meaning.
const cases: SemanticEvidence[] = [];
function emit<Args extends unknown[]>(
  id: string,
  scenario: string,
  render: (...args: Args) => string | undefined,
  args: Args,
) {
  const actual = render(...args);
  cases.push({
    id,
    scenario,
    businessValue:
      'Keep reminder references subordinate to real user intent, current work, ownership and scope; explain a useful action from the actual declared state.',
    context: {
      input: JSON.stringify(args),
      returned: actual === undefined ? 'undefined' : 'string',
      scope:
        'Actual public formatter with explicitly supplied state/metadata. This producer does not establish runtime state classification, real context pressure, queued human input, registered capabilities, shared writes/migration or tool execution. some_tool is a synthetic manager name supplied as data.',
    },
    reviewQuestions: [
      'Does the actual guidance fit the supplied roles, message source, task/reply state and pressure without treating old references as new user commands or suppressing the real user request?',
      'Are scope, maintenance and clarification directions appropriate for the supplied facts, with the given body/data preserved and no claim of unperformed work?',
    ],
    actualText: actual ?? '',
  });
}
const footers: { id: string; scenario: string; state: ReminderContextFooterState }[] = [
  {
    id: 'main-user-message',
    scenario:
      'A real new user message follows a reference-only reminder block; its instructions still apply.',
    state: {
      dialogScope: { kind: 'main_dialog' },
      followingMessage: { kind: 'user_message' },
      business: { kind: 'none' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'main-no-new-message',
    scenario:
      'Main Dialog continuation with no newly appended message and no special handoff state; reminders are current-work references.',
    state: {
      dialogScope: { kind: 'main_dialog' },
      followingMessage: { kind: 'none' },
      business: { kind: 'none' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'side-no-new-message',
    scenario:
      'Side Dialog continuation with no new message; distinguish requester clarification from a genuinely human-only question.',
    state: {
      dialogScope: { kind: 'side_dialog' },
      followingMessage: { kind: 'none' },
      business: { kind: 'none' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'runtime-notice',
    scenario: 'A runtime notice follows the reminder block, distinct from a new user request.',
    state: {
      dialogScope: { kind: 'main_dialog' },
      followingMessage: { kind: 'runtime_notice' },
      business: { kind: 'none' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'human-answer',
    scenario:
      'A human answer to an outstanding question follows, distinct from a fresh ordinary request.',
    state: {
      dialogScope: { kind: 'main_dialog' },
      followingMessage: { kind: 'human_answer' },
      business: { kind: 'none' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'pending-user-and-handoff',
    scenario:
      'An earlier real user interjection remains unanswered while a handoff reply is unfinished; no additional message is appended in this tool-followup turn.',
    state: {
      dialogScope: { kind: 'main_dialog' },
      followingMessage: { kind: 'none' },
      business: { kind: 'pending_user_interjection_with_active_reply' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'completed-handoff-new-followup',
    scenario:
      'The Side Dialog handoff has been delivered and a real new user followup now arrives; prior reminders must not restart the completed handoff.',
    state: {
      dialogScope: { kind: 'side_dialog' },
      followingMessage: { kind: 'user_message' },
      business: { kind: 'user_followup_after_completed_handoff' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'completed-handoff-tool-followup',
    scenario:
      'The earlier handoff is complete and an already-present user followup is being handled; a tool-followup turn appends no further user message. User-requested reminder work remains valid.',
    state: {
      dialogScope: { kind: 'side_dialog' },
      followingMessage: { kind: 'none' },
      business: { kind: 'user_followup_after_completed_handoff' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'active-handoff',
    scenario: 'A reply obligation is still active; it must not be described as completed.',
    state: {
      dialogScope: { kind: 'main_dialog' },
      followingMessage: { kind: 'none' },
      business: { kind: 'active_reply_obligation' },
      contextHealth: { kind: 'normal' },
    },
  },
  {
    id: 'caution',
    scenario:
      'Runtime has supplied caution context health; preserve useful state for a fresh course instead of blindly expanding old reminder actions.',
    state: {
      dialogScope: { kind: 'main_dialog' },
      followingMessage: { kind: 'none' },
      business: { kind: 'none' },
      contextHealth: { kind: 'caution' },
    },
  },
  {
    id: 'critical',
    scenario:
      'Runtime has supplied critical context health; preserve current work and renew context before blindly replaying old next steps.',
    state: {
      dialogScope: { kind: 'main_dialog' },
      followingMessage: { kind: 'none' },
      business: { kind: 'none' },
      contextHealth: { kind: 'critical' },
    },
  },
];
async function main() {
  for (const language of ['zh', 'en'] as const) {
    const zh = language === 'zh';
    emit(
      language + '-context-guide',
      'The runtime introduces a reference reminder block, not a new user instruction.',
      formatReminderContextGuide,
      [language],
    );
    for (const row of footers)
      emit(`${language}-${row.id}`, row.scenario, formatReminderContextFooter, [
        language,
        row.state,
      ]);
    const items: {
      id: string;
      reminderId: string;
      body: string;
      options?: Parameters<typeof formatReminderItemGuide>[3];
      scenario: string;
    }[] = [
      {
        id: 'manual',
        reminderId: 'rem02abc',
        body: zh ? '保持缩进：\n  - A\n  - B\n' : 'Keep indentation:\n  - A\n  - B\n',
        scenario:
          'An agent-maintained dialog reminder retains its complete supplied body and significant indentation as a reference.',
      },
      {
        id: 'task',
        reminderId: 'rem09abc',
        body: zh ? '记住当前任务部署命令\n' : 'Remember the deploy command\n',
        options: { scope: 'task' },
        scenario:
          'A task-scoped current-work reminder is shared only within this agent/current Taskdoc; private content belongs in dialog scope.',
      },
      {
        id: 'agent',
        reminderId: 'rem12abc',
        body: zh ? '紧急全局提醒\n' : 'Urgent global cue\n',
        options: { scope: 'agent' },
        scenario:
          'An agent-scoped reminder is a short-lived global cue, not a place to mirror ordinary task progress.',
      },
      {
        id: 'tool-managed',
        reminderId: zh ? 'rem01abc' : 'rem03abc',
        body: 'Managed content\n',
        options: { meta: { manager: { tool: 'some_tool' } } },
        scenario:
          'A declared manager tool owns this state reminder; the item is a reference rather than a self-authored note or an action receipt.',
      },
      {
        id: 'restricted-maintenance',
        reminderId: 'rem08abc',
        body: zh ? '进行中诉请内容\n' : 'In-flight tellask content\n',
        options: {
          meta: {
            update: {
              altInstruction: zh
                ? '只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道'
                : 'only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
            },
            delete: {
              altInstruction: zh
                ? '当前仍有进行中诉请；我不能用 delete_reminder 删除。只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道'
                : 'there are still in-flight Tellasks; I cannot delete this reminder with delete_reminder. Only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
            },
          },
        },
        scenario:
          'An item has declared maintenance restrictions for an in-flight ask; its compact projection must defer to the corresponding maintenance channel rather than invent a free-delete action.',
      },
      {
        id: 'continuation',
        reminderId: 'rem05abc',
        body: zh ? '接续信息\n' : 'Continuation details\n',
        options: { meta: { kind: 'continuation_package', createdBy: 'clear_mind' } },
        scenario:
          'A retained continuation package is reviewed in a fresh course; it is not an immediate command to replay every old step.',
      },
    ];
    for (const row of items) {
      if (row.options)
        emit(`${language}-item-${row.id}`, row.scenario, formatReminderItemGuide, [
          language,
          row.reminderId,
          row.body,
          row.options,
        ]);
      else
        emit(`${language}-item-${row.id}`, row.scenario, formatReminderItemGuide, [
          language,
          row.reminderId,
          row.body,
        ]);
    }
    const maintenance: Parameters<typeof formatReminderMaintenanceReference>[1] = [
      { id: zh ? 'rem01abc' : 'rem03abc', meta: { manager: { tool: 'some_tool' } } },
      {
        id: 'rem07abc',
        meta: {
          kind: 'pending_tellask',
          pendingCount: 0,
          update: { altInstruction: zh ? '等待系统自动刷新' : 'wait for system refresh' },
        },
      },
      {
        id: 'rem08abc',
        meta: {
          kind: 'pending_tellask',
          pendingCount: 1,
          update: {
            altInstruction: zh
              ? '只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道'
              : 'only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
          },
          delete: {
            altInstruction: zh
              ? '当前仍有进行中诉请；我不能用 delete_reminder 删除。只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道'
              : 'there are still in-flight Tellasks; I cannot delete this reminder with delete_reminder. Only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
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
    ];
    emit(
      language + '-maintenance-reference',
      'Given six declared maintenance routes, distinguish manager ownership, zero/in-flight asks, running/completed daemons and an MCP lease. Names/PIDs are fixture data; no live resource is contacted.',
      formatReminderMaintenanceReference,
      [language, maintenance],
    );
    emit(
      language + '-task-updater',
      'Runtime has already established another same-agent/same-Taskdoc dialog and this updater changed a task-scoped reminder. Explain impact and a private-content remedy.',
      formatSharedReminderUpdateImpactNotice,
      [language, { reminderId: 'rem09abc', scope: 'task', audience: 'updater' }],
    );
    emit(
      language + '-agent-peer',
      'Runtime has already established a shared update by another same-agent dialog. This peer judges relevance without rewriting the updater private state.',
      formatSharedReminderUpdateImpactNotice,
      [language, { reminderId: 'rem12abc', scope: 'agent', audience: 'peer' }],
    );
    emit(
      language + '-migration',
      'Runtime has declared that the updater migrated an agent-shared reminder into its own private dialog; this peer no longer sees it as shared state.',
      formatSharedReminderMigrationImpactNotice,
      [language, { reminderId: 'rem12abc', scope: 'agent' }],
    );
  }
  await writeSemanticEvidence(cases, 'dominds-reminder-guidance-');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
