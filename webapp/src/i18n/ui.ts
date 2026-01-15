import { formatLanguageName, type LanguageCode } from '../shared/types/language';

export type UiStrings = {
  backendWorkspaceTitle: string;
  backendWorkspaceLoading: string;
  loading: string;
  uiLanguageSelectTitle: string;
  themeToggleTitle: string;

  activityBarAriaLabel: string;
  activityRunning: string;
  activityDone: string;
  activityArchived: string;
  activitySearch: string;
  activityTeamMembers: string;

  placeholderDoneTitle: string;
  placeholderDoneText: string;
  placeholderArchivedTitle: string;
  placeholderArchivedText: string;
  placeholderSearchTitle: string;
  placeholderSearchText: string;
  placeholderTeamMembersTitle: string;
  placeholderTeamMembersText: string;

  newDialogTitle: string;
  currentDialogPlaceholder: string;

  previousRound: string;
  nextRound: string;

  reminders: string;
  refreshReminders: string;
  noReminders: string;
  close: string;

  createNewDialogTitle: string;
  cancel: string;
  createDialog: string;
  taskDocumentLabel: string;
  taskDocumentPlaceholder: string;
  taskDocumentHelp: string;
  teammateLabel: string;
  defaultMarker: string;

  authRequiredTitle: string;
  authDescription: string;
  authKeyLabel: string;
  authKeyPlaceholder: string;
  authKeyRequired: string;
  authFailed: string;
  failedToConnect: string;
  submit: string;
  connect: string;

  noDialogsYet: string;
  noDoneDialogs: string;
  noArchivedDialogs: string;
  missingRoot: string;

  dialogActionMarkDone: string;
  dialogActionMarkAllDone: string;
  dialogActionArchive: string;
  dialogActionArchiveAll: string;
  dialogActionRevive: string;
  dialogActionReviveAll: string;
  dialogActionDelete: string;
  confirmDeleteDialog: string;
  dialogDeletedToast: string;

  readOnlyDialogInputDisabled: string;

  q4hNoPending: string;
  q4hPendingQuestions: string;
  q4hInputPlaceholder: string;
  q4hEnterToSendTitle: string;
  q4hCtrlEnterToSendTitle: string;
  send: string;
  stop: string;
  stopping: string;
  emergencyStop: string;
  resumeAll: string;
  continueLabel: string;

  stoppedByYou: string;
  stoppedByEmergencyStop: string;
  interruptedByServerRestart: string;
  runMarkerResumed: string;
  runMarkerInterrupted: string;
  runBadgeInterruptedTitle: string;
  runBadgeWaitingHumanTitle: string;
  runBadgeWaitingSubdialogsTitle: string;
  runBadgeWaitingBothTitle: string;
  runBadgeGeneratingTitle: string;

  connectionConnected: string;
  connectionConnecting: string;
  connectionDisconnected: string;
  connectionError: string;
  connectionReconnecting: string;
  connectionFailedDetails: string;
  connectionReconnectToServerTitle: string;
  connectionReconnect: string;

  teamMembersTitle: string;
  noTeamMembers: string;
  teamMembersWillAppear: string;
  selectMemberTitle: string;
  editMemberTitle: string;

  daemonLabel: string;
  commandLabel: string;
  unknownCommand: string;
};

