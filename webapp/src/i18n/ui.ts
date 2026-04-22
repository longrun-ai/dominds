import { formatLanguageName, type LanguageCode } from '@longrun-ai/kernel/types/language';

export type UiStrings = {
  logoGitHubTitle: string;
  backendWorkspaceTitle: string;
  backendWorkspaceLoading: string;
  domindsVersionTitle: string;
  domindsVersionUpdateLabel: string;
  domindsVersionRestartLabel: string;
  domindsVersionInstallingLabel: string;
  domindsVersionRestartingLabel: string;
  domindsVersionUpdateAvailableTitle: string;
  domindsVersionRestartAvailableTitle: string;
  domindsVersionInstallConfirm: string;
  domindsVersionRestartConfirm: string;
  domindsVersionInstallSuccess: string;
  domindsVersionInstallInProgress: string;
  domindsVersionRestartScheduled: string;
  domindsVersionRestartInProgress: string;
  domindsVersionActionFailedPrefix: string;
  loading: string;
  uiLanguageSelectTitle: string;
  themeToggleTitle: string;
  problemsButtonTitle: string;
  problemsTitle: string;
  problemsEmpty: string;
  problemsClearResolvedTitle: string;
  problemsClearResolvedDonePrefix: string;
  problemsResolvedBadge: string;
  problemsActiveBadge: string;

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

  previousCourse: string;
  nextCourse: string;
  scrollToBottom: string;

  reminders: string;
  refreshReminders: string;
  noReminders: string;
  numberedReminders: string;
  virtualReminders: string;
  close: string;

  createNewDialogTitle: string;
  cancel: string;
  createDialog: string;
  createDialogCreating: string;
  taskDocumentLabel: string;
  taskDocumentPlaceholder: string;
  taskDocumentHelp: string;
  taskDocumentNoMatches: string;
  teammateLabel: string;
  shadowMembersOption: string;
  shadowMembersLabel: string;
  shadowMembersSelectRequired: string;
  defaultMarker: string;
  primingScriptsLabel: string;
  primingRecentSelectPlaceholder: string;
  primingNoneOption: string;
  primingMoreOption: string;
  primingSearchPlaceholder: string;
  primingNoMatches: string;
  primingNoScripts: string;
  primingShowInUiLabel: string;
  primingHelpText: string;
  primingSelectedScriptsLabel: string;
  primingAddScriptAction: string;
  primingRemoveScriptLabel: string;
  primingScopeTeamShared: string;
  primingScopeIndividual: string;
  primingLoadFailedToastPrefix: string;
  primingInvalidScriptsSkippedToastPrefix: string;
  primingInvalidScriptsSkippedToastMiddle: string;
  primingSaveButtonLabel: string;
  primingSaveButtonTitle: string;
  primingSavePrompt: string;
  primingSaveNoDialogToast: string;
  primingSaveSlugRequiredToast: string;
  primingSaveOverwriteConfirm: string;
  primingSaveSuccessToastPrefix: string;
  primingSaveFailedToastPrefix: string;

  newDialogLoadingTeam: string;
  newDialogNoTeamMembers: string;
  newDialogTeamLoadFailed: string;

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
  deadDialogInputDisabled: string;
  declareDeath: string;
  declareDeathConfirm: string;
  declareDeathConfirmSessionless: string;
  declareDeathConfirmFbr: string;

  q4hNoPending: string;
  q4hPendingQuestions: string;
  q4hInputPlaceholder: string;
  q4hEnterToSendTitle: string;
  q4hCtrlEnterToSendTitle: string;
  q4hEnterToQueueNowTitle: string;
  q4hCtrlEnterToQueueNowTitle: string;
  q4hEnterToStopTitle: string;
  q4hCtrlEnterToStopTitle: string;
  q4hGoToCallSiteTitle: string;
  q4hAnswerCallSitesLabel: string;
  q4hOpenInNewTabTitle: string;
  q4hCopyLinkTitle: string;
  forkDialogTitle: string;
  q4hInvalidDialogToast: string;
  q4hDeclareDeadOnlySideDialogToast: string;
  q4hDeclareDeadOnlyInterruptedToast: string;
  q4hActionFailedToast: string;
  q4hSelectedQuestionStaleToastPrefix: string;
  q4hMessageEmptyToast: string;
  q4hNoRoutableTargetToast: string;
  q4hConnectionUnavailableToast: string;
  q4hSendFailedToast: string;
  teammateAssignmentBubbleTitle: string;
  teammateRequesterCallSiteTitle: string;

  keepGoingTabTitle: string;
  keepGoingWorkspaceNote: string;
  keepGoingToggleAriaLabel: string;
  keepGoingReloadTitle: string;
  keepGoingSaveTitle: string;
  keepGoingResetTitle: string;
  keepGoingOverwriteConfirm: string;
  keepGoingResetConfirm: string;
  keepGoingResetConfirmDirty: string;
  keepGoingResetToast: string;
  keepGoingResetFailedToast: string;
  keepGoingSaveToast: string;
  keepGoingSaveFailedToast: string;
  keepGoingLanguageChangedDirtyToast: string;

  inputNotAvailableToast: string;
  noActiveDialogToast: string;
  emergencyStopNoProceedingToast: string;
  resumeAllNoResumableToast: string;
  resumeDialogNotResumableToast: string;
  resumeRejectedResumptionPanelSummary: string;
  resumeRejectedResumptionPanelWaitingSideDialogs: string;
  resumeRejectedResumptionPanelNeedsHumanInput: string;
  resumeRejectedResumptionPanelNeedsHumanInputAndSideDialogs: string;
  resumeRejectedResumptionPanelIdleWaitingUser: string;
  resumeRejectedResumptionPanelAlreadyRunning: string;
  resumeRejectedResumptionPanelStoppedNotResumable: string;
  resumeRejectedResumptionPanelDead: string;
  retryCountdownPrefix: string;
  retryCountdownSuffix: string;
  invalidMessageFormatToast: string;
  linkCopiedToast: string;
  linkCopyFailedToast: string;
  forkDialogFailedToast: string;
  toastDefaultNotice: string;
  dialogCreatedToastPrefix: string;
  dialogLoadedToast: string;
  dialogStatusUnavailableToast: string;
  dialogUnavailableRemovedPrefix: string;
  deepLinkDialogNotFoundPrefix: string;
  deepLinkDialogLoadFailedPrefix: string;
  dialogDeleteFailedToast: string;
  moveDialogsFailedToast: string;
  movedDialogsToastPrefix: string;
  dialogQuarantinedToast: string;
  reminderConnectionIssueToast: string;
  reminderSyncIssueToast: string;
  unknownStreamErrorToast: string;
  teammateCallFailedToast: string;
  unknownError: string;
  toastHistoryButtonTitle: string;
  toastHistoryTitle: string;
  toastHistoryClearTitle: string;
  toastHistoryEmpty: string;
  thinkingSectionTitle: string;
  teamMgmtManualTabTitle: string;
  snippetsTabTitle: string;
  domindsDocsTabTitle: string;
  teamMgmtTopicsTitle: string;
  teamMgmtLoadFailed: string;

  snippetsBuiltinTitle: string;
  snippetsWorkspaceTitle: string;
  snippetsInsert: string;
  snippetsNewTitle: string;
  snippetsEditorTitle: string;
  snippetsFileNameLabel: string;
  snippetsNameLabel: string;
  snippetsDescriptionLabel: string;
  snippetsContentLabel: string;
  snippetsSave: string;
  snippetsSaveFailed: string;
  snippetsLoadFailed: string;
  unauthorized: string;
  save: string;
  send: string;
  queueNow: string;
  stop: string;
  stopping: string;
  emergencyStop: string;
  resumeAll: string;
  continueLabel: string;
  resumptionPanelTitle: string;

  stoppedByYou: string;
  stoppedByEmergencyStop: string;
  interruptedByServerRestart: string;
  pendingCourseStartReady: string;
  forkContinueReady: string;
  runMarkerResumed: string;
  runMarkerInterrupted: string;
  runBadgeInterruptedTitle: string;
  runBadgeStoppedTitle: string;
  runBadgeRunningTitle: string;
  runBadgeWaitingHumanTitle: string;
  runBadgeWaitingSideDialogsTitle: string;
  runBadgeWaitingFbrTitle: string;

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
  teamMembersNogoLabel: string;
  teamMembersToolsetsLabel: string;
  teamMembersToolsLabel: string;
  teamMembersYes: string;
  teamMembersNo: string;
  teamMembersNoMatches: string;
  teamMembersNoMatchesHint: string;

  toolsTitle: string;
  toolsEmpty: string;
  toolsRefresh: string;
  toolsStatusWarningPrefix: string;
  toolsGroupDirect: string;
  toolsGroupDominds: string;
  toolsGroupApps: string;
  toolsGroupMcp: string;
  toolsSectionFunction: string;

  daemonLabel: string;
  commandLabel: string;
  unknownCommand: string;
  dialogReminderScope: string;
  personalReminderScope: string;
  sharedReminderScope: string;

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
  setupProvidersGroupConfigured: string;
  setupProvidersGroupUnconfigured: string;
  setupViewWorkspaceLlmYaml: string;
  setupViewBuiltinProvidersExample: string;
  setupWorkspaceLlmTitle: string;
  setupWorkspaceLlmHelp: string;
  setupWriteWorkspaceLlmYaml: string;
  setupOverwriteWorkspaceLlmYaml: string;
  setupWorkspaceLlmTextareaPlaceholder: string;
  setupWorkspaceLlmWriteSuccessPrefix: string;
  setupWorkspaceLlmContentRequired: string;
  setupWorkspaceLlmWriteFailed: string;
  setupMemberDefaultsTitle: string;
  setupModelParamsTitle: string;
  setupOverwriteConfirmTitle: string;
  setupOverwriteConfirmBody: string;
  setupOverwriteConfirmCancel: string;
  setupOverwriteConfirmConfirm: string;
  setupTeamTitle: string;
  setupTeamFileLabel: string;
  setupTeamProviderLabel: string;
  setupTeamModelLabel: string;
  setupTeamAfterWriteHint: string;
  setupSummaryReady: string;
  setupSummaryRequired: string;
  setupSummaryShell: string;
  setupSummaryEnvLocal: string;
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
  setupSelectProminentModelParamsFirst: string;
  setupProminentModelParamUnset: string;
  setupTeamModelParamsHint: string;
  setupReqMissingTeamYaml: string;
  setupReqInvalidTeamYaml: string;
  setupReqMissingDefaultsFields: string;
  setupReqUnknownProvider: string;
  setupReqUnknownModel: string;
  setupReqMissingProviderEnv: string;
  setupReqOk: string;

  webSearchTitle: string;
  webSearchProgressPrefix: string;
  webSearchStatusPrefix: string;
  webSearchPhaseStarted: string;
  webSearchPhaseDone: string;
  webSearchNoDetails: string;
};

