/**
 * Shared team-mgmt manual topic definitions.
 *
 * This module is intentionally dependency-free so it can be imported by both:
 * - backend (`dominds/main/**`)
 * - frontend (`dominds/webapp/src/**`)
 *
 * It serves as the single source of truth for:
 * - valid `team_mgmt_manual({ topics: [...] })` topic tokens
 * - WebUI topic-button ordering + tool-arg mapping
 */

export const TEAM_MGMT_MANUAL_TOPIC_KEYS = [
  'topics',
  'llm',
  'model-params',
  'builtin-defaults',
  'mcp',
  'team',
  'member-properties',
  'minds',
  'env',
  'permissions',
  'toolsets',
  'troubleshooting',
] as const;

export type TeamMgmtManualTopicKey = (typeof TEAM_MGMT_MANUAL_TOPIC_KEYS)[number];

export type TeamMgmtManualLanguageCode = 'en' | 'zh';

export type TeamMgmtManualTopicMeta = Readonly<{
  titleI18n: Readonly<{ en: string; zh: string }>;
}>;

export const TEAM_MGMT_MANUAL_TOPIC_META: Readonly<
  Record<TeamMgmtManualTopicKey, TeamMgmtManualTopicMeta>
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
  env: { titleI18n: { zh: '环境提示（env.*.md）', en: 'Environment Intro (env.*.md)' } },
  troubleshooting: { titleI18n: { zh: '排障（troubleshooting）', en: 'Troubleshooting' } },
};

const TEAM_MGMT_MANUAL_TOPIC_KEY_SET: ReadonlySet<string> = new Set(
  TEAM_MGMT_MANUAL_TOPIC_KEYS as readonly string[],
);

export function isTeamMgmtManualTopicKey(value: string): value is TeamMgmtManualTopicKey {
  return TEAM_MGMT_MANUAL_TOPIC_KEY_SET.has(value);
}

export function getTeamMgmtManualTopicTitle(
  lang: TeamMgmtManualLanguageCode,
  key: TeamMgmtManualTopicKey,
): string {
  const meta = TEAM_MGMT_MANUAL_TOPIC_META[key];
  return lang === 'zh' ? meta.titleI18n.zh : meta.titleI18n.en;
}

// --- WebUI default topic ordering + tool-arg mapping ---

export const TEAM_MGMT_MANUAL_UI_TOPIC_ORDER: readonly TeamMgmtManualTopicKey[] = [
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
  'env',
  'troubleshooting',
];

export const TEAM_MGMT_MANUAL_UI_TOOL_TOPICS_BY_KEY: Readonly<
  Record<TeamMgmtManualTopicKey, readonly TeamMgmtManualTopicKey[]>
> = {
  // Index
  topics: ['topics'],
  // Team-related
  team: ['team'],
  'member-properties': ['team', 'member-properties'],
  // Permissions / toolsets
  permissions: ['permissions'],
  toolsets: ['toolsets'],
  // LLM-related
  llm: ['llm'],
  'model-params': ['llm', 'model-params'],
  'builtin-defaults': ['llm', 'builtin-defaults'],
  // Other
  mcp: ['mcp'],
  minds: ['minds'],
  env: ['env'],
  troubleshooting: ['troubleshooting'],
};

// --- WebUI topic buttons (DomindsTeamManualPanel) ---

export type TeamMgmtManualPanelTopicKey = 'index' | 'permissions' | 'team' | 'toolsets';

export const TEAM_MGMT_MANUAL_PANEL_TOPIC_ORDER: readonly TeamMgmtManualPanelTopicKey[] = [
  'index',
  'permissions',
  'team',
  'toolsets',
];

const EMPTY_TOOL_TOPICS: readonly TeamMgmtManualTopicKey[] = [];

export const TEAM_MGMT_MANUAL_PANEL_TOOL_TOPICS_BY_KEY: Readonly<
  Record<TeamMgmtManualPanelTopicKey, readonly TeamMgmtManualTopicKey[]>
> = {
  index: EMPTY_TOOL_TOPICS,
  permissions: ['permissions'],
  team: ['team'],
  toolsets: ['toolsets'],
};

export function isTeamMgmtManualPanelTopicKey(value: string): value is TeamMgmtManualPanelTopicKey {
  return Object.prototype.hasOwnProperty.call(TEAM_MGMT_MANUAL_PANEL_TOOL_TOPICS_BY_KEY, value);
}

export const TEAM_MGMT_MANUAL_PANEL_TOPIC_META: Readonly<
  Record<TeamMgmtManualPanelTopicKey, TeamMgmtManualTopicMeta>
> = {
  index: { titleI18n: { zh: '索引', en: 'Index' } },
  permissions: TEAM_MGMT_MANUAL_TOPIC_META.permissions,
  team: TEAM_MGMT_MANUAL_TOPIC_META.team,
  toolsets: TEAM_MGMT_MANUAL_TOPIC_META.toolsets,
};

export function getTeamMgmtManualPanelTopicTitle(
  lang: TeamMgmtManualLanguageCode,
  key: TeamMgmtManualPanelTopicKey,
): string {
  const meta = TEAM_MGMT_MANUAL_PANEL_TOPIC_META[key];
  return lang === 'zh' ? meta.titleI18n.zh : meta.titleI18n.en;
}