export function getUiStrings(language: LanguageCode): UiStrings {
  if (language === 'zh') {
    return {
      backendWorkspaceTitle: '后端运行时工作区',
      backendWorkspaceLoading: '加载中…',
      loading: '加载中…',
      uiLanguageSelectTitle: '界面语言（也用于提示 agent 用该语言回复）',
      themeToggleTitle: '切换主题',

      activityBarAriaLabel: '活动栏',
      activityRunning: '运行中',
      activityDone: '已完成',
      activityArchived: '已归档',
      activitySearch: '搜索',
      activityTeamMembers: '团队成员',

      placeholderDoneTitle: '已完成',
      placeholderDoneText: '已完成对话的占位视图。',
      placeholderArchivedTitle: '已归档',
      placeholderArchivedText: '已归档对话的占位视图。',
      placeholderSearchTitle: '搜索',
      placeholderSearchText: '搜索面板占位视图。',
      placeholderTeamMembersTitle: '团队成员',
      placeholderTeamMembersText: '团队成员控制的占位视图。',

      newDialogTitle: '新建对话',
      currentDialogPlaceholder: '从选择或创建一个对话开始',

      previousRound: '上一轮',
      nextRound: '下一轮',

      reminders: '提醒',
      refreshReminders: '刷新提醒',
      noReminders: '没有提醒',
      close: '关闭',

      createNewDialogTitle: '创建新对话',
      cancel: '取消',
      createDialog: '创建对话',
      taskDocumentLabel: '任务文档：',
      taskDocumentPlaceholder: '输入以搜索任务文档…',
      taskDocumentHelp:
        '从已有文档中选择，或输入自定义路径。必填项。Tab 补全公共前缀；Enter 选择高亮项。',
      teammateLabel: '队友：',
      defaultMarker: ' • 默认',

      authRequiredTitle: '需要认证',
      authDescription: '请输入 Dominds 认证密钥以连接。',
      authKeyLabel: '认证密钥',
      authKeyPlaceholder: '粘贴认证密钥…',
      authKeyRequired: '认证密钥不能为空。',
      authFailed: '认证失败。请检查密钥后重试。',
      failedToConnect: '连接失败。',
      submit: '提交',
      connect: '连接',

      noDialogsYet: '还没有对话。',
      noDoneDialogs: '还没有已完成的对话。',
      noArchivedDialogs: '还没有已归档的对话。',
      missingRoot: '缺失的根对话',

      dialogActionMarkDone: '标记为已完成',
      dialogActionMarkAllDone: '将此任务下全部对话标记为已完成',
      dialogActionArchive: '归档',
      dialogActionArchiveAll: '将此任务下全部对话归档',
      dialogActionRevive: '恢复到运行中',
      dialogActionReviveAll: '将此任务下全部对话恢复到运行中',
      dialogActionDelete: '删除',
      confirmDeleteDialog: '删除此对话？此操作不可撤销。',
      dialogDeletedToast: '已删除对话。',

      readOnlyDialogInputDisabled: '此对话已完成或已归档，输入已禁用。',

      q4hNoPending: '暂无待处理问题',
      q4hPendingQuestions: '待处理问题',
      q4hInputPlaceholder: '输入你的回答…',
      q4hEnterToSendTitle: '按 Enter 发送（Cmd/Ctrl+Enter 换行）',
      q4hCtrlEnterToSendTitle: '按 Cmd/Ctrl+Enter 发送（Enter 换行）',
      send: '发送',
      stop: '停止',
      stopping: '停止中…',
      emergencyStop: '紧急停止',
      resumeAll: '全部继续',
      continueLabel: '继续',

      stoppedByYou: '已由你停止',
      stoppedByEmergencyStop: '已被紧急停止终止',
      interruptedByServerRestart: '因服务器重启而中断',
      runMarkerResumed: '已继续',
      runMarkerInterrupted: '已中断',
      runBadgeInterruptedTitle: '对话已中断（可继续）',
      runBadgeWaitingHumanTitle: '等待你的输入（Q4H）',
      runBadgeWaitingSubdialogsTitle: '等待子对话完成',
      runBadgeWaitingBothTitle: '等待你的输入和子对话',
      runBadgeGeneratingTitle: '生成中…',

      connectionConnected: '已连接',
      connectionConnecting: '连接中',
      connectionDisconnected: '未连接',
      connectionError: '连接错误',
      connectionReconnecting: '重连中',
      connectionFailedDetails: '连接失败',
      connectionReconnectToServerTitle: '重新连接到服务器',
      connectionReconnect: '重连',

      teamMembersTitle: '团队成员',
      noTeamMembers: '没有团队成员',
      teamMembersWillAppear: '配置完成后，团队成员会显示在这里。',
      selectMemberTitle: '选择成员',
      editMemberTitle: '编辑成员',

      daemonLabel: '守护进程',
      commandLabel: '命令',
      unknownCommand: '未知命令',
    };
  }

  return {
    backendWorkspaceTitle: 'Backend Runtime Workspace',
    backendWorkspaceLoading: 'Loading...',
    loading: 'Loading...',
    uiLanguageSelectTitle: 'UI language (also used to prompt agent replies)',
    themeToggleTitle: 'Switch theme',

    activityBarAriaLabel: 'Activity Bar',
    activityRunning: 'Running',
    activityDone: 'Done',
    activityArchived: 'Archived',
    activitySearch: 'Search',
    activityTeamMembers: 'Team Members',

    placeholderDoneTitle: 'Done',
    placeholderDoneText: 'Placeholder view for completed dialogs.',
    placeholderArchivedTitle: 'Archived',
    placeholderArchivedText: 'Placeholder view for archived dialogs.',
    placeholderSearchTitle: 'Search',
    placeholderSearchText: 'Search panel placeholder.',
    placeholderTeamMembersTitle: 'Team Members',
    placeholderTeamMembersText: 'Placeholder view for team member controls.',

    newDialogTitle: 'New Dialog',
    currentDialogPlaceholder: 'Select or create a dialog to start',

    previousRound: 'Previous Round',
    nextRound: 'Next Round',

    reminders: 'Reminders',
    refreshReminders: 'Refresh Reminders',
    noReminders: 'No reminders',
    close: 'Close',

    createNewDialogTitle: 'Create New Dialog',
    cancel: 'Cancel',
    createDialog: 'Create Dialog',
    taskDocumentLabel: 'Task Document:',
    taskDocumentPlaceholder: 'Type to search task docs (*.tsk required)...',
    taskDocumentHelp:
      'Select from existing task docs or enter a custom path. Required format: `*.tsk/` task packages. Tab completes common prefix; Enter selects highlighted item.',
    teammateLabel: 'Teammate:',
    defaultMarker: ' • Default',

    authRequiredTitle: 'Authentication Required',
    authDescription: 'Enter the Dominds auth key to connect.',
    authKeyLabel: 'Auth key',
    authKeyPlaceholder: 'Paste auth key...',
    authKeyRequired: 'Auth key is required.',
    authFailed: 'Auth failed. Please check the key and try again.',
    failedToConnect: 'Failed to connect.',
    submit: 'Submit',
    connect: 'Connect',

    noDialogsYet: 'No dialogs yet.',
    noDoneDialogs: 'No done dialogs yet.',
    noArchivedDialogs: 'No archived dialogs yet.',
    missingRoot: 'Missing root',

    dialogActionMarkDone: 'Mark done',
    dialogActionMarkAllDone: 'Mark all done',
    dialogActionArchive: 'Archive',
    dialogActionArchiveAll: 'Archive all',
    dialogActionRevive: 'Revive',
    dialogActionReviveAll: 'Revive all',
    dialogActionDelete: 'Delete',
    confirmDeleteDialog: 'Delete this dialog? This cannot be undone.',
    dialogDeletedToast: 'Dialog deleted.',

    readOnlyDialogInputDisabled: 'This dialog is done or archived; input is disabled.',

    q4hNoPending: 'No pending questions',
    q4hPendingQuestions: 'Pending Questions',
    q4hInputPlaceholder: 'Type your answer...',
    q4hEnterToSendTitle: 'Enter to send (Cmd/Ctrl+Enter for newline)',
    q4hCtrlEnterToSendTitle: 'Cmd/Ctrl+Enter to send (Enter for newline)',
    send: 'Send',
    stop: 'Stop',
    stopping: 'Stopping…',
    emergencyStop: 'Emergency stop',
    resumeAll: 'Resume all',
    continueLabel: 'Continue',

    stoppedByYou: 'Stopped by you',
    stoppedByEmergencyStop: 'Stopped by emergency stop',
    interruptedByServerRestart: 'Interrupted by server restart',
    runMarkerResumed: 'Resumed',
    runMarkerInterrupted: 'Interrupted',
    runBadgeInterruptedTitle: 'Interrupted (resumable)',
    runBadgeWaitingHumanTitle: 'Waiting for human input (Q4H)',
    runBadgeWaitingSubdialogsTitle: 'Waiting for subdialogs',
    runBadgeWaitingBothTitle: 'Waiting for human + subdialogs',
    runBadgeGeneratingTitle: 'Generating…',

    connectionConnected: 'Connected',
    connectionConnecting: 'Connecting',
    connectionDisconnected: 'Disconnected',
    connectionError: 'Error',
    connectionReconnecting: 'Reconnecting',
    connectionFailedDetails: 'connection failed',
    connectionReconnectToServerTitle: 'Reconnect to server',
    connectionReconnect: 'Reconnect',

    teamMembersTitle: 'Team Members',
    noTeamMembers: 'No team members',
    teamMembersWillAppear: 'Team members will appear here once configured.',
    selectMemberTitle: 'Select member',
    editMemberTitle: 'Edit member',

    daemonLabel: 'Daemon',
    commandLabel: 'Command',
    unknownCommand: 'unknown command',
  };
}

