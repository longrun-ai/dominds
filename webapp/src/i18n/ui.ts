import type { LanguageCode } from '../shared/types/language';

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
  missingRoot: string;

  q4hNoPending: string;
  q4hPendingQuestions: string;
  q4hInputPlaceholder: string;
  q4hEnterToSendTitle: string;
  q4hCtrlEnterToSendTitle: string;

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
      currentDialogPlaceholder: '选择或创建一个对话以开始',

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
      missingRoot: '缺失的根对话',

      q4hNoPending: '暂无待处理问题',
      q4hPendingQuestions: '待处理问题',
      q4hInputPlaceholder: '输入你的回答…',
      q4hEnterToSendTitle: '按 Enter 发送（Cmd/Ctrl+Enter 换行）',
      q4hCtrlEnterToSendTitle: '按 Cmd/Ctrl+Enter 发送（Enter 换行）',

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
    taskDocumentPlaceholder: 'Type to search task documents...',
    taskDocumentHelp:
      'Select from existing documents or enter a custom path. Required field. Tab completes common prefix, Enter selects highlighted item.',
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
    missingRoot: 'Missing root',

    q4hNoPending: 'No pending questions',
    q4hPendingQuestions: 'Pending Questions',
    q4hInputPlaceholder: 'Type your answer...',
    q4hEnterToSendTitle: 'Enter to send (Cmd/Ctrl+Enter for newline)',
    q4hCtrlEnterToSendTitle: 'Cmd/Ctrl+Enter to send (Enter for newline)',

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
