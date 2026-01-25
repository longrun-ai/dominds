import { formatLanguageName, type LanguageCode } from '../shared/types/language';

export type UiStrings = {
  logoGitHubTitle: string;
  backendWorkspaceTitle: string;
  backendWorkspaceLoading: string;
  loading: string;
  uiLanguageSelectTitle: string;
  themeToggleTitle: string;
  problemsButtonTitle: string;
  problemsTitle: string;
  problemsEmpty: string;

  activityBarAriaLabel: string;
  activityRunning: string;
  activityDone: string;
  activityArchived: string;
  activitySearch: string;
  activityTeamMembers: string;
  activityTools: string;

  placeholderDoneTitle: string;
  placeholderDoneText: string;
  placeholderArchivedTitle: string;
  placeholderArchivedText: string;
  placeholderSearchTitle: string;
  placeholderSearchText: string;
  placeholderTeamMembersTitle: string;
  placeholderTeamMembersText: string;
  placeholderToolsTitle: string;
  placeholderToolsText: string;

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
  shadowMembersOption: string;
  shadowMembersLabel: string;
  shadowMembersSelectRequired: string;
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
  teamMembersRefresh: string;
  teamMembersSearchPlaceholder: string;
  teamMembersShowHidden: string;
  teamMembersVisibleSection: string;
  teamMembersHiddenSection: string;
  teamMembersDefaultBadge: string;
  teamMembersHiddenBadge: string;
  teamMembersMention: string;
  teamMembersCopyMention: string;
  teamMembersCopiedPrefix: string;
  teamMembersCopyFailedPrefix: string;
  teamMembersUnknownProvider: string;
  teamMembersUnknownModel: string;
  teamMembersProviderLabel: string;
  teamMembersModelLabel: string;
  teamMembersStreamingLabel: string;
  teamMembersSpecializesLabel: string;
  teamMembersToolsetsLabel: string;
  teamMembersToolsLabel: string;
  teamMembersYes: string;
  teamMembersNo: string;
  teamMembersNoMatches: string;
  teamMembersNoMatchesHint: string;

  toolsTitle: string;
  toolsEmpty: string;
  toolsRefresh: string;
  toolsSectionFunction: string;

  daemonLabel: string;
  commandLabel: string;
  unknownCommand: string;

  // /setup
  setupTitle: string;
  setupRefresh: string;
  setupGoToApp: string;
  setupLoadingStatus: string;
  setupAuthenticationTitle: string;
  setupAuthRejected: string;
  setupAuthRequired: string;
  setupWriteTeamYamlCreate: string;
  setupWriteTeamYamlOverwrite: string;
  setupProvidersTitle: string;
  setupProvidersHelp: string;
  setupViewDefaultsYaml: string;
  setupViewWorkspaceLlmYaml: string;
  setupTeamTitle: string;
  setupTeamFileLabel: string;
  setupTeamProviderLabel: string;
  setupTeamModelLabel: string;
  setupTeamAfterWriteHint: string;
  setupSummaryReady: string;
  setupSummaryRequired: string;
  setupSummaryShell: string;
  setupSummaryDefaultRc: string;
  setupProviderApiKeys: string;
  setupProviderDocs: string;
  setupProviderBaseUrl: string;
  setupProviderEnvVar: string;
  setupProviderEnvVarSet: string;
  setupProviderEnvVarMissing: string;
  setupProviderModelsHint: string;
  setupWriteRcWrite: string;
  setupWriteRcOverwrite: string;
  setupFileModalLoading: string;
  setupFileModalSelectToCopy: string;
  setupFileModalCopy: string;
  setupSelectProviderModelFirst: string;
  setupReqMissingTeamYaml: string;
  setupReqInvalidTeamYaml: string;
  setupReqMissingDefaultsFields: string;
  setupReqUnknownProvider: string;
  setupReqUnknownModel: string;
  setupReqMissingProviderEnv: string;
  setupReqOk: string;
};