export function formatRemindersTitle(language: LanguageCode, count: number): string {
  const t = getUiStrings(language);
  return `${t.reminders} (${count})`;
}

export function formatTeamMembersTitle(language: LanguageCode, count: number): string {
  const t = getUiStrings(language);
  return `👥 ${t.teamMembersTitle} (${count})`;
}

export type UiLanguageMatchState =
  | { kind: 'unknown' }
  | { kind: 'match'; serverWorkLanguage: LanguageCode }
  | { kind: 'mismatch'; serverWorkLanguage: LanguageCode };

export function getUiLanguageMatchState(args: {
  uiLanguage: LanguageCode;
  serverWorkLanguage: LanguageCode | null;
}): UiLanguageMatchState {
  const { uiLanguage, serverWorkLanguage } = args;
  if (serverWorkLanguage === null) return { kind: 'unknown' };
  if (uiLanguage === serverWorkLanguage) {
    return { kind: 'match', serverWorkLanguage };
  }
  return { kind: 'mismatch', serverWorkLanguage };
}

export function formatUiLanguageOptionLabel(args: {
  optionLanguage: LanguageCode;
  serverWorkLanguage: LanguageCode | null;
}): string {
  const name = formatLanguageName(args.optionLanguage, args.optionLanguage);
  const match = getUiLanguageMatchState({
    uiLanguage: args.optionLanguage,
    serverWorkLanguage: args.serverWorkLanguage,
  });

  switch (match.kind) {
    case 'unknown': {
      return args.optionLanguage === 'zh' ? `${name}（工作语言?）` : `${name} (Work Language?)`;
    }
    case 'match': {
      return args.optionLanguage === 'zh' ? `${name}（是工作语言）` : `${name} (The Work Language)`;
    }
    case 'mismatch': {
      return args.optionLanguage === 'zh' ? `${name}（非工作语言）` : `${name} (Not Work Language)`;
    }
    default: {
      const _exhaustive: never = match;
      throw new Error(`Unhandled UiLanguageMatchState: ${_exhaustive}`);
    }
  }
}

