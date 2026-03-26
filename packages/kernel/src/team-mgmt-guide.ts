export const TEAM_MGMT_GUIDE_TOPIC_KEYS = [
  'topics',
  'llm',
  'model-params',
  'builtin-defaults',
  'mcp',
  'team',
  'member-properties',
  'minds',
  'skills',
  'priming',
  'env',
  'permissions',
  'toolsets',
  'troubleshooting',
] as const;

export type TeamMgmtGuideTopicKey = (typeof TEAM_MGMT_GUIDE_TOPIC_KEYS)[number];
export type TeamMgmtGuideLanguageCode = 'en' | 'zh';

export type TeamMgmtGuideTopicMeta = Readonly<{
  titleI18n: Readonly<{ en: string; zh: string }>;
}>;

export const TEAM_MGMT_GUIDE_TOPIC_META: Readonly<
  Record<TeamMgmtGuideTopicKey, TeamMgmtGuideTopicMeta>
> = {
  topics: { titleI18n: { zh: '索引', en: 'Index' } },
  team: { titleI18n: { zh: 'Team（team.yaml）', en: 'Team (team.yaml)' } },
  'member-properties': {
    titleI18n: { zh: '成员字段（members.<id>）', en: 'Member Properties (members.<id>)' },
  },
  permissions: { titleI18n: { zh: '权限（permissions）', en: 'Permissions' } },
  toolsets: { titleI18n: { zh: '工具集（toolsets）', en: 'Toolsets' } },
  llm: { titleI18n: { zh: 'LLM（llm.yaml）', en: 'LLM (llm.yaml)' } },
  'builtin-defaults': { titleI18n: { zh: '内置 Defaults（LLM）', en: 'Built-in Defaults (LLM)' } },
  'model-params': {
    titleI18n: { zh: '模型参数（model_params）', en: 'Model Params (model_params)' },
  },
  mcp: { titleI18n: { zh: 'MCP（mcp.yaml）', en: 'MCP (mcp.yaml)' } },
  minds: {
    titleI18n: { zh: '角色资产（.minds/team/<id>/*）', en: 'Minds Assets (.minds/team/<id>/*)' },
  },
  skills: {
    titleI18n: { zh: '技能（.minds/skills/*）', en: 'Skills (.minds/skills/*)' },
  },
  priming: {
    titleI18n: {
      zh: '启动脚本（.minds/priming/*）',
      en: 'Startup Scripts (.minds/priming/*)',
    },
  },
  env: { titleI18n: { zh: '环境提示（env.*.md）', en: 'Environment Intro (env.*.md)' } },
  troubleshooting: { titleI18n: { zh: '排障（troubleshooting）', en: 'Troubleshooting' } },
};

const TEAM_MGMT_GUIDE_TOPIC_KEY_SET: ReadonlySet<string> = new Set(
  TEAM_MGMT_GUIDE_TOPIC_KEYS as readonly string[],
);

export function isTeamMgmtGuideTopicKey(value: string): value is TeamMgmtGuideTopicKey {
  return TEAM_MGMT_GUIDE_TOPIC_KEY_SET.has(value);
}

export function getTeamMgmtGuideTopicTitle(
  lang: TeamMgmtGuideLanguageCode,
  key: TeamMgmtGuideTopicKey,
): string {
  const meta = TEAM_MGMT_GUIDE_TOPIC_META[key];
  return lang === 'zh' ? meta.titleI18n.zh : meta.titleI18n.en;
}

export const TEAM_MGMT_GUIDE_UI_TOPIC_ORDER: readonly TeamMgmtGuideTopicKey[] = [
  'topics',
  'team',
  'member-properties',
  'permissions',
  'toolsets',
  'llm',
  'model-params',
  'builtin-defaults',
  'mcp',
  'minds',
  'skills',
  'priming',
  'env',
  'troubleshooting',
];

export const TEAM_MGMT_GUIDE_UI_TOOL_TOPICS_BY_KEY: Readonly<
  Record<TeamMgmtGuideTopicKey, readonly TeamMgmtGuideTopicKey[]>
> = {
  topics: ['topics'],
  team: ['team'],
  'member-properties': ['team', 'member-properties'],
  permissions: ['permissions'],
  toolsets: ['toolsets'],
  llm: ['llm'],
  'model-params': ['llm', 'model-params'],
  'builtin-defaults': ['llm', 'builtin-defaults'],
  mcp: ['mcp'],
  minds: ['minds'],
  skills: ['skills'],
  priming: ['priming'],
  env: ['env'],
  troubleshooting: ['troubleshooting'],
};

export type TeamMgmtGuidePanelTopicKey = 'index' | 'permissions' | 'team' | 'toolsets' | 'skills';

export const TEAM_MGMT_GUIDE_PANEL_TOPIC_ORDER: readonly TeamMgmtGuidePanelTopicKey[] = [
  'index',
  'permissions',
  'team',
  'toolsets',
  'skills',
];

const EMPTY_TOOL_TOPICS: readonly TeamMgmtGuideTopicKey[] = [];

export const TEAM_MGMT_GUIDE_PANEL_TOOL_TOPICS_BY_KEY: Readonly<
  Record<TeamMgmtGuidePanelTopicKey, readonly TeamMgmtGuideTopicKey[]>
> = {
  index: EMPTY_TOOL_TOPICS,
  permissions: ['permissions'],
  team: ['team'],
  toolsets: ['toolsets'],
  skills: ['skills'],
};

export function isTeamMgmtGuidePanelTopicKey(value: string): value is TeamMgmtGuidePanelTopicKey {
  return Object.prototype.hasOwnProperty.call(TEAM_MGMT_GUIDE_PANEL_TOOL_TOPICS_BY_KEY, value);
}

export const TEAM_MGMT_GUIDE_PANEL_TOPIC_META: Readonly<
  Record<TeamMgmtGuidePanelTopicKey, TeamMgmtGuideTopicMeta>
> = {
  index: { titleI18n: { zh: '索引', en: 'Index' } },
  permissions: TEAM_MGMT_GUIDE_TOPIC_META.permissions,
  team: TEAM_MGMT_GUIDE_TOPIC_META.team,
  toolsets: TEAM_MGMT_GUIDE_TOPIC_META.toolsets,
  skills: TEAM_MGMT_GUIDE_TOPIC_META.skills,
};

export function getTeamMgmtGuidePanelTopicTitle(
  lang: TeamMgmtGuideLanguageCode,
  key: TeamMgmtGuidePanelTopicKey,
): string {
  const meta = TEAM_MGMT_GUIDE_PANEL_TOPIC_META[key];
  return lang === 'zh' ? meta.titleI18n.zh : meta.titleI18n.en;
}