export function getUiStrings(language: LanguageCode): UiStrings {
  if (language === 'zh') {
    return {
      logoGitHubTitle: '在新窗口打开 Dominds 的 GitHub 仓库',
      backendWorkspaceTitle: '后端运行时工作区',
      backendWorkspaceLoading: '加载中…',
      domindsVersionTitle: 'Dominds 版本',
      domindsVersionUpdateLabel: '更新',
      domindsVersionRestartLabel: '重启',
      domindsVersionInstallingLabel: '安装中',
      domindsVersionRestartingLabel: '重启中',
      domindsVersionUpdateAvailableTitle: '发现新版本，点击安装',
      domindsVersionRestartAvailableTitle: '新版本已就绪，点击重启',
      domindsVersionInstallConfirm:
        '检测到 npm registry 上有新版 Dominds。\n\n当前: v<current>\n最新: v<latest>\n\n现在安装并在完成后等待重启吗？',
      domindsVersionRestartConfirm:
        '将以最新可用版本重启 Dominds 后台。\n\n当前: v<current>\n目标: v<latest>\n\n是否继续？',
      domindsVersionInstallSuccess: '最新版 Dominds 已安装完成，请点击重启。',
      domindsVersionInstallInProgress: '后端正在安装……',
      domindsVersionRestartScheduled: 'Dominds 后台正在重启…',
      domindsVersionRestartInProgress: '后端正在重启，若页面没有自动刷新，可手动刷新看看。',
      domindsVersionActionFailedPrefix: 'Dominds 更新失败：',
      loading: '加载中…',
      uiLanguageSelectTitle: '界面语言（也用于提示 agent 用该语言回复）',
      themeToggleTitle: '切换主题',
      problemsButtonTitle: '问题（Problems）',
      problemsTitle: '问题',
      problemsEmpty: '暂无问题',
      problemsClearResolvedTitle: '清理已解决问题',
      problemsClearResolvedDonePrefix: '已清理已解决问题数量：',
      problemsResolvedBadge: '已解决',
      problemsActiveBadge: '进行中',

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
      currentDialogPlaceholder: '👈 从选择或创建一个对话开始',

      previousCourse: '上一程',
      nextCourse: '下一程',
      scrollToBottom: '回到最新（恢复自动跟随）',

      reminders: '提醒',
      refreshReminders: '刷新提醒',
      noReminders: '没有提醒',
      numberedReminders: '编号提醒',
      virtualReminders: '虚拟提醒',
      close: '关闭',

      createNewDialogTitle: '创建新对话',
      cancel: '取消',
      createDialog: '创建对话',
      createDialogCreating: '创建中…',
      taskDocumentLabel: '差遣牒：',
      taskDocumentPlaceholder: '输入以搜索差遣牒（留空则默认 socializing.tsk）…',
      taskDocumentHelp:
        '从已有文档中选择，或输入自定义路径。留空则默认 socializing.tsk。Tab 补全公共前缀；Enter 选择高亮项。',
      taskDocumentNoMatches: '没有匹配的差遣牒',
      teammateLabel: '队友：',
      shadowMembersOption: '影子成员…',
      shadowMembersLabel: '影子成员：',
      shadowMembersSelectRequired: '请选择影子成员。',
      defaultMarker: ' • 默认',
      primingScriptsLabel: '启动脚本：',
      primingRecentSelectPlaceholder: '选择最近脚本…',
      primingNoneOption: '<无>',
      primingMoreOption: '更多……',
      primingSearchPlaceholder: '搜索全部适用启动脚本（slug / title / ref）',
      primingNoMatches: '没有匹配的启动脚本',
      primingNoScripts: '没有可用启动脚本',
      primingShowInUiLabel: 'UI 展示',
      primingHelpText: '所选启动脚本会在创建时映射成历史对话并注入上下文。',
      primingSelectedScriptsLabel: '已选启动脚本',
      primingAddScriptAction: '选中',
      primingRemoveScriptLabel: '移除启动脚本',
      primingScopeTeamShared: '团队共享',
      primingScopeIndividual: '个人',
      primingLoadFailedToastPrefix: '加载启动脚本失败：',
      primingInvalidScriptsSkippedToastPrefix: '已跳过不可解析启动脚本（',
      primingInvalidScriptsSkippedToastMiddle: '个）：',
      primingSaveButtonLabel: '保存启动脚本',
      primingSaveButtonTitle: '将当前一程对话的历史保存为启动脚本',
      primingSavePrompt: '输入 slug（将保存到 .minds/priming/individual/<agent-id>/<slug>.md）：',
      primingSaveNoDialogToast: '当前没有可保存的对话。',
      primingSaveSlugRequiredToast: 'slug 不能为空。',
      primingSaveOverwriteConfirm: '启动脚本已存在（slug: <slug>）。是否覆盖？',
      primingSaveSuccessToastPrefix: '已保存启动脚本：',
      primingSaveFailedToastPrefix: '保存启动脚本失败：',

      newDialogLoadingTeam: '加载团队成员中…',
      newDialogNoTeamMembers: '没有可用的团队成员（请检查 team.yaml）',
      newDialogTeamLoadFailed: '加载团队成员失败',

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
      deadDialogInputDisabled: '此支线对话已宣布卡死（不可逆），输入已禁用。',
      declareDeath: '宣布卡死',
      declareDeathConfirm:
        '宣布此支线对话“卡死”？此操作不可逆转；诉请者对话将收到系统反馈并不再等待该支线对话。后续仍可重用相同 slug 发起全新支线，但此前上下文不再保留，新的诉请正文需提供最新完整上下文。',
      declareDeathConfirmSessionless:
        '宣布此一次性支线对话“卡死”？此操作不可逆转；诉请者对话将收到系统反馈并不再等待该支线对话。后续若仍需继续，请重新发起新的支线对话；由于不会续接此前上下文，新的诉请正文需提供最新完整上下文。',
      declareDeathConfirmFbr:
        '宣布此扪心自问（FBR）支线对话“卡死”？此操作不可逆转；诉请者对话将收到系统反馈并不再等待该支线对话。后续若仍需继续，请重新发起新的扪心自问（FBR）支线对话；由于不会续接此前上下文，新的诉请正文需提供最新完整上下文。',

      q4hNoPending: '暂无待处理问题',
      q4hPendingQuestions: '待处理问题',
      q4hInputPlaceholder: '输入你的回答…',
      q4hEnterToSendTitle: '按 Enter 发送\n- Shift+Enter 换行\n- Cmd/Ctrl+Enter 发送',
      q4hCtrlEnterToSendTitle: '按 Cmd/Ctrl+Enter 发送\n- Enter 换行\n- Shift+Enter 换行',
      q4hEnterToQueueNowTitle: '按 Enter 立即插队\n- Shift+Enter 换行\n- Cmd/Ctrl+Enter 立即插队',
      q4hCtrlEnterToQueueNowTitle: '按 Cmd/Ctrl+Enter 立即插队\n- Enter 换行\n- Shift+Enter 换行',
      q4hEnterToStopTitle: '按 Enter 停止',
      q4hCtrlEnterToStopTitle: '按 Cmd/Ctrl+Enter 停止',
      q4hGoToCallSiteTitle: '定位到提问点',
      q4hAnswerCallSitesLabel: '本次回答对应提问点：',
      q4hOpenInNewTabTitle: '新标签打开',
      q4hCopyLinkTitle: '复制链接',
      forkDialogTitle: 'Fork 对话',
      q4hInvalidDialogToast: '对话标识无效：selfId/rootId 必须是字符串。',
      q4hDeclareDeadOnlySideDialogToast: '只有支线对话支持“宣布卡死”。',
      q4hDeclareDeadOnlyInterruptedToast: '只有已停止且可继续的对话支持“宣布卡死”。',
      q4hActionFailedToast: '操作失败',
      q4hSelectedQuestionStaleToastPrefix: '已选问题已失效：',
      q4hMessageEmptyToast: '消息内容不能为空。',
      q4hNoRoutableTargetToast: '没有可路由的目标：请选择一个 Q4H 问题或活跃对话。',
      q4hConnectionUnavailableToast: '当前未连接到后端，消息尚未发送。',
      q4hSendFailedToast: '发送消息失败。',
      teammateAssignmentBubbleTitle: '定位到任务安排气泡',
      teammateRequesterCallSiteTitle: '在新标签打开诉请发起点',

      keepGoingTabTitle: '鞭策',
      keepGoingWorkspaceNote: '注意：修改鞭策语会影响整个 rtws（运行时工作区）！',
      keepGoingToggleAriaLabel: '启用鞭策（取消勾选=禁用）',
      keepGoingReloadTitle: '加载最新鞭策语',
      keepGoingSaveTitle: '保存到运行时工作区',
      keepGoingResetTitle: '重置为内置鞭策语（删除运行时工作区鞭策语文件）',
      keepGoingOverwriteConfirm: '将覆盖运行时工作区鞭策语，确认保存？',
      keepGoingResetConfirm: '将删除运行时工作区鞭策语文件，并恢复为系统内置鞭策语。确认重置？',
      keepGoingResetConfirmDirty:
        '你有未保存的修改。将删除运行时工作区鞭策语文件并丢弃未保存的修改。确认重置？',
      keepGoingResetToast: '已重置为内置鞭策语。',
      keepGoingResetFailedToast: '重置鞭策语失败',
      keepGoingSaveToast: '已保存到运行时工作区。',
      keepGoingSaveFailedToast: '保存鞭策语失败',
      keepGoingLanguageChangedDirtyToast:
        '界面语言已切换：当前鞭策内容有未保存修改，已跳过自动重载以免覆盖。请先保存或重置后再切换以刷新内容。',

      inputNotAvailableToast: '输入组件不可用。',
      noActiveDialogToast: '当前没有活跃对话。',
      emergencyStopNoProceedingToast: '当前没有进行中的对话，无法紧急停止。',
      resumeAllNoResumableToast: '当前没有可继续的已中断对话。',
      resumeDialogNotResumableToast:
        '已重新扫描对话真源：这个对话现在不能继续了。请先查看最新阻塞原因，或等待状态变化。',
      resumeRejectedResumptionPanelSummary:
        '已重新扫描对话真源：当前并不满足“继续”的条件。界面上刚才的恢复面板可能是过时投影；请先查看最新阻塞原因或等待状态变化。',
      resumeRejectedResumptionPanelWaitingSideDialogs:
        '已重新扫描对话真源：当前主线正在等待支线对话完成，因此现在不能继续。',
      resumeRejectedResumptionPanelNeedsHumanInput:
        '已重新扫描对话真源：当前主线正在等待人类输入，因此现在不能继续。',
      resumeRejectedResumptionPanelNeedsHumanInputAndSideDialogs:
        '已重新扫描对话真源：当前主线同时在等待人类输入和支线对话，因此现在不能继续。',
      resumeRejectedResumptionPanelIdleWaitingUser:
        '已重新扫描对话真源：这个对话已经不再处于可继续的中断态，当前是在等待新的用户输入。',
      resumeRejectedResumptionPanelAlreadyRunning:
        '已重新扫描对话真源：这个对话已经在运行中，无需再次点击继续。',
      resumeRejectedResumptionPanelStoppedNotResumable:
        '已重新扫描对话真源：这个对话虽然处于停止态，但当前停止原因不支持继续。',
      resumeRejectedResumptionPanelDead: '已重新扫描对话真源：这个对话已被宣布卡死，不能继续。',
      retryCountdownPrefix: '将在 ',
      retryCountdownSuffix: ' 后重试。',
      invalidMessageFormatToast: '收到无效消息格式，请刷新页面。',
      linkCopiedToast: '链接已复制。',
      linkCopyFailedToast: '复制链接失败。',
      forkDialogFailedToast: 'Fork 对话失败。',
      toastDefaultNotice: '通知',
      dialogCreatedToastPrefix: '已创建对话：',
      dialogLoadedToast: '对话加载成功。',
      dialogStatusUnavailableToast: '无法确定对话当前状态，请刷新列表后重试。',
      dialogUnavailableRemovedPrefix: '对话已不存在，已从当前界面移除：',
      deepLinkDialogNotFoundPrefix: '未找到深链对话：',
      deepLinkDialogLoadFailedPrefix: '加载深链对话失败：',
      dialogDeleteFailedToast: '删除对话失败',
      moveDialogsFailedToast: '移动对话失败',
      movedDialogsToastPrefix: '已移动对话数量：',
      dialogQuarantinedToast: '检测到对话持久记录损坏，已将该对话移入隔离区并从当前列表移除。',
      reminderConnectionIssueToast: '检测到连接问题，提醒数据可能暂时不可用。',
      reminderSyncIssueToast: '提醒同步出现问题。如问题持续，请刷新页面。',
      unknownStreamErrorToast: '未知流错误',
      teammateCallFailedToast: '队友调用失败',
      unknownError: '未知错误',
      toastHistoryButtonTitle: '通知历史',
      toastHistoryTitle: '通知历史',
      toastHistoryClearTitle: '清空通知历史',
      toastHistoryEmpty: '暂无通知。',
      thinkingSectionTitle: '思考中',
      teamMgmtManualTabTitle: '团队管理手册',
      snippetsTabTitle: '提示词模板',
      domindsDocsTabTitle: 'Dominds 文档',

      teamMgmtTopicsTitle: '主题',
      teamMgmtLoadFailed: '加载团队管理手册失败',

      snippetsBuiltinTitle: '内置模板',
      snippetsWorkspaceTitle: '运行时工作区模板（.minds/snippets/）',
      snippetsInsert: '插入',
      snippetsNewTitle: '新增模板',
      snippetsEditorTitle: '预览/编辑',
      snippetsFileNameLabel: '文件名（可选）',
      snippetsNameLabel: '名称',
      snippetsDescriptionLabel: '描述（可选）',
      snippetsContentLabel: '内容',
      snippetsSave: '保存',
      snippetsSaveFailed: '保存提示词模板失败',
      snippetsLoadFailed: '加载提示词模板失败',
      unauthorized: '未认证',
      save: '保存',
      send: '发送',
      queueNow: '立即插队',
      stop: '停止',
      stopping: '停止中…',
      emergencyStop: '紧急停止',
      resumeAll: '全部继续',
      continueLabel: '继续',
      resumptionPanelTitle: '恢复',

      stoppedByYou: '已由你停止',
      stoppedByEmergencyStop: '已被紧急停止终止',
      interruptedByServerRestart: '因服务器重启而中断',
      pendingCourseStartReady: '换程启动已就绪，可继续推进',
      forkContinueReady: '已创建继续分支，可继续推进',
      runMarkerResumed: '已继续',
      runMarkerInterrupted: '已停止',
      runBadgeInterruptedTitle: '对话已停止（可继续）',
      runBadgeStoppedTitle: '对话已停止',
      runBadgeRunningTitle: '正在运行',
      runBadgeWaitingHumanTitle: '等待你的输入（Q4H）',
      runBadgeWaitingSideDialogsTitle: '等待支线对话完成',
      runBadgeWaitingFbrTitle: '等待 FBR 收口',

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
      teamMembersSearchPlaceholder: '搜索名称、@id、提供商、模型…',
      teamMembersShowHidden: '显示隐藏成员',
      teamMembersVisibleSection: '可见',
      teamMembersHiddenSection: '隐藏',
      teamMembersDefaultBadge: '默认',
      teamMembersHiddenBadge: '隐藏',
      teamMembersMention: '插入 @mention',
      teamMembersCopyMention: '复制 @mention',
      teamMembersCopiedPrefix: '已复制：',
      teamMembersCopyFailedPrefix: '复制失败：',
      teamMembersUnknownProvider: '未知提供商',
      teamMembersUnknownModel: '未知 model',
      teamMembersProviderLabel: '提供商',
      teamMembersModelLabel: '模型',
      teamMembersStreamingLabel: '流式',
      teamMembersSpecializesLabel: '适合诉请',
      teamMembersNogoLabel: '不要诉请',
      teamMembersToolsetsLabel: '工具集',
      teamMembersToolsLabel: '工具',
      teamMembersYes: '是',
      teamMembersNo: '否',
      teamMembersNoMatches: '没有匹配结果',
      teamMembersNoMatchesHint: '尝试更换关键词，或启用“显示隐藏成员”。',

      toolsTitle: '工具',
      toolsEmpty: '暂无工具',
      toolsRefresh: '刷新',
      toolsStatusWarningPrefix: '工具可用性警告：',
      toolsGroupDirect: '直接工具',
      toolsGroupDominds: 'Dominds 工具',
      toolsGroupApps: 'Apps 工具',
      toolsGroupMcp: 'MCP 工具',
      toolsSectionFunction: '函数工具',

      daemonLabel: '守护进程',
      commandLabel: '命令',
      unknownCommand: '未知命令',
      dialogReminderScope: '对话范围提醒',
      personalReminderScope: '个人范围提醒',
      sharedReminderScope: '共享范围提醒',

      setupTitle: '设置',
      setupRefresh: '刷新',
      setupGoToApp: '进入主界面',
      setupLoadingStatus: '正在加载设置状态…',
      setupAuthenticationTitle: '认证',
      setupAuthRejected: '认证被拒绝，请重试。',
      setupAuthRequired: '需要认证才能访问设置页。',
      setupWriteTeamYamlCreate: '创建 team.yaml',
      setupWriteTeamYamlOverwrite: '覆盖 team.yaml',
      setupProvidersTitle: 'LLM 提供商',
      setupProvidersGroupConfigured: '已配置',
      setupProvidersGroupUnconfigured: '未配置',
      setupViewWorkspaceLlmYaml: '查看 .minds/llm.yaml',
      setupViewBuiltinProvidersExample: '查看内置配置示例',
      setupTeamTitle: '团队配置',
      setupTeamFileLabel: '文件',
      setupTeamProviderLabel: 'member_defaults.provider',
      setupTeamModelLabel: 'member_defaults.model',
      setupTeamAfterWriteHint: '写入/更新文件后点刷新；当配置有效时，“进入主界面”按钮会启用。',
      setupSummaryReady: '已就绪',
      setupSummaryRequired: '需要设置',
      setupSummaryShell: 'Shell',
      setupSummaryEnvLocal: '.env.local',
      setupSummaryDefaultRc: '默认 rc',
      setupProviderApiKeys: '管理鉴权信息（API Key）',
      setupProviderDocs: '访问模型文档',
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
      setupSelectProviderModelFirst: '请先选择提供商与模型。',
      setupSelectProminentModelParamsFirst: '请先为 prominent 模型参数选择取值。',
      setupProminentModelParamUnset: '留空（不设置）',
      setupTeamModelParamsHint: '',
      setupReqMissingTeamYaml: '缺少 team.yaml（请先创建并设置 member_defaults.provider/model）。',
      setupReqInvalidTeamYaml: 'team.yaml 无效：',
      setupReqMissingDefaultsFields: 'team.yaml 缺少字段：',
      setupReqUnknownProvider: '未知提供商：',
      setupReqUnknownModel: '未知 model：',
      setupReqMissingProviderEnv: '缺少环境变量：',
      setupReqOk: '提供商/模型与环境变量已就绪。',

      webSearchTitle: '联网搜索',
      webSearchProgressPrefix: '进展：',
      webSearchStatusPrefix: '状态：',
      webSearchPhaseStarted: '开始',
      webSearchPhaseDone: '完成',
      webSearchNoDetails: '无搜索细节',

      setupWorkspaceLlmTitle: '运行时工作区自定义 LLM 提供商',
      setupWorkspaceLlmHelp:
        '用于为当前运行时工作区新增/覆盖 providers（例如接入小米大模型平台）。写入后点刷新以重新计算 Providers 列表。',
      setupWriteWorkspaceLlmYaml: '写入 llm.yaml',
      setupOverwriteWorkspaceLlmYaml: '覆盖 llm.yaml',
      setupWorkspaceLlmTextareaPlaceholder:
        "# Example: Xiaomi MiMo\n# Tech spec: https://platform.xiaomimimo.com/#/docs/api/text-generation/anthropic-api\n# API keys: https://platform.xiaomimimo.com/\n\nproviders:\n  xiaomimimo.com:\n    name: Xiaomi MiMo\n    apiType: anthropic\n    baseUrl: https://api.xiaomimimo.com/anthropic\n    apiKeyEnvVar: MIMO_API_KEY\n    tech_spec_url: https://platform.xiaomimimo.com/#/docs/api/text-generation/anthropic-api\n    api_mgmt_url: https://platform.xiaomimimo.com/\n    models:\n      mimo-v2-flash:\n        name: MiMo V2 Flash\n        context_length: 262144\n        input_length: 262144\n        output_length: 262144\n        context_window: '256K'\n",
      setupWorkspaceLlmWriteSuccessPrefix: '已写入：',
      setupWorkspaceLlmContentRequired: '请先在文本框中填写 llm.yaml 内容。',
      setupWorkspaceLlmWriteFailed: '写入 .minds/llm.yaml 失败。',
      setupMemberDefaultsTitle: '默认成员设置',
      setupModelParamsTitle: '模型参数',
      setupOverwriteConfirmTitle: '确认覆盖？',
      setupOverwriteConfirmBody: '将覆盖 {path}，原有内容将丢失且不可恢复。',
      setupOverwriteConfirmCancel: '取消',
      setupOverwriteConfirmConfirm: '确认覆盖',
    };
  }

  return {
    logoGitHubTitle: 'Open Dominds on GitHub (new window)',
    backendWorkspaceTitle: 'Backend Runtime Workspace',
    backendWorkspaceLoading: 'Loading...',
    domindsVersionTitle: 'Dominds version',
    domindsVersionUpdateLabel: 'Update',
    domindsVersionRestartLabel: 'Restart',
    domindsVersionInstallingLabel: 'Installing',
    domindsVersionRestartingLabel: 'Restarting',
    domindsVersionUpdateAvailableTitle: 'A newer Dominds version is available. Click to install.',
    domindsVersionRestartAvailableTitle: 'The latest Dominds is ready. Click to restart.',
    domindsVersionInstallConfirm:
      'A newer Dominds version is available on npm registry.\n\nCurrent: v<current>\nLatest: v<latest>\n\nInstall it now and wait for restart?',
    domindsVersionRestartConfirm:
      'Dominds backend will restart into the latest available version.\n\nCurrent: v<current>\nTarget: v<latest>\n\nContinue?',
    domindsVersionInstallSuccess: 'Latest Dominds is installed. Click restart when ready.',
    domindsVersionInstallInProgress: 'Backend is installing…',
    domindsVersionRestartScheduled: 'Dominds backend is restarting…',
    domindsVersionRestartInProgress:
      'Backend is restarting. If the page does not refresh automatically, try a manual refresh.',
    domindsVersionActionFailedPrefix: 'Dominds update failed: ',
    loading: 'Loading…',
    uiLanguageSelectTitle: 'UI language (also used to prompt agent replies)',
    themeToggleTitle: 'Switch theme',
    problemsButtonTitle: 'Problems',
    problemsTitle: 'Problems',
    problemsEmpty: 'No problems',
    problemsClearResolvedTitle: 'Clear resolved problems',
    problemsClearResolvedDonePrefix: 'Cleared resolved problems: ',
    problemsResolvedBadge: 'Resolved',
    problemsActiveBadge: 'Active',

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
    currentDialogPlaceholder: '👈 Select or create a dialog to start',

    previousCourse: 'Previous Course',
    nextCourse: 'Next Course',
    scrollToBottom: 'Jump to latest (resume follow)',

    reminders: 'Reminders',
    refreshReminders: 'Refresh Reminders',
    noReminders: 'No reminders',
    numberedReminders: 'Numbered reminders',
    virtualReminders: 'Virtual reminders',
    close: 'Close',

    createNewDialogTitle: 'Create New Dialog',
    cancel: 'Cancel',
    createDialog: 'Create Dialog',
    createDialogCreating: 'Creating…',
    taskDocumentLabel: 'Taskdoc:',
    taskDocumentPlaceholder: 'Type to search Taskdocs (leave blank for socializing.tsk)…',
    taskDocumentHelp:
      'Select from existing Taskdocs or enter a custom path. Leave blank to use socializing.tsk. Tab completes common prefix; Enter selects highlighted item.',
    taskDocumentNoMatches: 'No matching Taskdocs found',
    teammateLabel: 'Teammate:',
    shadowMembersOption: 'Shadow Members…',
    shadowMembersLabel: 'Shadow Members:',
    shadowMembersSelectRequired: 'Please select a shadow member.',
    defaultMarker: ' • Default',
    primingScriptsLabel: 'Startup scripts:',
    primingRecentSelectPlaceholder: 'Pick from recent scripts…',
    primingNoneOption: '<None>',
    primingMoreOption: 'More…',
    primingSearchPlaceholder: 'Search all applicable startup scripts (slug / title / ref)',
    primingNoMatches: 'No matching startup scripts',
    primingNoScripts: 'No startup scripts available',
    primingShowInUiLabel: 'UI display',
    primingHelpText: 'Selected startup scripts are replayed as dialog history at creation time.',
    primingSelectedScriptsLabel: 'Selected startup scripts',
    primingAddScriptAction: 'Choose',
    primingRemoveScriptLabel: 'Remove startup script',
    primingScopeTeamShared: 'team shared',
    primingScopeIndividual: 'individual',
    primingLoadFailedToastPrefix: 'Failed to load startup scripts: ',
    primingInvalidScriptsSkippedToastPrefix: 'Skipped invalid startup scripts (',
    primingInvalidScriptsSkippedToastMiddle: '): ',
    primingSaveButtonLabel: 'Save startup script',
    primingSaveButtonTitle: 'Save current dialog course history as a startup script',
    primingSavePrompt:
      'Enter slug (it will be saved to .minds/priming/individual/<agent-id>/<slug>.md):',
    primingSaveNoDialogToast: 'No active dialog to save.',
    primingSaveSlugRequiredToast: 'Slug is required.',
    primingSaveOverwriteConfirm: 'Startup script already exists (slug: <slug>). Overwrite it?',
    primingSaveSuccessToastPrefix: 'Startup script saved: ',
    primingSaveFailedToastPrefix: 'Failed to save startup script: ',

    newDialogLoadingTeam: 'Loading team members…',
    newDialogNoTeamMembers: 'No team members available (check team.yaml)',
    newDialogTeamLoadFailed: 'Failed to load team members',

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
    deadDialogInputDisabled:
      'This Sideline dialog has been declared dead (irreversible); input is disabled.',
    declareDeath: 'Declare Death',
    declareDeathConfirm:
      'Declare this Sideline dialog as “dead”? This is irreversible; the requesting dialog will receive a system notice and stop waiting for it. You may still reuse the same slug to start a new Sideline dialog, but prior context will be gone, so include the latest full context in the new tellask body.',
    declareDeathConfirmSessionless:
      'Declare this one-shot Sideline dialog as “dead”? This is irreversible; the requesting dialog will receive a system notice and stop waiting for it. If the work is still needed later, start a new Sideline dialog. Prior context will not carry over, so include the latest full context in the new tellask body.',
    declareDeathConfirmFbr:
      'Declare this FBR Sideline dialog as “dead”? This is irreversible; the requesting dialog will receive a system notice and stop waiting for it. If the work is still needed later, start a new FBR Sideline dialog. Prior context will not carry over, so include the latest full context in the new tellask body.',

    q4hNoPending: 'No pending questions',
    q4hPendingQuestions: 'Pending Questions',
    q4hInputPlaceholder: 'Type your answer...',
    q4hEnterToSendTitle: 'Press Enter to send\n- Shift+Enter newline\n- Cmd/Ctrl+Enter send',
    q4hCtrlEnterToSendTitle: 'Press Cmd/Ctrl+Enter to send\n- Enter newline\n- Shift+Enter newline',
    q4hEnterToQueueNowTitle:
      'Press Enter to queue now\n- Shift+Enter newline\n- Cmd/Ctrl+Enter queue now',
    q4hCtrlEnterToQueueNowTitle:
      'Press Cmd/Ctrl+Enter to queue now\n- Enter newline\n- Shift+Enter newline',
    q4hEnterToStopTitle: 'Press Enter to stop',
    q4hCtrlEnterToStopTitle: 'Press Cmd/Ctrl+Enter to stop',
    q4hGoToCallSiteTitle: 'Go to call site',
    q4hAnswerCallSitesLabel: 'Answer applies to call sites:',
    q4hOpenInNewTabTitle: 'Open in new tab',
    q4hCopyLinkTitle: 'Copy link',
    forkDialogTitle: 'Fork dialog',
    q4hInvalidDialogToast: 'Invalid dialog id: selfId/rootId must be strings.',
    q4hDeclareDeadOnlySideDialogToast: 'Declare dead is available only for Sideline dialogs.',
    q4hDeclareDeadOnlyInterruptedToast:
      'Declare dead is available only when the dialog is stopped and resumable.',
    q4hActionFailedToast: 'Action failed',
    q4hSelectedQuestionStaleToastPrefix: 'Selected Q4H question is stale: ',
    q4hMessageEmptyToast: 'Message content is empty.',
    q4hNoRoutableTargetToast: 'No routable target: select a Q4H question or an active dialog.',
    q4hConnectionUnavailableToast: 'Not connected to the backend; the message was not sent.',
    q4hSendFailedToast: 'Failed to send message.',
    teammateAssignmentBubbleTitle: 'Go to assignment bubble',
    teammateRequesterCallSiteTitle: 'Open requester call site in new tab',

    keepGoingTabTitle: 'Diligence Push',
    keepGoingWorkspaceNote:
      'Note: editing the Diligence Push prompt affects the entire rtws (runtime workspace)!',
    keepGoingToggleAriaLabel: 'Enable Diligence Push (uncheck to disable)',
    keepGoingReloadTitle: 'Load latest Diligence Push prompt',
    keepGoingSaveTitle: 'Save to rtws',
    keepGoingResetTitle: 'Reset to built-in Diligence Push prompt (delete rtws file)',
    keepGoingOverwriteConfirm: 'This will overwrite the rtws Diligence Push prompt. Save anyway?',
    keepGoingResetConfirm:
      'This will delete the rtws Diligence Push prompt file and restore the built-in Diligence Push prompt. Reset anyway?',
    keepGoingResetConfirmDirty:
      'You have unsaved changes. This will delete the rtws Diligence Push prompt file and discard your edits. Reset anyway?',
    keepGoingResetToast: 'Reset to the built-in Diligence Push prompt.',
    keepGoingResetFailedToast: 'Failed to reset Diligence Push prompt',
    keepGoingSaveToast: 'Saved to rtws.',
    keepGoingSaveFailedToast: 'Failed to save Diligence Push prompt',
    keepGoingLanguageChangedDirtyToast:
      'UI language changed: the Diligence prompt has unsaved edits, so auto-reload was skipped to avoid overwriting. Save or reset, then switch again to refresh.',

    inputNotAvailableToast: 'Input is not available.',
    noActiveDialogToast: 'No active dialog.',
    emergencyStopNoProceedingToast: 'No proceeding dialogs to stop.',
    resumeAllNoResumableToast: 'No interrupted dialogs to resume.',
    resumeDialogNotResumableToast:
      'A fresh scan of the dialog facts shows this dialog is not resumable right now. Check the latest blocker or wait for the state to change.',
    resumeRejectedResumptionPanelSummary:
      'A fresh scan of the dialog facts shows it is not currently resumable. The resumption panel you just saw may have been stale; check the latest blocker or wait for the state to change.',
    resumeRejectedResumptionPanelWaitingSideDialogs:
      'A fresh scan of the dialog facts shows this Mainline dialog is waiting for Sideline dialogs, so it cannot resume yet.',
    resumeRejectedResumptionPanelNeedsHumanInput:
      'A fresh scan of the dialog facts shows this Mainline dialog is waiting for human input, so it cannot resume yet.',
    resumeRejectedResumptionPanelNeedsHumanInputAndSideDialogs:
      'A fresh scan of the dialog facts shows this Mainline dialog is waiting for both human input and Sideline dialogs, so it cannot resume yet.',
    resumeRejectedResumptionPanelIdleWaitingUser:
      'A fresh scan of the dialog facts shows this dialog is no longer interrupted and is now waiting for a new user input.',
    resumeRejectedResumptionPanelAlreadyRunning:
      'A fresh scan of the dialog facts shows this dialog is already running, so there is nothing to resume.',
    resumeRejectedResumptionPanelStoppedNotResumable:
      'A fresh scan of the dialog facts shows this dialog is stopped, but the current stop reason is not resumable.',
    resumeRejectedResumptionPanelDead:
      'A fresh scan of the dialog facts shows this dialog has been declared dead and cannot be resumed.',
    retryCountdownPrefix: 'Retrying in ',
    retryCountdownSuffix: '.',
    invalidMessageFormatToast: 'Received invalid message format. Please refresh the page.',
    linkCopiedToast: 'Link copied.',
    linkCopyFailedToast: 'Failed to copy link.',
    forkDialogFailedToast: 'Failed to fork dialog.',
    toastDefaultNotice: 'Notice',
    dialogCreatedToastPrefix: 'Dialog created:',
    dialogLoadedToast: 'Dialog loaded successfully.',
    dialogStatusUnavailableToast:
      'Unable to determine the current dialog status. Refresh the list and try again.',
    dialogUnavailableRemovedPrefix:
      'Dialog is no longer available and was removed from the current view:',
    deepLinkDialogNotFoundPrefix: 'Deep link dialog not found:',
    deepLinkDialogLoadFailedPrefix: 'Failed to load deep link dialog:',
    dialogDeleteFailedToast: 'Failed to delete dialog',
    moveDialogsFailedToast: 'Failed to move dialogs',
    movedDialogsToastPrefix: 'Moved dialog(s): ',
    dialogQuarantinedToast:
      'A dialog persistence record was found to be malformed. The dialog was quarantined and removed from the current list.',
    reminderConnectionIssueToast:
      'Connection issue detected. Reminder data may be temporarily unavailable.',
    reminderSyncIssueToast:
      'Reminder synchronization encountered an issue. Please refresh if problems persist.',
    unknownStreamErrorToast: 'Unknown stream error',
    teammateCallFailedToast: 'Teammate call failed',
    unknownError: 'Unknown error',
    toastHistoryButtonTitle: 'Notification history',
    toastHistoryTitle: 'Notification history',
    toastHistoryClearTitle: 'Clear notification history',
    toastHistoryEmpty: 'No notifications yet.',
    thinkingSectionTitle: 'Thinking',
    teamMgmtManualTabTitle: 'Team Manual',
    snippetsTabTitle: 'Snippets',
    domindsDocsTabTitle: 'Dominds Docs',

    teamMgmtTopicsTitle: 'Topics',
    teamMgmtLoadFailed: 'Failed to load team manual',

    snippetsBuiltinTitle: 'Built-in snippets',
    snippetsWorkspaceTitle: 'rtws snippets (.minds/snippets/)',
    snippetsInsert: 'Insert',
    snippetsNewTitle: 'New snippet',
    snippetsEditorTitle: 'Preview/Edit',
    snippetsFileNameLabel: 'File name (optional)',
    snippetsNameLabel: 'Name',
    snippetsDescriptionLabel: 'Description (optional)',
    snippetsContentLabel: 'Content',
    snippetsSave: 'Save',
    snippetsSaveFailed: 'Failed to save snippet',
    snippetsLoadFailed: 'Failed to load snippets',
    unauthorized: 'Unauthorized',
    save: 'Save',
    send: 'Send',
    queueNow: 'Queue now',
    stop: 'Stop',
    stopping: 'Stopping…',
    emergencyStop: 'Emergency stop',
    resumeAll: 'Resume all',
    continueLabel: 'Continue',
    resumptionPanelTitle: 'Resumption',

    stoppedByYou: 'Stopped by you',
    stoppedByEmergencyStop: 'Stopped by emergency stop',
    interruptedByServerRestart: 'Interrupted by server restart',
    pendingCourseStartReady: 'A new course is ready to continue',
    forkContinueReady: 'A continuation fork is ready to proceed',
    runMarkerResumed: 'Resumed',
    runMarkerInterrupted: 'Stopped',
    runBadgeInterruptedTitle: 'Stopped (resumable)',
    runBadgeStoppedTitle: 'Stopped',
    runBadgeRunningTitle: 'Running',
    runBadgeWaitingHumanTitle: 'Waiting for human input (Q4H)',
    runBadgeWaitingSideDialogsTitle: 'Waiting for Sideline dialogs',
    runBadgeWaitingFbrTitle: 'Waiting for FBR',

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
    teamMembersSpecializesLabel: 'Go for',
    teamMembersNogoLabel: 'Do not go for',
    teamMembersToolsetsLabel: 'Toolsets',
    teamMembersToolsLabel: 'Tools',
    teamMembersYes: 'Yes',
    teamMembersNo: 'No',
    teamMembersNoMatches: 'No matches',
    teamMembersNoMatchesHint: 'Try a different query, or enable “Show hidden members”.',

    toolsTitle: 'Tools',
    toolsEmpty: 'No tools',
    toolsRefresh: 'Refresh',
    toolsStatusWarningPrefix: 'Tool availability warning:',
    toolsGroupDirect: 'Direct Tools',
    toolsGroupDominds: 'Dominds Tools',
    toolsGroupApps: 'App Tools',
    toolsGroupMcp: 'MCP Tools',
    toolsSectionFunction: 'Function Tools',

    daemonLabel: 'Daemon',
    commandLabel: 'Command',
    unknownCommand: 'unknown command',
    dialogReminderScope: 'Dialog-scope reminder',
    personalReminderScope: 'Personal-scope reminder',
    sharedReminderScope: 'Shared-scope reminder',

    setupTitle: 'Setup',
    setupRefresh: 'Refresh',
    setupGoToApp: 'Go to App',
    setupLoadingStatus: 'Loading setup status…',
    setupAuthenticationTitle: 'Authentication',
    setupAuthRejected: 'Auth rejected. Please try again.',
    setupAuthRequired: 'Auth required to access setup.',
    setupWriteTeamYamlCreate: 'Create team.yaml',
    setupWriteTeamYamlOverwrite: 'Overwrite team.yaml',
    setupProvidersTitle: 'LLM providers',
    setupProvidersGroupConfigured: 'Configured',
    setupProvidersGroupUnconfigured: 'Unconfigured',
    setupViewWorkspaceLlmYaml: 'View .minds/llm.yaml',
    setupViewBuiltinProvidersExample: 'View built-in config example',
    setupTeamTitle: 'Team Configuration',
    setupTeamFileLabel: 'File',
    setupTeamProviderLabel: 'member_defaults.provider',
    setupTeamModelLabel: 'member_defaults.model',
    setupTeamAfterWriteHint:
      'After writing/updating the file, click Refresh. “Go to App” enables when setup is valid.',
    setupSummaryReady: 'Ready',
    setupSummaryRequired: 'Setup Required',
    setupSummaryShell: 'Shell',
    setupSummaryEnvLocal: '.env.local',
    setupSummaryDefaultRc: 'Default rc',
    setupProviderApiKeys: 'Manage auth (API Key)',
    setupProviderDocs: 'Open model docs',
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
    setupSelectProminentModelParamsFirst: 'Please select values for prominent model params first.',
    setupProminentModelParamUnset: 'Leave unset',
    setupTeamModelParamsHint: '',
    setupReqMissingTeamYaml:
      'Missing team.yaml (create it and set member_defaults.provider/model).',
    setupReqInvalidTeamYaml: 'Invalid team.yaml: ',
    setupReqMissingDefaultsFields: 'team.yaml missing: ',
    setupReqUnknownProvider: 'Unknown provider: ',
    setupReqUnknownModel: 'Unknown model: ',
    setupReqMissingProviderEnv: 'Missing env var: ',
    setupReqOk: 'Team provider/model and provider env var look configured.',

    webSearchTitle: 'Web Search',
    webSearchProgressPrefix: 'Progress: ',
    webSearchStatusPrefix: 'Status: ',
    webSearchPhaseStarted: 'started',
    webSearchPhaseDone: 'done',
    webSearchNoDetails: 'No search details',

    setupWorkspaceLlmTitle: 'rtws custom LLM providers',
    setupWorkspaceLlmHelp:
      'Add/override providers for this rtws (runtime workspace) (e.g. Xiaomi MiMo). After writing, click Refresh to recompute the Providers list.',
    setupWriteWorkspaceLlmYaml: 'Write llm.yaml',
    setupOverwriteWorkspaceLlmYaml: 'Overwrite llm.yaml',
    setupWorkspaceLlmTextareaPlaceholder:
      "# Example: Xiaomi MiMo\n# Tech spec: https://platform.xiaomimimo.com/#/docs/api/text-generation/anthropic-api\n# API keys: https://platform.xiaomimimo.com/\n\nproviders:\n  xiaomimimo.com:\n    name: Xiaomi MiMo\n    apiType: anthropic\n    baseUrl: https://api.xiaomimimo.com/anthropic\n    apiKeyEnvVar: MIMO_API_KEY\n    tech_spec_url: https://platform.xiaomimimo.com/#/docs/api/text-generation/anthropic-api\n    api_mgmt_url: https://platform.xiaomimimo.com/\n    models:\n      mimo-v2-flash:\n        name: MiMo V2 Flash\n        context_length: 262144\n        input_length: 262144\n        output_length: 262144\n        context_window: '256K'\n",
    setupWorkspaceLlmWriteSuccessPrefix: 'Wrote: ',
    setupWorkspaceLlmContentRequired: 'Please fill in the llm.yaml content first.',
    setupWorkspaceLlmWriteFailed: 'Failed to write .minds/llm.yaml.',
    setupMemberDefaultsTitle: 'Member defaults',
    setupModelParamsTitle: 'Model params',
    setupOverwriteConfirmTitle: 'Confirm overwrite?',
    setupOverwriteConfirmBody: 'This will overwrite {path}. Existing content will be lost.',
    setupOverwriteConfirmCancel: 'Cancel',
    setupOverwriteConfirmConfirm: 'Overwrite',
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
      modelContextWindowText?: string;
      level: 'healthy' | 'caution' | 'critical';
      optimalTokens: number;
      optimalPercentText: string;
      optimalConfigured: boolean;
      criticalTokens: number;
      criticalPercentText: string;
      criticalConfigured: boolean;
    };

function formatTokenCountCompact(tokens: number): string {
  if (!Number.isFinite(tokens)) return '∞';
  const n = Math.max(0, Math.floor(tokens));
  if (n < 1000) return String(n);

  if (n < 1_000_000) {
    const k = n / 1000;
    const text = k < 10 ? k.toFixed(1) : k.toFixed(0);
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}K`;
  }

  const m = n / 1_000_000;
  const text = m < 10 ? m.toFixed(1) : m.toFixed(0);
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}M`;
}

export function formatContextUsageTitle(
  language: LanguageCode,
  args: ContextUsageTitleArgs,
): string {
  switch (language) {
    case 'zh': {
      switch (args.kind) {
        case 'unknown':
          return '上下文情况：未知';
        case 'known': {
          const optimalSource = args.optimalConfigured ? '配置' : '默认';
          const criticalSource = args.criticalConfigured ? '配置' : '默认';
          const levelText =
            args.level === 'healthy' ? '充裕' : args.level === 'caution' ? '吃紧' : '告急';
          const limitText =
            typeof args.modelContextWindowText === 'string' &&
            args.modelContextWindowText.trim() !== ''
              ? args.modelContextWindowText.trim()
              : formatTokenCountCompact(args.modelContextLimitTokens);
          return [
            `上下文情况 • ${levelText}`,
            `输入：${formatTokenCountCompact(args.promptTokens)}（${args.hardPercentText}；上限 ${limitText}）`,
            `软线：${formatTokenCountCompact(args.optimalTokens)}（${args.optimalPercentText}；${optimalSource}）`,
            `红线：${formatTokenCountCompact(args.criticalTokens)}（${args.criticalPercentText}；${criticalSource}）`,
          ].join('\n');
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
          return 'Context status: unknown';
        case 'known': {
          const optimalSource = args.optimalConfigured ? 'config' : 'default';
          const criticalSource = args.criticalConfigured ? 'config' : 'default';
          const levelText =
            args.level === 'healthy'
              ? 'healthy'
              : args.level === 'caution'
                ? 'caution'
                : 'critical';
          const limitText =
            typeof args.modelContextWindowText === 'string' &&
            args.modelContextWindowText.trim() !== ''
              ? args.modelContextWindowText.trim()
              : formatTokenCountCompact(args.modelContextLimitTokens);
          return [
            `Context status • ${levelText}`,
            `Prompt: ${formatTokenCountCompact(args.promptTokens)} (${args.hardPercentText}; limit ${limitText})`,
            `Soft: ${formatTokenCountCompact(args.optimalTokens)} (${args.optimalPercentText}; ${optimalSource})`,
            `Critical: ${formatTokenCountCompact(args.criticalTokens)} (${args.criticalPercentText}; ${criticalSource})`,
          ].join('\n');
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
            `- 不影响：agent 的内部工作语言 / 系统提示 / 队友（支线对话）叙事格式。\n` +
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
            `- 不影响：内部工作语言仍为 ${serverName}（系统提示、队友/支线对话叙事格式、内部引导信息）。`
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
            `- Does NOT affect: the agent’s internal work language, system prompts, or teammate/Sideline dialog narrative formatting.\n` +
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
            `- Does NOT affect: internal work language remains ${serverName} (system prompts, teammate/Sideline dialog narrative formatting, internal guide messages).`
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