export function formatUiLanguageTooltip(args: {
  /**
   * Tooltip copy language.
   * For dropdown options, this should be the option's language ("associated language").
   */
  inLanguage: LanguageCode;
  /**
   * The UI language being described (current selection or a candidate option).
   */
  describedUiLanguage: LanguageCode;
  serverWorkLanguage: LanguageCode | null;
}): string {
  const uiName = formatLanguageName(args.describedUiLanguage, args.inLanguage);
  const match = getUiLanguageMatchState({
    uiLanguage: args.describedUiLanguage,
    serverWorkLanguage: args.serverWorkLanguage,
  });

  switch (args.inLanguage) {
    case 'zh': {
      switch (match.kind) {
        case 'unknown': {
          return (
            `界面语言：${uiName}。\n` +
            `- 影响：WebUI 界面文案 + 本客户端希望 agent 用该语言回复。\n` +
            `- 不影响：agent 的内部工作语言 / 系统提示 / 队友（子对话）叙事格式。\n` +
            `工作语言尚未知（需先连接）。`
          );
        }
        case 'match': {
          const serverName = formatLanguageName(match.serverWorkLanguage, args.inLanguage);
          return (
            `界面语言：${uiName}（工作语言）\n` +
            `- 影响：WebUI 界面文案 + 本客户端希望 agent 用 ${uiName} 回复。\n` +
            `- 不影响：无（内部工作语言也为 ${serverName}）。`
          );
        }
        case 'mismatch': {
          const serverName = formatLanguageName(match.serverWorkLanguage, args.inLanguage);
          return (
            `界面语言：${uiName}（非工作语言）\n` +
            `- 影响：WebUI 界面文案 + 本客户端希望 agent 用 ${uiName} 回复。\n` +
            `- 不影响：内部工作语言仍为 ${serverName}（系统提示、队友/子对话叙事格式、内部引导信息）。`
          );
        }
        default: {
          const _exhaustive: never = match;
          throw new Error(`Unhandled UiLanguageMatchState: ${_exhaustive}`);
        }
      }
    }
    case 'en': {
      switch (match.kind) {
        case 'unknown': {
          return (
            `UI language: ${uiName}\n` +
            `- Affects: WebUI copy + this client’s preferred language for agent replies.\n` +
            `- Does NOT affect: the agent’s internal work language, system prompts, or teammate/subdialog narrative formatting.\n` +
            `Work language is not known yet (connect first).`
          );
        }
        case 'match': {
          const serverName = formatLanguageName(match.serverWorkLanguage, args.inLanguage);
          return (
            `UI language: ${uiName} (the work language)\n` +
            `- Affects: WebUI copy + this client’s preferred language for agent replies (${uiName}).\n` +
            `- Does NOT affect: nothing (internal work language is also ${serverName}).`
          );
        }
        case 'mismatch': {
          const serverName = formatLanguageName(match.serverWorkLanguage, args.inLanguage);
          return (
            `UI language: ${uiName} (not work language)\n` +
            `- Affects: WebUI copy + this client’s preferred language for agent replies (${uiName}).\n` +
            `- Does NOT affect: internal work language remains ${serverName} (system prompts, teammate/subdialog narrative formatting, internal guide messages).`
          );
        }
        default: {
          const _exhaustive: never = match;
          throw new Error(`Unhandled UiLanguageMatchState: ${_exhaustive}`);
        }
      }
    }
    default: {
      const _exhaustive: never = args.inLanguage;
      throw new Error(`Unsupported inLanguage: ${_exhaustive}`);
    }
  }
}