export function getUiStrings(language: LanguageCode): UiStrings {
  if (language === 'zh') {
    return {
      logoGitHubTitle: '在新窗口打开 Dominds 的 GitHub 仓库',
      backendWorkspaceTitle: '后端运行时工作区',
      backendWorkspaceLoading: '加载中…',
      loading: '加载中…',
      uiLanguageSelectTitle: '界面语言（也用于提示 agent 用该语言回复）',
      themeToggleTitle: '切换主题',
      problemsButtonTitle: '问题（Problems）',
      problemsTitle: '问题',
      problemsEmpty: '暂无问题',

      activityBarAriaLabel: '活动栏',
      activityRunning: '运行中',
      activityDone: '已完成',
      activityArchived: '已归档',
      activitySearch: '搜索',
      activityTeamMembers: '团队成员',
      activityTools: '工具',

      placeholderDoneTitle: '已完成',
      placeholderDoneText: '已完成对话的占位视图。',
      placeholderArchivedTitle: '已归档',
      placeholderArchivedText: '已归档对话的占位视图。',
      placeholderSearchTitle: '搜索',
      placeholderSearchText: '搜索面板占位视图。',
      placeholderTeamMembersTitle: '团队成员',
      placeholderTeamMembersText: '团队成员控制的占位视图。',
      placeholderToolsTitle: '工具',
      placeholderToolsText: '按 toolset 分组展示当前已注册工具。',

      newDialogTitle: '新建对话',
      currentDialogPlaceholder: '👈 从选择或创建一个对话开始',

      previousRound: '上一轮',
      nextRound: '下一轮',

      reminders: '提醒',
      refreshReminders: '刷新提醒',
      noReminders: '没有提醒',
      close: '关闭',

      createNewDialogTitle: '创建新对话',
      cancel: '取消',
      createDialog: '创建对话',
      taskDocumentLabel: '差遣牒：',
      taskDocumentPlaceholder: '输入以搜索差遣牒…',
      taskDocumentHelp:
        '从已有文档中选择，或输入自定义路径。必填项。Tab 补全公共前缀；Enter 选择高亮项。',
      teammateLabel: '队友：',
      shadowMembersOption: '影子成员…',
      shadowMembersLabel: '影子成员：',
      shadowMembersSelectRequired: '请选择影子成员。',
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
      teamMembersRefresh: '刷新',
      teamMembersSearchPlaceholder: '搜索名称、@id、provider、model…',
      teamMembersShowHidden: '显示隐藏成员',
      teamMembersVisibleSection: '可见',
      teamMembersHiddenSection: '隐藏',
      teamMembersDefaultBadge: '默认',
      teamMembersHiddenBadge: '隐藏',
      teamMembersMention: '插入 @mention',
      teamMembersCopyMention: '复制 @mention',
      teamMembersCopiedPrefix: '已复制：',
      teamMembersCopyFailedPrefix: '复制失败：',
      teamMembersUnknownProvider: '未知 provider',
      teamMembersUnknownModel: '未知 model',
      teamMembersProviderLabel: 'Provider',
      teamMembersModelLabel: 'Model',
      teamMembersStreamingLabel: 'Streaming',
      teamMembersSpecializesLabel: '擅长',
      teamMembersToolsetsLabel: 'Toolsets',
      teamMembersToolsLabel: 'Tools',
      teamMembersYes: '是',
      teamMembersNo: '否',
      teamMembersNoMatches: '没有匹配结果',
      teamMembersNoMatchesHint: '尝试更换关键词，或启用“显示隐藏成员”。',

      toolsTitle: '工具',
      toolsEmpty: '暂无工具',
      toolsRefresh: '刷新',
      toolsSectionFunction: '函数工具',

      daemonLabel: '守护进程',
      commandLabel: '命令',
      unknownCommand: '未知命令',

      setupTitle: '设置',
      setupRefresh: '刷新',
      setupGoToApp: '进入主界面',
      setupLoadingStatus: '正在加载设置状态…',
      setupAuthenticationTitle: '认证',
      setupAuthRejected: '认证被拒绝，请重试。',
      setupAuthRequired: '需要认证才能访问设置页。',
      setupWriteTeamYamlCreate: '创建 team.yaml',
      setupWriteTeamYamlOverwrite: '覆盖 team.yaml',
      setupProvidersTitle: 'Providers（来自 defaults.yaml）',
      setupProvidersHelp: '先配置 provider 的环境变量（必要时写入 shell rc），再使用该 provider。',
      setupViewDefaultsYaml: '查看 defaults.yaml',
      setupViewWorkspaceLlmYaml: '查看 .minds/llm.yaml',
      setupTeamTitle: '团队配置',
      setupTeamFileLabel: '文件',
      setupTeamProviderLabel: 'member_defaults.provider',
      setupTeamModelLabel: 'member_defaults.model',
      setupTeamAfterWriteHint: '写入/更新文件后点刷新；当配置有效时，“进入主界面”按钮会启用。',
      setupSummaryReady: '已就绪',
      setupSummaryRequired: '需要设置',
      setupSummaryShell: 'Shell',
      setupSummaryDefaultRc: '默认 rc',
      setupProviderApiKeys: 'API Keys',
      setupProviderDocs: '文档',
      setupProviderBaseUrl: 'Base URL',
      setupProviderEnvVar: '环境变量',
      setupProviderEnvVarSet: '已设置',
      setupProviderEnvVarMissing: '缺失',
      setupProviderModelsHint: '模型（verified = 环境变量存在）：',
      setupWriteRcWrite: '写入',
      setupWriteRcOverwrite: '覆盖',
      setupFileModalLoading: '加载中…',
      setupFileModalSelectToCopy: '可直接选择复制，或点击“复制”按钮。',
      setupFileModalCopy: '复制',
      setupSelectProviderModelFirst: '请先选择 provider 与 model。',
      setupReqMissingTeamYaml: '缺少 team.yaml（请先创建并设置 member_defaults.provider/model）。',
      setupReqInvalidTeamYaml: 'team.yaml 无效：',
      setupReqMissingDefaultsFields: 'team.yaml 缺少字段：',
      setupReqUnknownProvider: '未知 provider：',
      setupReqUnknownModel: '未知 model：',
      setupReqMissingProviderEnv: '缺少环境变量：',
      setupReqOk: 'team provider/model 与环境变量已就绪。',
    };
  }

  return {
    logoGitHubTitle: 'Open Dominds on GitHub (new window)',
    backendWorkspaceTitle: 'Backend Runtime Workspace',
    backendWorkspaceLoading: 'Loading...',
    loading: 'Loading...',
    uiLanguageSelectTitle: 'UI language (also used to prompt agent replies)',
    themeToggleTitle: 'Switch theme',
    problemsButtonTitle: 'Problems',
    problemsTitle: 'Problems',
    problemsEmpty: 'No problems',

    activityBarAriaLabel: 'Activity Bar',
    activityRunning: 'Running',
    activityDone: 'Done',
    activityArchived: 'Archived',
    activitySearch: 'Search',
    activityTeamMembers: 'Team Members',
    activityTools: 'Tools',

    placeholderDoneTitle: 'Done',
    placeholderDoneText: 'Placeholder view for completed dialogs.',
    placeholderArchivedTitle: 'Archived',
    placeholderArchivedText: 'Placeholder view for archived dialogs.',
    placeholderSearchTitle: 'Search',
    placeholderSearchText: 'Search panel placeholder.',
    placeholderTeamMembersTitle: 'Team Members',
    placeholderTeamMembersText: 'Placeholder view for team member controls.',
    placeholderToolsTitle: 'Tools',
    placeholderToolsText: 'Currently registered tools, grouped by toolset.',

    newDialogTitle: 'New Dialog',
    currentDialogPlaceholder: '👈 Select or create a dialog to start',

    previousRound: 'Previous Round',
    nextRound: 'Next Round',

    reminders: 'Reminders',
    refreshReminders: 'Refresh Reminders',
    noReminders: 'No reminders',
    close: 'Close',

    createNewDialogTitle: 'Create New Dialog',
    cancel: 'Cancel',
    createDialog: 'Create Dialog',
    taskDocumentLabel: 'Task Doc:',
    taskDocumentPlaceholder: 'Type to search Task Docs (*.tsk required)...',
    taskDocumentHelp:
      'Select from existing Task Docs or enter a custom path. Required format: `*.tsk/` (encapsulated Task Docs). Tab completes common prefix; Enter selects highlighted item.',
    teammateLabel: 'Teammate:',
    shadowMembersOption: 'Shadow Members…',
    shadowMembersLabel: 'Shadow Members:',
    shadowMembersSelectRequired: 'Please select a shadow member.',
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
    teamMembersRefresh: 'Refresh',
    teamMembersSearchPlaceholder: 'Search name, @id, provider, model…',
    teamMembersShowHidden: 'Show hidden members',
    teamMembersVisibleSection: 'Visible',
    teamMembersHiddenSection: 'Hidden',
    teamMembersDefaultBadge: 'Default',
    teamMembersHiddenBadge: 'Hidden',
    teamMembersMention: 'Insert @mention',
    teamMembersCopyMention: 'Copy @mention',
    teamMembersCopiedPrefix: 'Copied: ',
    teamMembersCopyFailedPrefix: 'Copy failed: ',
    teamMembersUnknownProvider: 'Unknown provider',
    teamMembersUnknownModel: 'Unknown model',
    teamMembersProviderLabel: 'Provider',
    teamMembersModelLabel: 'Model',
    teamMembersStreamingLabel: 'Streaming',
    teamMembersSpecializesLabel: 'Specializes',
    teamMembersToolsetsLabel: 'Toolsets',
    teamMembersToolsLabel: 'Tools',
    teamMembersYes: 'Yes',
    teamMembersNo: 'No',
    teamMembersNoMatches: 'No matches',
    teamMembersNoMatchesHint: 'Try a different query, or enable “Show hidden members”.',

    toolsTitle: 'Tools',
    toolsEmpty: 'No tools',
    toolsRefresh: 'Refresh',
    toolsSectionFunction: 'Function Tools',

    daemonLabel: 'Daemon',
    commandLabel: 'Command',
    unknownCommand: 'unknown command',

    setupTitle: 'Setup',
    setupRefresh: 'Refresh',
    setupGoToApp: 'Go to App',
    setupLoadingStatus: 'Loading setup status…',
    setupAuthenticationTitle: 'Authentication',
    setupAuthRejected: 'Auth rejected. Please try again.',
    setupAuthRequired: 'Auth required to access setup.',
    setupWriteTeamYamlCreate: 'Create team.yaml',
    setupWriteTeamYamlOverwrite: 'Overwrite team.yaml',
    setupProvidersTitle: 'Providers (from defaults.yaml)',
    setupProvidersHelp:
      'Set the provider env var (and persist to your shell rc) before using the provider.',
    setupViewDefaultsYaml: 'View defaults.yaml',
    setupViewWorkspaceLlmYaml: 'View .minds/llm.yaml',
    setupTeamTitle: 'Team Configuration',
    setupTeamFileLabel: 'File',
    setupTeamProviderLabel: 'member_defaults.provider',
    setupTeamModelLabel: 'member_defaults.model',
    setupTeamAfterWriteHint:
      'After writing/updating the file, click Refresh. “Go to App” enables when setup is valid.',
    setupSummaryReady: 'Ready',
    setupSummaryRequired: 'Setup Required',
    setupSummaryShell: 'Shell',
    setupSummaryDefaultRc: 'Default rc',
    setupProviderApiKeys: 'API keys',
    setupProviderDocs: 'Docs',
    setupProviderBaseUrl: 'Base URL',
    setupProviderEnvVar: 'Env var',
    setupProviderEnvVarSet: 'set',
    setupProviderEnvVarMissing: 'missing',
    setupProviderModelsHint: 'Models (verified = env var present):',
    setupWriteRcWrite: 'Write',
    setupWriteRcOverwrite: 'Overwrite',
    setupFileModalLoading: 'Loading…',
    setupFileModalSelectToCopy: 'Select to copy, or use the Copy button.',
    setupFileModalCopy: 'Copy',
    setupSelectProviderModelFirst: 'Please select a provider and model first.',
    setupReqMissingTeamYaml:
      'Missing team.yaml (create it and set member_defaults.provider/model).',
    setupReqInvalidTeamYaml: 'Invalid team.yaml: ',
    setupReqMissingDefaultsFields: 'team.yaml missing: ',
    setupReqUnknownProvider: 'Unknown provider: ',
    setupReqUnknownModel: 'Unknown model: ',
    setupReqMissingProviderEnv: 'Missing env var: ',
    setupReqOk: 'Team provider/model and provider env var look configured.',
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

export type ContextUsageTitleArgs =
  | { kind: 'unknown' }
  | {
      kind: 'known';
      promptTokens: number;
      hardPercentText: string;
      modelContextLimitTokens: number;
      overOptimal: boolean;
    };

export function formatContextUsageTitle(
  language: LanguageCode,
  args: ContextUsageTitleArgs,
): string {
  switch (language) {
    case 'zh': {
      switch (args.kind) {
        case 'unknown':
          return '上下文占用：未知';
        case 'known': {
          const suffix = args.overOptimal ? ' • 超过最佳值' : '';
          return `上下文占用：${args.promptTokens}（${args.hardPercentText} / ${args.modelContextLimitTokens}）${suffix}`;
        }
        default: {
          const _exhaustive: never = args;
          throw new Error(`Unhandled ContextUsageTitleArgs: ${_exhaustive}`);
        }
      }
    }
    case 'en': {
      switch (args.kind) {
        case 'unknown':
          return 'Context usage: unknown';
        case 'known': {
          const suffix = args.overOptimal ? ' • over optimal' : '';
          return `Context usage: ${args.promptTokens} (${args.hardPercentText} of ${args.modelContextLimitTokens})${suffix}`;
        }
        default: {
          const _exhaustive: never = args;
          throw new Error(`Unhandled ContextUsageTitleArgs: ${_exhaustive}`);
        }
      }
    }
    default: {
      const _exhaustive: never = language;
      throw new Error(`Unhandled LanguageCode: ${_exhaustive}`);
    }
  }
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
