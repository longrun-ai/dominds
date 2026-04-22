/**
 * Module: team
 *
 * Team configuration and member modeling:
 * - `Team` aggregating members and defaults
 * - YAML load/conversion helpers
 * - `Team.Member` with tool resolution and access fields
 */
import fs from 'fs/promises';
import YAML from 'yaml';

import type { ProblemI18nText, WorkspaceProblem } from '@longrun-ai/kernel/types/problems';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { loadEnabledAppsSnapshot } from './apps/enabled-apps';
import { listDynamicAppToolsetsForMember } from './apps/runtime';
import { loadEnabledAppTeammates, type AppTeammatesSnippet } from './apps/teammates';
import { LlmConfig } from './llm/client';
import { log } from './log';
import { parseMcpYaml } from './mcp/config';
import { reconcileProblemsByPrefix } from './problems';
import type { Tool } from './tool';
import { getTool, getToolset, getToolsetMeta, listToolsets } from './tools/registry';

export class Team {
  readonly memberDefaults: Team.Member;
  defaultResponder?: string;
  shellSpecialists: string[];
  readonly members: Record<string, Team.Member>;

  constructor(params: {
    memberDefaults?: Team.Member;
    defaultResponder?: string;
    shellSpecialists?: string[];
    members?: Record<string, Team.Member>;
  }) {
    this.memberDefaults =
      params.memberDefaults ||
      new Team.Member({
        id: 'defaulter',
        name: 'Defaulter',
      });
    this.defaultResponder = params.defaultResponder;
    this.shellSpecialists = params.shellSpecialists ?? [];
    this.members = params.members || {};
  }

  getDefaultResponder(): Team.Member | undefined {
    const explicit = this.getMember(this.defaultResponder);
    if (explicit) return explicit;
    // Fallback: pick the first visible member, else Fuxi, else any member.
    const all = Object.values(this.members);
    const visible = all.find((m) => m.hidden !== true);
    if (visible) return visible;
    const fuxi = this.getMember('fuxi');
    if (fuxi) return fuxi;
    return all.length > 0 ? all[0] : undefined;
  }

  getMember(id: string | undefined): Team.Member | undefined {
    if (!id) return undefined;
    return this.members[id];
  }
}

export namespace Team {
  const TEAM_YAML_PATH = '.minds/team.yaml';
  const TEAM_YAML_PROBLEM_PREFIX = 'team/team_yaml_error/';

  export type McpDeclaredToolsets =
    | { kind: 'missing' }
    | { kind: 'invalid'; errorText: string }
    | {
        kind: 'loaded';
        declaredServerIds: ReadonlySet<string>;
        invalidServerIds: ReadonlySet<string>;
      };

  export async function readMcpDeclaredToolsets(): Promise<McpDeclaredToolsets> {
    const mcpPath = '.minds/mcp.yaml';
    let raw: string;
    try {
      raw = await fs.readFile(mcpPath, 'utf8');
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'ENOENT'
      ) {
        return { kind: 'missing' };
      }
      return { kind: 'invalid', errorText: err instanceof Error ? err.message : String(err) };
    }

    const parsed = parseMcpYaml(raw);
    if (!parsed.ok) {
      return { kind: 'invalid', errorText: parsed.errorText };
    }

    return {
      kind: 'loaded',
      declaredServerIds: new Set(parsed.serverIdsInYamlOrder),
      invalidServerIds: new Set(parsed.invalidServers.map((s) => s.serverId)),
    };
  }

  export function listExplicitToolsets(member: Team.Member): string[] {
    if (!member.toolsets) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of member.toolsets) {
      if (entry === '*' || entry.startsWith('!')) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
    return out;
  }

  function buildTeamProblemI18n(text: string): ProblemI18nText {
    const zh = (() => {
      let out = text;
      const replacements: Array<[RegExp, string]> = [
        [
          /Warning in \.minds\/team\.yaml: (.+?) uses a YAML list for labeled entries\./g,
          '.minds/team.yaml 警告：$1 使用了带标签项的 YAML 列表。',
        ],
        [
          /Warning in \.minds\/team\.yaml: (.+?) is null and will be ignored\./g,
          '.minds/team.yaml 警告：$1 写成了 null，这一项会被忽略。',
        ],
        [
          /Warning in \.minds\/team\.yaml: (.+?) is invalid and will be ignored\./g,
          '.minds/team.yaml 警告：$1 写得不合法，这一项会被忽略。',
        ],
        [
          /Warning in \.minds\/team\.yaml: (.+?) sets both (.+?) and (.+?); (.+?) will be ignored\./g,
          '.minds/team.yaml 警告：$1 同时设置了 $2 和 $3；$4 会被忽略。',
        ],
        [
          /(.+?) is allowed as string\|string\[\]\|Record<string,string>\./g,
          '$1 可以写成字符串、字符串数组（string[]）或 Record<string, string>。',
        ],
        [
          /The current list items all look like labeled entries \(for example `Label: value`\)\./g,
          '当前这些列表项看起来都像带标签的条目（例如 `Label: value`）。',
        ],
        [
          /If you want labeled structure, prefer YAML object form for readability:/g,
          '如果你想表达带标签的结构，更推荐改成 YAML 对象写法，可读性会更好：',
        ],
        [
          /Object keys are freeform; there is no fixed required key set\./g,
          '对象键名可以自由填写，没有固定的必填项。',
        ],
        [/The current YAML list form is still accepted\./g, '当前这种 YAML 列表写法仍然可以接受。'],
        [
          /uses YAML null\. Dominds treats this as "unset" and ignores it; delete the field or provide a valid value if you want it to take effect\./g,
          '这里写成了 YAML null。Dominds 会把它当作“没设置”，所以不会生效；请删除这个字段，或改成合法值。',
        ],
        [
          /uses YAML null\. Dominds treats this as "unset" and ignores it; delete the field or provide /g,
          '这里写成了 YAML null。Dominds 会把它当作“未设置”并忽略；请删除这个字段，或提供 ',
        ],
        [
          /This field is optional for loading the member\. Dominds ignores the invalid value and keeps the member usable; fix or delete it\./g,
          '这个字段不会影响成员加载。Dominds 会忽略当前这个非法值，成员仍会保留；请修复或删除它。',
        ],
        [
          /Both (.+?) and (.+?) are set\. Dominds keeps (.+?) and ignores (.+?); remove one for clarity\./g,
          '$1 和 $2 同时被设置。Dominds 会保留 $3，忽略 $4；请删掉其中一个，避免歧义。',
        ],
        [
          /member '(.+?)' has shell tools \((.+?)\) but shell_specialists is empty; set shell_specialists to include '(.+?)' or remove shell tools from that member\./g,
          "成员 '$1' 配置了 shell 工具（$2），但 shell_specialists 为空；请把 '$3' 加入 shell_specialists，或删掉这个成员的 shell 工具。",
        ],
        [
          /member '(.+?)' has shell tools \((.+?)\) but there are no other shell specialists configured; set shell_specialists to include '(.+?)' or remove shell tools from that member\./g,
          "成员 '$1' 配置了 shell 工具（$2），但团队里没有其他 shell 专员；请把 '$3' 加入 shell_specialists，或删掉这个成员的 shell 工具。",
        ],
        [
          /member '(.+?)' has shell tools \((.+?)\) but is not listed in shell_specialists; other shell specialists are already configured \((.+?)\)\./g,
          "成员 '$1' 配置了 shell 工具（$2），但没有列在 shell_specialists 里；团队里已经配置了其他 shell 专员（$3）。",
        ],
        [
          /shell_specialists includes '(.+?)', but no such member exists in team\.members\./g,
          "shell_specialists 里写了 '$1'，但 team.members 中没有这个成员。",
        ],
        [
          /shell_specialists includes '(.+?)', but member '(.+?)' has no shell tools\. Grant toolset 'os' \(or tools (.+?)\) to '(.+?)'\./g,
          "shell_specialists 里写了 '$1'，但成员 '$2' 并没有 shell 工具。请给 '$4' 分配 toolset 'os'（或工具 $3）。",
        ],
        [
          /member '(.+?)' has shell tools \((.+?)\) but is not listed in shell_specialists\./g,
          "成员 '$1' 配置了 shell 工具（$2），但没有列在 shell_specialists 里。",
        ],
        [
          /Resolved (.+?)\.toolsets includes '(.+?)', and '(.+?)' is declared in \.minds\/mcp\.yaml\./g,
          "解析后的 $1.toolsets 包含 '$2'，而且 '$3' 已在 .minds/mcp.yaml 中声明。",
        ],
        [
          /But servers\.(.+?) failed MCP config validation; fix \.minds\/mcp\.yaml first\./g,
          '但 servers.$1 没通过 MCP 配置校验；请先修好 .minds/mcp.yaml。',
        ],
        [
          /Tip: run team_mgmt_validate_mcp_cfg\(\{\}\) to inspect MCP parse\/server errors\./g,
          '建议运行 team_mgmt_validate_mcp_cfg({})，查看 MCP 的解析错误或服务错误。',
        ],
        [
          /Resolved (.+?)\.toolsets includes '(.+?)', but this toolset is not registered in runtime registry\./g,
          "解析后的 $1.toolsets 包含 '$2'，但当前运行时注册表里没有这个工具集。",
        ],
        [
          /Cannot verify whether '(.+?)' is an MCP-declared toolset because \.minds\/mcp\.yaml is invalid\./g,
          "由于 .minds/mcp.yaml 无效，无法确认 '$1' 是否是 MCP 声明的工具集。",
        ],
        [/mcp\.yaml error:/g, '.minds/mcp.yaml 报错：'],
        [
          /Fix \.minds\/mcp\.yaml, then run team_mgmt_validate_team_cfg\(\{\}\) and team_mgmt_validate_mcp_cfg\(\{\}\)\./g,
          '先修好 .minds/mcp.yaml，再运行 team_mgmt_validate_team_cfg({}) 和 team_mgmt_validate_mcp_cfg({})。',
        ],
        [
          /If '(.+?)' is expected from an enabled app, confirm the app is installed\/enabled in this rtws and that its contributes\.toolsets were loaded successfully\./g,
          "如果 '$1' 本来应该由某个已启用 app 提供，请确认这个 app 已在当前 rtws 安装并启用，而且它的 contributes.toolsets 已成功加载。",
        ],
        [
          /Otherwise, fix (.+?)\.toolsets to a valid built-in\/app toolset name, or declare MCP server '(.+?)' in \.minds\/mcp\.yaml\./g,
          "否则，请把 $1.toolsets 改成合法的内置或 app 工具集名称，或者在 .minds/mcp.yaml 里声明 MCP 服务 '$2'。",
        ],
        [
          /Tip: run team_mgmt_validate_mcp_cfg\(\{\}\) for MCP checks, and inspect \/ refresh enabled apps if this toolset should come from an app\./g,
          '建议运行 team_mgmt_validate_mcp_cfg({}) 做 MCP 检查；如果这个工具集应该来自 app，再检查或刷新已启用的 app。',
        ],
        [/Invalid \.minds\/team\.yaml:/g, '无效的 .minds/team.yaml：'],
        [/Failed to parse \.minds\/team\.yaml\./g, '解析 .minds/team.yaml 失败。'],
        [/Failed to load \.minds\/team\.yaml\./g, '加载 .minds/team.yaml 失败。'],
        [/Failed to load enabled app teammates\./g, '加载已启用 app 的成员定义失败。'],
        [
          /Failed to load enabled app toolsets while validating \.minds\/team\.yaml toolset bindings\./g,
          '校验 .minds/team.yaml 的工具集绑定时，加载已启用 app 的工具集失败。',
        ],
        [
          /Failed to load LLM configuration for validating \.minds\/team\.yaml provider\/model bindings\./g,
          '校验 .minds/team.yaml 的 provider/model 绑定时，加载 LLM 配置失败。',
        ],
        [/contains an unknown toolset\./g, '包含未知工具集。'],
        [
          /contains an unresolved toolset, and \.minds\/mcp\.yaml is invalid\./g,
          '包含无法解析的工具集，而且 .minds/mcp.yaml 本身也无效。',
        ],
        [
          /contains an MCP toolset whose server config is invalid\./g,
          '包含一个 MCP 工具集，但它对应的服务器配置无效。',
        ],
        [/contains an unknown member id\./g, '包含未知成员 ID。'],
        [
          /non-shell-specialist member has shell tools\./g,
          '有成员不是 shell 专员，却配置了 shell 工具。',
        ],
        [
          /non-shell-specialist member has shell tools while other shell specialists exist\./g,
          '有成员不是 shell 专员，但在已有其他 shell 专员时也配置了 shell 工具。',
        ],
        [/shell specialist has no shell tools\./g, '有 shell 专员成员却没有配置 shell 工具。'],
        [
          /shell tools are present but no shell specialists are configured\./g,
          '已经配置了 shell 工具，但没有配置任何 shell 专员。',
        ],
        [/Warning in \.minds\/team\.yaml:/g, '.minds/team.yaml 警告：'],
        [/missing member_defaults\.provider\./g, '缺少 member_defaults.provider。'],
        [/missing member_defaults\.model\./g, '缺少 member_defaults.model。'],
        [/default_responder does not match any member\./g, 'default_responder 没有指向任何成员。'],
        [/must be an object\./g, '必须是对象。'],
        [/must be a string\./g, '必须是字符串。'],
        [/must be string\|string\[\] or null\./g, '必须是字符串、字符串数组（string[]）或 null。'],
        [/unknown top-level fields\./g, '存在未知的顶层字段。'],
        [/has invalid fields\./g, '字段里有不合法的值。'],
        [/contains unknown fields\./g, '包含未知字段。'],
        [
          /contains forbidden built-in scopes\. These entries are ignored\./g,
          '包含不允许的内置作用域；这些条目会被忽略。',
        ],
        [/is not allowed for Codex providers\./g, 'Codex provider 不支持这个字段。'],
        [/refers to an unknown provider key\./g, '引用了不存在的 provider key。'],
        [/is not present in provider '(.+?)' models list\./g, "不在 provider '$1' 的模型列表里。"],
        [
          /Resolved (.+?)\.provider = '(.+?)', but no such provider exists in the effective LLM config\./g,
          "解析后的 $1.provider = '$2'，但当前生效的 LLM 配置里没有这个 provider。",
        ],
        [
          /Fix: update (.+?)\.provider to a valid provider key \(see \.minds\/llm\.yaml providers\.<providerKey>\), or add providers\.(.+?) in \.minds\/llm\.yaml\./g,
          '请把 $1.provider 改成合法的 provider key（见 .minds/llm.yaml 的 providers.<providerKey>），或者在 .minds/llm.yaml 里补上 providers.$2。',
        ],
        [
          /Tip: run team_mgmt_list_providers\(\{\}\) \/ team_mgmt_list_models\(\{ source: "effective", provider_pattern: "\*", model_pattern: "\*" \}\) to confirm keys\./g,
          '建议运行 team_mgmt_list_providers({}) 和 team_mgmt_list_models({ source: "effective", provider_pattern: "*", model_pattern: "*" })，确认这些 key 是否存在。',
        ],
        [
          /Resolved (.+?)\.provider = '(.+?)' \(apiType=codex\)\./g,
          "解析后的 $1.provider = '$2'（apiType=codex）。",
        ],
        [/Resolved (.+?)\.streaming = false\./g, '解析后的 $1.streaming = false。'],
        [
          /Codex providers are streaming-only; set (.+?)\.streaming to true or remove it\./g,
          'Codex provider 只支持流式输出；请把 $1.streaming 改成 true，或直接删掉这个字段。',
        ],
        [
          /Tip: run team_mgmt_validate_team_cfg\(\{\}\) after fixing\./g,
          '修好后请运行 team_mgmt_validate_team_cfg({}) 再确认一次。',
        ],
        [
          /Expected providers\.(.+?)\.models to be an object mapping model keys to model info\./g,
          'providers.$1.models 应该是一个对象，用来把模型 key 映射到模型信息。',
        ],
        [/Resolved (.+?)\.provider = '(.+?)'\./g, "解析后的 $1.provider = '$2'。"],
        [
          /Resolved (.+?)\.model = '(.+?)', but it is not defined under providers\.(.+?)\.models\./g,
          "解析后的 $1.model = '$2'，但它没有定义在 providers.$3.models 下。",
        ],
        [/Known model keys \(preview\):/g, '已知模型 key（预览）：'],
        [
          /Fix: change (.+?)\.model to a valid key, or add providers\.(.+?)\.models\.(.+?) in \.minds\/llm\.yaml\./g,
          '请把 $1.model 改成合法的 key，或者在 .minds/llm.yaml 里补上 providers.$2.models.$3。',
        ],
        [
          /After fixing, run team_mgmt_validate_team_cfg\(\{\}\) to confirm there are no Problems panel errors\./g,
          '修好后请运行 team_mgmt_validate_team_cfg({})，确认 Problems 面板里没有残留错误。',
        ],
        [/expected an object/g, '应为对象'],
        [/expected a boolean/g, '应为布尔值'],
        [/expected a number/g, '应为数字'],
        [/expected string\[\]/g, '应为字符串数组（string[]）'],
        [/expected string\|string\[\]/g, '应为字符串或字符串数组（string|string[]）'],
        [/expected string/g, '应为字符串'],
        [/value required/g, '这里必须提供值'],
      ];
      for (const [pattern, replacement] of replacements) {
        out = out.replace(pattern, replacement);
      }
      out = out.replace(/： /g, '：');
      return out;
    })();
    return { en: text, zh };
  }

  // Provider-isolated parameter namespaces. Same-looking field names across providers do not imply
  // shared semantics, shared defaults, or wrapper-level fallback.
  type CodexModelParams = {
    temperature?: number; // 0-2, controls randomness
    max_tokens?: number; // Maximum tokens to generate
    service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority'; // Processing tier / latency class
    top_p?: number; // 0-1, nucleus sampling
    reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; // For reasoning-capable models
    reasoning_summary?: 'auto' | 'concise' | 'detailed' | 'none'; // Control reasoning summary detail level
    verbosity?: 'low' | 'medium' | 'high'; // Control response detail level (GPT-5 series)
    parallel_tool_calls?: boolean; // Allow models to emit parallel tool calls (LLM/provider-native term).
    web_search?: 'disabled' | 'cached' | 'live'; // Codex native web_search mode abstraction.
    json_response?: boolean; // Legacy convenience switch for permissive JSON-object mode.
  };

  type OpenAiModelParams = {
    temperature?: number; // 0-2, controls randomness
    max_tokens?: number; // Maximum tokens to generate
    service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority'; // Processing tier / latency class
    top_p?: number; // 0-1, nucleus sampling
    reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; // For reasoning-capable models
    reasoning_summary?: 'auto' | 'concise' | 'detailed' | 'none'; // Control reasoning summary detail level
    verbosity?: 'low' | 'medium' | 'high'; // Control response detail level (GPT-5 series)
    parallel_tool_calls?: boolean; // Allow models to emit parallel tool calls.
    safety_identifier?: string; // OpenAI safety identifier (preferred over deprecated `user`).
    text_format?: 'text' | 'json_object' | 'json_schema'; // Maps to Responses/ChatCompletions structured-output format.
    text_format_json_schema_name?: string; // Required when text_format=json_schema.
    text_format_json_schema?: string; // JSON-encoded schema object when text_format=json_schema.
    text_format_json_schema_strict?: boolean; // Strict schema adherence when text_format=json_schema.
    web_search_tool?: boolean; // Enables Responses native web_search tool.
    web_search_context_size?: 'low' | 'medium' | 'high'; // Native web_search search_context_size.
    web_search_allowed_domains?: string[]; // Native web_search filters.allowed_domains.
    web_search_include_sources?: boolean; // Include web_search_call.action.sources in Responses output.
  };

  export interface ModelParams {
    // General parameters that can be used by any provider
    max_tokens?: number; // Maximum tokens to generate (provider-agnostic)
    json_response?: boolean; // Force JSON response mode (provider-agnostic, provider-specific overrides when set).

    // Codex-only parameters for the `codex` wrapper.
    // Do not expect `openai.*` to fallback here even when fields have similar names.
    codex?: CodexModelParams;

    // OpenAI-only parameters for the OpenAI/OpenAI-compatible wrappers.
    // Do not expect `codex.*` to fallback here even when fields have similar names.
    openai?: OpenAiModelParams;
    // Anthropic specific parameters
    anthropic?: {
      temperature?: number; // 0-1, controls randomness
      max_tokens?: number; // Maximum tokens to generate
      top_p?: number; // 0-1, nucleus sampling
      top_k?: number; // Top-k sampling
      stop_sequences?: string[]; // Stop sequences
      reasoning_split?: boolean; // Enable separated reasoning stream if supported
      json_response?: boolean; // Force JSON response mode (provider-dependent behavior).
    };
  }

  /**
   * Team.Member
   *
   * Represents an agent/member with model/provider and tool configuration.
   * Also supports resolving toolsets into concrete tool lists.
   */
  export class Member {
    readonly id: string;
    name: string;
    provider?: string;
    model?: string;
    gofor?: string | string[] | Record<string, string>;
    nogo?: string | string[] | Record<string, string>;
    toolsets?: string[];
    tools?: string[];
    model_params?: ModelParams;
    // Fresh Boots Reasoning (FBR): per-member concurrency cap for `freshBootsReasoning` Side Dialogs.
    // See docs: dominds/docs/fbr.md
    fbr_effort?: number;
    // FBR-only model params overrides (same schema as model_params).
    fbr_model_params?: ModelParams;
    // Diligence Push: per-member cap on how many diligence prompts can be auto-sent before forcing Q4H.
    diligence_push_max?: number;
    read_dirs?: string[];
    write_dirs?: string[];
    no_read_dirs?: string[];
    no_write_dirs?: string[];
    read_file_ext_names?: string[];
    write_file_ext_names?: string[];
    no_read_file_ext_names?: string[];
    no_write_file_ext_names?: string[];
    icon?: string;
    streaming?: boolean;
    hidden?: boolean;

    // Internal-only flag: allow `.minds/**` access for tool implementations that are explicitly
    // scoped to `.minds/` (e.g. the `team_mgmt` toolset). This must NOT be configurable from
    // `.minds/team.yaml`.
    internal_allow_minds?: boolean;

    constructor(params: {
      id: string;
      name: string;
      provider?: string;
      model?: string;
      gofor?: string | string[] | Record<string, string>;
      nogo?: string | string[] | Record<string, string>;
      toolsets?: string[];
      tools?: string[];
      model_params?: ModelParams;
      fbr_effort?: number;
      fbr_model_params?: ModelParams;
      diligence_push_max?: number;
      read_dirs?: string[];
      write_dirs?: string[];
      no_read_dirs?: string[];
      no_write_dirs?: string[];
      read_file_ext_names?: string[];
      write_file_ext_names?: string[];
      no_read_file_ext_names?: string[];
      no_write_file_ext_names?: string[];
      icon?: string;
      streaming?: boolean;
      hidden?: boolean;
      internal_allow_minds?: boolean;
    }) {
      this.id = params.id;
      this.name = params.name;
      // Only assign provided fields; omit undefined so prototype fallback can apply
      if (params.provider !== undefined) this.provider = params.provider;
      if (params.model !== undefined) this.model = params.model;
      // Only assign provided fields; omit undefined so prototype fallback can apply
      if (params.gofor !== undefined) this.gofor = params.gofor;
      if (params.nogo !== undefined) this.nogo = params.nogo;
      if (params.toolsets !== undefined) this.toolsets = params.toolsets;
      if (params.tools !== undefined) this.tools = params.tools;
      if (params.model_params !== undefined) this.model_params = params.model_params;
      if (params.fbr_effort !== undefined) this.fbr_effort = params.fbr_effort;
      if (params.fbr_model_params !== undefined) this.fbr_model_params = params.fbr_model_params;
      if (params.diligence_push_max !== undefined)
        this.diligence_push_max = params.diligence_push_max;
      if (params.read_dirs !== undefined) this.read_dirs = params.read_dirs;
      if (params.write_dirs !== undefined) this.write_dirs = params.write_dirs;
      if (params.no_read_dirs !== undefined) this.no_read_dirs = params.no_read_dirs;
      if (params.no_write_dirs !== undefined) this.no_write_dirs = params.no_write_dirs;
      if (params.read_file_ext_names !== undefined)
        this.read_file_ext_names = params.read_file_ext_names;
      if (params.write_file_ext_names !== undefined)
        this.write_file_ext_names = params.write_file_ext_names;
      if (params.no_read_file_ext_names !== undefined)
        this.no_read_file_ext_names = params.no_read_file_ext_names;
      if (params.no_write_file_ext_names !== undefined)
        this.no_write_file_ext_names = params.no_write_file_ext_names;
      if (params.icon !== undefined) this.icon = params.icon;
      if (params.streaming !== undefined) this.streaming = params.streaming;
      if (params.hidden !== undefined) this.hidden = params.hidden;
      if (params.internal_allow_minds !== undefined)
        this.internal_allow_minds = params.internal_allow_minds;

      // TypeScript class-field initialization may define optional fields as own-properties with
      // `undefined`, which breaks prototype-chain defaults. Clean them up.
      const self = this as unknown as Record<string, unknown>;
      const unsettableKeys = [
        'provider',
        'model',
        'gofor',
        'nogo',
        'toolsets',
        'tools',
        'model_params',
        'fbr_effort',
        'fbr_model_params',
        'diligence_push_max',
        'read_dirs',
        'write_dirs',
        'no_read_dirs',
        'no_write_dirs',
        'read_file_ext_names',
        'write_file_ext_names',
        'no_read_file_ext_names',
        'no_write_file_ext_names',
        'icon',
        'streaming',
        'hidden',
        'internal_allow_minds',
      ] as const;
      for (const key of unsettableKeys) {
        if (Object.prototype.hasOwnProperty.call(self, key) && self[key] === undefined) {
          delete self[key];
        }
      }
    }

    setName(name: string): void {
      this.name = name;
    }

    setProvider(provider: string | undefined): void {
      if (provider === undefined) {
        delete this.provider;
        return;
      }
      this.provider = provider;
    }

    setModel(model: string | undefined): void {
      if (model === undefined) {
        delete this.model;
        return;
      }
      this.model = model;
    }

    setGofor(gofor: string | string[] | Record<string, string> | undefined): void {
      if (gofor === undefined) {
        delete this.gofor;
        return;
      }
      this.gofor = gofor;
    }

    setNogo(nogo: string | string[] | Record<string, string> | undefined): void {
      if (nogo === undefined) {
        delete this.nogo;
        return;
      }
      this.nogo = nogo;
    }

    setToolsets(toolsets: string[] | undefined): void {
      if (toolsets === undefined) {
        delete this.toolsets;
        return;
      }
      this.toolsets = toolsets;
    }

    setTools(tools: string[] | undefined): void {
      if (tools === undefined) {
        delete this.tools;
        return;
      }
      this.tools = tools;
    }

    setModelParams(modelParams: ModelParams | undefined): void {
      if (modelParams === undefined) {
        delete this.model_params;
        return;
      }
      this.model_params = modelParams;
    }

    setFbrEffort(effort: number | undefined): void {
      if (effort === undefined) {
        delete this.fbr_effort;
        return;
      }
      this.fbr_effort = effort;
    }

    setFbrModelParams(modelParams: ModelParams | undefined): void {
      if (modelParams === undefined) {
        delete this.fbr_model_params;
        return;
      }
      this.fbr_model_params = modelParams;
    }

    setDiligencePushMax(max: number | undefined): void {
      if (max === undefined) {
        delete this.diligence_push_max;
        return;
      }
      this.diligence_push_max = max;
    }

    setReadDirs(readDirs: string[] | undefined): void {
      if (readDirs === undefined) {
        delete this.read_dirs;
        return;
      }
      this.read_dirs = readDirs;
    }

    setWriteDirs(writeDirs: string[] | undefined): void {
      if (writeDirs === undefined) {
        delete this.write_dirs;
        return;
      }
      this.write_dirs = writeDirs;
    }

    setNoReadDirs(noReadDirs: string[] | undefined): void {
      if (noReadDirs === undefined) {
        delete this.no_read_dirs;
        return;
      }
      this.no_read_dirs = noReadDirs;
    }

    setNoWriteDirs(noWriteDirs: string[] | undefined): void {
      if (noWriteDirs === undefined) {
        delete this.no_write_dirs;
        return;
      }
      this.no_write_dirs = noWriteDirs;
    }

    setReadFileExtNames(readFileExtNames: string[] | undefined): void {
      if (readFileExtNames === undefined) {
        delete this.read_file_ext_names;
        return;
      }
      this.read_file_ext_names = readFileExtNames;
    }

    setWriteFileExtNames(writeFileExtNames: string[] | undefined): void {
      if (writeFileExtNames === undefined) {
        delete this.write_file_ext_names;
        return;
      }
      this.write_file_ext_names = writeFileExtNames;
    }

    setNoReadFileExtNames(noReadFileExtNames: string[] | undefined): void {
      if (noReadFileExtNames === undefined) {
        delete this.no_read_file_ext_names;
        return;
      }
      this.no_read_file_ext_names = noReadFileExtNames;
    }

    setNoWriteFileExtNames(noWriteFileExtNames: string[] | undefined): void {
      if (noWriteFileExtNames === undefined) {
        delete this.no_write_file_ext_names;
        return;
      }
      this.no_write_file_ext_names = noWriteFileExtNames;
    }

    setIcon(icon: string | undefined): void {
      if (icon === undefined) {
        delete this.icon;
        return;
      }
      this.icon = icon;
    }

    setStreaming(streaming: boolean | undefined): void {
      if (streaming === undefined) {
        delete this.streaming;
        return;
      }
      this.streaming = streaming;
    }

    setHidden(hidden: boolean | undefined): void {
      if (hidden === undefined) {
        delete this.hidden;
        return;
      }
      this.hidden = hidden;
    }

    /**
     * Returns a flat list of Tool objects by resolving toolsets and merging with individual tools.
     * Honors declaration order of toolsets and tools. Logs warnings for duplicate tool names
     * that resolve to different Tool objects. Returns no duplicate tools per name.
     */
    listResolvedToolsetNames(options?: {
      onMissing?: 'warn' | 'silent';
      dynamicToolsetNames?: readonly string[];
      declaredMcpToolsetNames?: ReadonlySet<string>;
      invalidMcpToolsetNames?: ReadonlySet<string>;
    }): string[] {
      const onMissing = options?.onMissing ?? 'warn';
      const dynamicToolsetNames = options?.dynamicToolsetNames ?? [];
      const declaredMcpToolsetNames = options?.declaredMcpToolsetNames;
      const invalidMcpToolsetNames = options?.invalidMcpToolsetNames;
      const staticToolsets = this.toolsets ?? [];
      if (staticToolsets.length === 0 && dynamicToolsetNames.length === 0) return [];

      const excludedToolsets = new Set<string>();
      for (const entry of staticToolsets) {
        if (entry.startsWith('!') && entry.length > 1) {
          excludedToolsets.add(entry.slice(1));
        }
      }

      const resolved: string[] = [];
      const seen = new Set<string>();

      for (const toolsetName of [...staticToolsets, ...dynamicToolsetNames]) {
        if (toolsetName.startsWith('!')) continue;

        const toolsetNames =
          toolsetName === '*'
            ? Object.keys(listToolsets()).filter((n) => !excludedToolsets.has(n))
            : excludedToolsets.has(toolsetName)
              ? []
              : [toolsetName];

        for (const resolvedToolsetName of toolsetNames) {
          if (seen.has(resolvedToolsetName)) continue;
          const tools = getToolset(resolvedToolsetName);
          if (!tools) {
            if (onMissing === 'warn') {
              const isDeclaredMcpToolset =
                declaredMcpToolsetNames?.has(resolvedToolsetName) === true;
              const isInvalidDeclaredMcpToolset =
                invalidMcpToolsetNames?.has(resolvedToolsetName) === true;
              if (isDeclaredMcpToolset && !isInvalidDeclaredMcpToolset) {
                log.debug(
                  `MCP toolset '${resolvedToolsetName}' is declared but currently not loaded for member '${this.id}'`,
                );
              } else {
                log.warn(
                  `Toolset '${resolvedToolsetName}' not found in registry for member '${this.id}'`,
                );
              }
            }
            continue;
          }

          resolved.push(resolvedToolsetName);
          seen.add(resolvedToolsetName);
        }
      }

      return resolved;
    }

    listTools(options?: {
      onMissingToolset?: 'warn' | 'silent';
      onMissingTool?: 'warn' | 'silent';
      dynamicToolsetNames?: readonly string[];
      declaredMcpToolsetNames?: ReadonlySet<string>;
      invalidMcpToolsetNames?: ReadonlySet<string>;
    }): Tool[] {
      const toolMap = new Map<string, Tool>();
      const seenNames = new Set<string>();
      const onMissingToolset = options?.onMissingToolset ?? 'warn';
      const onMissingTool = options?.onMissingTool ?? 'warn';
      const dynamicToolsetNames = options?.dynamicToolsetNames ?? [];
      const declaredMcpToolsetNames = options?.declaredMcpToolsetNames;
      const invalidMcpToolsetNames = options?.invalidMcpToolsetNames;

      // Process toolsets (in declaration order)
      for (const toolsetName of this.listResolvedToolsetNames({
        onMissing: onMissingToolset,
        dynamicToolsetNames,
        declaredMcpToolsetNames,
        invalidMcpToolsetNames,
      })) {
        const tools = getToolset(toolsetName);
        if (!tools) continue;

        for (const tool of tools) {
          if (seenNames.has(tool.name)) {
            const existingTool = toolMap.get(tool.name);
            if (existingTool && existingTool !== tool) {
              log.warn(
                `Tool name '${tool.name}' resolves to different Tool objects for member '${this.id}'. Using first occurrence.`,
              );
            }
            continue; // Skip duplicate
          }

          toolMap.set(tool.name, tool);
          seenNames.add(tool.name);
        }
      }

      // Process individual tools (in declaration order)
      if (this.tools) {
        for (const toolName of this.tools) {
          const tool = getTool(toolName);
          if (!tool) {
            if (onMissingTool === 'warn') {
              log.warn(`Tool '${toolName}' not found in registry for member '${this.id}'`);
            }
            continue;
          }

          if (seenNames.has(toolName)) {
            const existingTool = toolMap.get(toolName);
            if (existingTool && existingTool !== tool) {
              log.warn(
                `Tool name '${toolName}' resolves to different Tool objects for member '${this.id}'. Using first occurrence.`,
              );
            }
            continue; // Skip duplicate
          }

          toolMap.set(toolName, tool);
          seenNames.add(toolName);
        }
      }

      return Array.from(toolMap.values());
    }
  }

  export async function listDynamicToolsetNamesForMember(params: {
    member: Team.Member;
    taskDocPath?: string;
    rtwsRootAbs?: string;
  }): Promise<readonly string[]> {
    if (params.taskDocPath === undefined || params.taskDocPath.trim() === '') {
      return [];
    }
    return await listDynamicAppToolsetsForMember({
      rtwsRootAbs: params.rtwsRootAbs ?? process.cwd(),
      taskDocPath: params.taskDocPath,
      memberId: params.member.id,
    });
  }

  // Team config support: load .minds/team.yaml
  export async function load(): Promise<Team> {
    const md = new Team.Member({
      id: 'defaulter',
      name: 'Defaulter',
      fbr_effort: 3,
      // FBR defaults to tool-less web search policy, but users can override via
      // member_defaults.fbr_model_params / members.<id>.fbr_model_params.
      fbr_model_params: {
        codex: { web_search: 'disabled' },
        openai: { web_search_tool: false },
      },
    });

    const fuxi = new Team.Member({
      id: 'fuxi',
      name: '伏羲(Fuxi)',
      icon: '☯️',
      hidden: true,
      toolsets: ['team_mgmt'],
      diligence_push_max: 0,
    });
    Object.setPrototypeOf(fuxi, md);

    // Use `*` to include toolsets registered later (e.g., hot-reloaded MCP toolsets),
    // and exclude the team-management toolset.
    const pangu = new Team.Member({
      id: 'pangu',
      name: '盘古(Pangu)',
      icon: '⛰️',
      hidden: true,
      toolsets: ['*', '!team_mgmt'],
      no_read_dirs: ['.minds/**'],
      no_write_dirs: ['.minds/**'],
      diligence_push_max: 0,
    });
    Object.setPrototypeOf(pangu, md);

    const issuesById = new Map<
      string,
      {
        message: string;
        errorText: string;
        filePath?: string;
        severity: 'error' | 'warning';
      }
    >();
    const addIssue = (
      id: string,
      message: string,
      errorText: string,
      filePath?: string,
      severity: 'error' | 'warning' = 'error',
    ): void => {
      issuesById.set(id, { message, errorText, filePath, severity });
    };
    const addWarning = (
      id: string,
      message: string,
      errorText: string,
      filePath?: string,
    ): void => {
      addIssue(id, message, errorText, filePath, 'warning');
    };

    const finalizeProblems = (): void => {
      const now = formatUnifiedTimestamp(new Date());
      const desired: WorkspaceProblem[] = [];
      for (const [id, issue] of issuesById.entries()) {
        const messageI18n = buildTeamProblemI18n(issue.message);
        const detailTextI18n = buildTeamProblemI18n(issue.errorText);
        desired.push({
          kind: 'team_workspace_config_error',
          source: 'team',
          id: TEAM_YAML_PROBLEM_PREFIX + id,
          severity: issue.severity,
          timestamp: now,
          message: messageI18n.en ?? issue.message,
          messageI18n,
          detailTextI18n,
          detail: { filePath: issue.filePath ?? TEAM_YAML_PATH, errorText: issue.errorText },
        });
      }
      reconcileProblemsByPrefix(TEAM_YAML_PROBLEM_PREFIX, desired);
    };

    const SHELL_TOOL_NAMES = ['shell_cmd', 'stop_daemon', 'get_daemon_output'] as const;
    type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

    function isShellToolName(name: string): name is ShellToolName {
      return (SHELL_TOOL_NAMES as readonly string[]).includes(name);
    }

    function listShellTools(member: Team.Member): ShellToolName[] {
      const out: ShellToolName[] = [];
      for (const t of member.listTools({ onMissingToolset: 'silent', onMissingTool: 'silent' })) {
        if (t.type !== 'func') continue;
        if (!isShellToolName(t.name)) continue;
        if (out.includes(t.name)) continue;
        out.push(t.name);
      }
      return out;
    }

    function enforceShellSpecialistsPolicy(team: Team): void {
      // Hidden members are system-managed (or otherwise not user-facing). Their tool access is
      // governed by runtime policy rather than `.minds/team.yaml` validation, so we skip them.
      const isExemptHiddenMember = (member: Team.Member): boolean => member.hidden === true;

      const specialists = team.shellSpecialists;

      if (specialists.length === 0) {
        for (const member of Object.values(team.members)) {
          if (isExemptHiddenMember(member)) continue;
          const shellTools = listShellTools(member);
          if (shellTools.length === 0) continue;
          addIssue(
            `shell_specialists/forbidden_member/${sanitizeProblemIdSegment(member.id)}`,
            'Invalid .minds/team.yaml: shell tools are present but no shell specialists are configured.',
            `member '${member.id}' has shell tools (${shellTools.join(', ')}) but there are no other shell specialists configured; set shell_specialists to include '${member.id}' or remove shell tools from that member.`,
          );
        }
        return;
      }

      const specialistSet = new Set(specialists);
      for (const id of specialists) {
        const member = team.getMember(id);
        if (!member) {
          addIssue(
            `shell_specialists/unknown_member/${sanitizeProblemIdSegment(id)}`,
            'Invalid .minds/team.yaml: shell_specialists contains an unknown member id.',
            `shell_specialists includes '${id}', but no such member exists in team.members.`,
          );
          continue;
        }
        if (isExemptHiddenMember(member)) continue;
        const shellTools = listShellTools(member);
        if (shellTools.length === 0) {
          addIssue(
            `shell_specialists/missing_shell_tools/${sanitizeProblemIdSegment(id)}`,
            'Invalid .minds/team.yaml: shell specialist has no shell tools.',
            `shell_specialists includes '${id}', but member '${id}' has no shell tools. Grant toolset 'os' (or tools ${SHELL_TOOL_NAMES.join(', ')}) to '${id}'.`,
          );
        }
      }

      for (const member of Object.values(team.members)) {
        if (isExemptHiddenMember(member)) continue;
        if (specialistSet.has(member.id)) continue;
        const shellTools = listShellTools(member);
        if (shellTools.length === 0) continue;
        addWarning(
          `shell_specialists/non_specialist_has_shell_tools/${sanitizeProblemIdSegment(member.id)}`,
          'Warning in .minds/team.yaml: non-shell-specialist member has shell tools while other shell specialists exist.',
          `member '${member.id}' has shell tools (${shellTools.join(', ')}) but is not listed in shell_specialists; other shell specialists are already configured (${specialists.join(', ')}).`,
        );
      }
    }

    async function validateMemberToolsetBindings(team: Team, md: Team.Member): Promise<void> {
      const registeredToolsets = new Set(Object.keys(listToolsets()));
      const mcpDeclared = await readMcpDeclaredToolsets();
      let enabledAppToolsets = new Set<string>();
      try {
        const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: process.cwd() });
        enabledAppToolsets = new Set(
          snapshot.enabledApps.flatMap((app) =>
            (app.installJson.contributes?.toolsets ?? []).map((toolset) => toolset.id),
          ),
        );
      } catch (err: unknown) {
        addIssue(
          'apps/toolsets/load',
          'Failed to load enabled app toolsets while validating .minds/team.yaml toolset bindings.',
          err instanceof Error ? err.message : String(err),
        );
      }

      const validateAt = (args: {
        idPrefix: string;
        atPrefix: string;
        toolsets: ReadonlyArray<string>;
      }) => {
        for (const toolsetName of args.toolsets) {
          const registeredMeta = getToolsetMeta(toolsetName);
          if (registeredToolsets.has(toolsetName)) {
            if (registeredMeta?.source === 'app') {
              continue;
            }
            continue;
          }
          if (enabledAppToolsets.has(toolsetName)) {
            continue;
          }

          if (mcpDeclared.kind === 'loaded' && mcpDeclared.declaredServerIds.has(toolsetName)) {
            if (mcpDeclared.invalidServerIds.has(toolsetName)) {
              addIssue(
                `${args.idPrefix}/toolsets/${sanitizeProblemIdSegment(toolsetName)}/mcp_declared_invalid`,
                `Invalid .minds/team.yaml: ${args.atPrefix}.toolsets contains an MCP toolset whose server config is invalid.`,
                [
                  `Resolved ${args.atPrefix}.toolsets includes '${toolsetName}', and '${toolsetName}' is declared in .minds/mcp.yaml.`,
                  `But servers.${toolsetName} failed MCP config validation; fix .minds/mcp.yaml first.`,
                  `Tip: run team_mgmt_validate_mcp_cfg({}) to inspect MCP parse/server errors.`,
                ].join('\n'),
              );
            }
            continue;
          }

          if (mcpDeclared.kind === 'invalid') {
            addIssue(
              `${args.idPrefix}/toolsets/${sanitizeProblemIdSegment(toolsetName)}/unresolved_with_invalid_mcp`,
              `Invalid .minds/team.yaml: ${args.atPrefix}.toolsets contains an unresolved toolset, and .minds/mcp.yaml is invalid.`,
              [
                `Resolved ${args.atPrefix}.toolsets includes '${toolsetName}', but this toolset is not registered in runtime registry.`,
                `Cannot verify whether '${toolsetName}' is an MCP-declared toolset because .minds/mcp.yaml is invalid.`,
                `mcp.yaml error: ${mcpDeclared.errorText}`,
                `Fix .minds/mcp.yaml, then run team_mgmt_validate_team_cfg({}) and team_mgmt_validate_mcp_cfg({}).`,
              ].join('\n'),
            );
            continue;
          }

          addIssue(
            `${args.idPrefix}/toolsets/${sanitizeProblemIdSegment(toolsetName)}/missing`,
            `Invalid .minds/team.yaml: ${args.atPrefix}.toolsets contains an unknown toolset.`,
            [
              `Resolved ${args.atPrefix}.toolsets includes '${toolsetName}', but this toolset is not currently registered in runtime registry and is not declared in .minds/mcp.yaml.`,
              `If '${toolsetName}' is expected from an enabled app, confirm the app is installed/enabled in this rtws and that its contributes.toolsets were loaded successfully.`,
              `Otherwise, fix ${args.atPrefix}.toolsets to a valid built-in/app toolset name, or declare MCP server '${toolsetName}' in .minds/mcp.yaml.`,
              `Tip: run team_mgmt_validate_mcp_cfg({}) for MCP checks, and inspect / refresh enabled apps if this toolset should come from an app.`,
            ].join('\n'),
          );
        }
      };

      validateAt({
        idPrefix: 'member_defaults',
        atPrefix: 'member_defaults',
        toolsets: listExplicitToolsets(md),
      });

      for (const member of Object.values(team.members)) {
        const idSeg = sanitizeProblemIdSegment(member.id);
        validateAt({
          idPrefix: `members/${idSeg}`,
          atPrefix: `members.${member.id}`,
          toolsets: listExplicitToolsets(member),
        });
      }
    }

    function previewKeys(obj: Record<string, unknown>, max: number): string {
      const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
      const head = keys.slice(0, Math.max(0, max));
      const suffix = keys.length > head.length ? ` …(+${keys.length - head.length})` : '';
      return head.join(', ') + suffix;
    }

    async function validateResolvedProviderModelBindings(
      team: Team,
      md: Team.Member,
    ): Promise<void> {
      let llmCfg: LlmConfig;
      try {
        llmCfg = await LlmConfig.load();
      } catch (err: unknown) {
        // Fail-open: team must remain usable, but surface this to Problems panel.
        addIssue(
          'llm/load',
          'Failed to load LLM configuration for validating .minds/team.yaml provider/model bindings.',
          asErrorText(err),
          '.minds/llm.yaml',
        );
        return;
      }

      const validateAt = (args: {
        idPrefix: string;
        atPrefix: string;
        provider: string | undefined;
        model: string | undefined;
        streaming: boolean | undefined;
      }): void => {
        const providerKey = args.provider;
        if (!providerKey) return;
        const providerCfg = llmCfg.getProvider(providerKey);
        if (!providerCfg) {
          addIssue(
            `${args.idPrefix}/provider/unknown`,
            `Invalid .minds/team.yaml: ${args.atPrefix}.provider refers to an unknown provider key.`,
            [
              `Resolved ${args.atPrefix}.provider = '${providerKey}', but no such provider exists in the effective LLM config.`,
              `Fix: update ${args.atPrefix}.provider to a valid provider key (see .minds/llm.yaml providers.<providerKey>), or add providers.${providerKey} in .minds/llm.yaml.`,
              `Tip: run team_mgmt_list_providers({}) / team_mgmt_list_models({ source: "effective", provider_pattern: "*", model_pattern: "*" }) to confirm keys.`,
            ].join('\n'),
          );
          return;
        }

        if (providerCfg.apiType === 'codex' && args.streaming === false) {
          addIssue(
            `${args.idPrefix}/streaming/codex_requires_streaming`,
            `Invalid .minds/team.yaml: ${args.atPrefix}.streaming=false is not allowed for Codex providers.`,
            [
              `Resolved ${args.atPrefix}.provider = '${providerKey}' (apiType=codex).`,
              `Resolved ${args.atPrefix}.streaming = false.`,
              `Codex providers are streaming-only; set ${args.atPrefix}.streaming to true or remove it.`,
              `Tip: run team_mgmt_validate_team_cfg({}) after fixing.`,
            ].join('\n'),
          );
        }

        const modelsUnknown: unknown = (providerCfg as unknown as { models?: unknown }).models;
        const models =
          typeof modelsUnknown === 'object' &&
          modelsUnknown !== null &&
          !Array.isArray(modelsUnknown)
            ? (modelsUnknown as Record<string, unknown>)
            : undefined;

        if (!models) {
          addIssue(
            `${args.idPrefix}/provider/models/invalid`,
            `Invalid .minds/llm.yaml: providers.${providerKey}.models is missing or invalid (cannot validate team model bindings).`,
            `Expected providers.${providerKey}.models to be an object mapping model keys to model info.`,
            '.minds/llm.yaml',
          );
          return;
        }

        const modelKey = args.model;
        if (!modelKey) return;
        if (!Object.prototype.hasOwnProperty.call(models, modelKey)) {
          addIssue(
            `${args.idPrefix}/model/unknown`,
            `Invalid .minds/team.yaml: ${args.atPrefix}.model is not present in provider '${providerKey}' models list.`,
            [
              `Resolved ${args.atPrefix}.provider = '${providerKey}'.`,
              `Resolved ${args.atPrefix}.model = '${modelKey}', but it is not defined under providers.${providerKey}.models.`,
              `Known model keys (preview): ${previewKeys(models, 12)}`,
              `Fix: change ${args.atPrefix}.model to a valid key, or add providers.${providerKey}.models.${modelKey} in .minds/llm.yaml.`,
              `After fixing, run team_mgmt_validate_team_cfg({}) to confirm there are no Problems panel errors.`,
            ].join('\n'),
          );
        }
      };

      // Always validate member_defaults (they influence all members via prototype defaults).
      validateAt({
        idPrefix: 'member_defaults',
        atPrefix: 'member_defaults',
        provider: md.provider,
        model: md.model,
        streaming: md.streaming,
      });

      for (const member of Object.values(team.members)) {
        // Validate members whose provider/model/streaming binding is explicitly overridden.
        const hasProviderOverride = Object.prototype.hasOwnProperty.call(member, 'provider');
        const hasModelOverride = Object.prototype.hasOwnProperty.call(member, 'model');
        const hasStreamingOverride = Object.prototype.hasOwnProperty.call(member, 'streaming');
        if (!hasProviderOverride && !hasModelOverride && !hasStreamingOverride) continue;

        const provider = member.provider ?? md.provider;
        const model = member.model ?? md.model;
        const streaming = member.streaming ?? md.streaming;
        const idSeg = sanitizeProblemIdSegment(member.id);
        validateAt({
          idPrefix: `members/${idSeg}`,
          atPrefix: `members.${member.id}`,
          provider,
          model,
          streaming,
        });
      }
    }

    function validateRoutingCardShapeWarnings(team: Team, md: Team.Member): void {
      const findStructuredGoforLabelDelimiter = (value: string): number => {
        const halfWidth = value.indexOf(':');
        const fullWidth = value.indexOf('：');
        if (halfWidth === -1) return fullWidth;
        if (fullWidth === -1) return halfWidth;
        return Math.min(halfWidth, fullWidth);
      };

      const looksLikeStructuredGoforListEntry = (value: string): boolean => {
        const trimmed = value.trim();
        if (trimmed === '') return false;
        const delimiterIndex = findStructuredGoforLabelDelimiter(trimmed);
        if (delimiterIndex <= 0 || delimiterIndex > 32) return false;
        const label = trimmed.slice(0, delimiterIndex).trim();
        const detail = trimmed.slice(delimiterIndex + 1).trim();
        if (label === '' || detail === '') return false;
        const secondHalfWidth = trimmed.indexOf(':', delimiterIndex + 1);
        const secondFullWidth = trimmed.indexOf('：', delimiterIndex + 1);
        return secondHalfWidth === -1 && secondFullWidth === -1;
      };

      const validateAt = (args: {
        idPrefix: string;
        atPrefix: string;
        field: 'gofor' | 'nogo';
        card: string | string[] | Record<string, string> | undefined;
      }): void => {
        const card = args.card;
        if (!Array.isArray(card)) return;
        if (card.length === 0) return;
        if (!card.every(looksLikeStructuredGoforListEntry)) return;
        const isPositive = args.field === 'gofor';
        addWarning(
          `${args.idPrefix}/${args.field}/prefer_object_for_labeled_entries`,
          `Warning in .minds/team.yaml: ${args.atPrefix}.${args.field} uses a YAML list for labeled entries.`,
          [
            `${args.atPrefix}.${args.field} is allowed as string|string[]|Record<string,string>.`,
            isPositive
              ? `Use gofor as a routing card for other teammates/humans: write when someone should ask this teammate and what help to expect.`
              : `Use nogo as a negative routing card for other teammates/humans: write what kinds of asks should be routed elsewhere.`,
            `Do not dump the member's own operating rules, work mode, or full role spec into ${args.field}; those belong in .minds/team/<id>/*.md.`,
            `The current list items all look like labeled entries (for example \`Label: value\`).`,
            `If you want labeled structure, prefer YAML object form for readability:`,
            `${args.field}:`,
            isPositive
              ? `  When: when this teammate should be asked`
              : `  Avoid: asks that should not be routed to this teammate`,
            isPositive
              ? `  Returns: what help/output others can expect`
              : `  RouteTo: who/what kind of teammate should take it instead`,
            `Object keys are freeform; there is no fixed required key set.`,
            `The current YAML list form is still accepted.`,
          ].join('\n'),
        );
      };

      if (Object.prototype.hasOwnProperty.call(md, 'gofor')) {
        validateAt({
          idPrefix: 'member_defaults',
          atPrefix: 'member_defaults',
          field: 'gofor',
          card: md.gofor,
        });
      }
      if (Object.prototype.hasOwnProperty.call(md, 'nogo')) {
        validateAt({
          idPrefix: 'member_defaults',
          atPrefix: 'member_defaults',
          field: 'nogo',
          card: md.nogo,
        });
      }

      for (const member of Object.values(team.members)) {
        const idSeg = sanitizeProblemIdSegment(member.id);
        if (Object.prototype.hasOwnProperty.call(member, 'gofor')) {
          validateAt({
            idPrefix: `members/${idSeg}`,
            atPrefix: `members.${member.id}`,
            field: 'gofor',
            card: member.gofor,
          });
        }
        if (Object.prototype.hasOwnProperty.call(member, 'nogo')) {
          validateAt({
            idPrefix: `members/${idSeg}`,
            atPrefix: `members.${member.id}`,
            field: 'nogo',
            card: member.nogo,
          });
        }
      }
    }
    const buildBootstrapTeam = async (): Promise<Team> => {
      try {
        await applyBootstrapMemberDefaults(md);
      } catch (err: unknown) {
        log.warn(
          `Failed to apply bootstrap member defaults: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return new Team({
        memberDefaults: md,
        defaultResponder: 'fuxi',
        shellSpecialists: [],
        members: { fuxi, pangu },
      });
    };

    try {
      await fs.access(TEAM_YAML_PATH);
    } catch {
      // When rtws doesn't have a team definition, construct a minimal team with
      // shadow/hidden members for bootstrap.
      const team = await buildBootstrapTeam();
      finalizeProblems();
      return team;
    }

    let team: Team;
    try {
      const raw = await fs.readFile(TEAM_YAML_PATH, 'utf-8');
      let parsed: unknown;
      try {
        parsed = YAML.parse(raw);
      } catch (err: unknown) {
        addIssue(
          'parse',
          'Failed to parse .minds/team.yaml.',
          err instanceof Error ? err.message : String(err),
        );
        team = await buildBootstrapTeam();
        finalizeProblems();
        return team;
      }

      let appTeammates: ReadonlyArray<AppTeammatesSnippet> = [];
      try {
        appTeammates = await loadEnabledAppTeammates({ rtwsRootAbs: process.cwd() });
      } catch (err: unknown) {
        addIssue(
          'apps/teammates/load',
          'Failed to load enabled app teammates.',
          err instanceof Error ? err.message : String(err),
        );
      }

      const parsedTeam = parseTeamYamlObject(parsed, md, { fuxi, pangu }, { appTeammates });
      for (const issue of parsedTeam.issues) {
        addIssue(issue.id, issue.message, issue.errorText, undefined, issue.severity);
      }

      team = parsedTeam.team;
    } catch (err: unknown) {
      addIssue(
        'read',
        'Failed to load .minds/team.yaml.',
        err instanceof Error ? err.message : String(err),
      );
      team = await buildBootstrapTeam();
      finalizeProblems();
      return team;
    }

    // Always include fuxi + pangu as shadow members, even if team.yaml exists.
    enforceShadowMemberDefaults(fuxi, pangu);
    team.members['fuxi'] = fuxi;
    team.members['pangu'] = pangu;

    const configuredDefaultResponder = team.defaultResponder;
    // Normalize default responder (even if team.yaml omitted it).
    const def = team.getDefaultResponder();
    team.defaultResponder = def ? def.id : 'fuxi';

    // Shell specialists policy must not make Team.load() fail, but it still surfaces Problems and
    // may leave specific members without shell capability until the config is fixed.
    enforceShellSpecialistsPolicy(team);
    // If member_defaults provider/model are missing after parsing, try to recover from llm.yaml.
    try {
      await applyBootstrapMemberDefaults(md);
    } catch (err: unknown) {
      // Keep loading the Team object even if llm.yaml recovery fails.
      log.warn(
        `Failed to recover missing member_defaults provider/model from llm config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!md.provider) {
      addIssue(
        'member_defaults/provider',
        'Invalid .minds/team.yaml: missing member_defaults.provider.',
        'member_defaults.provider is required (or must be recoverable from .minds/llm.yaml).',
      );
    }
    if (!md.model) {
      addIssue(
        'member_defaults/model',
        'Invalid .minds/team.yaml: missing member_defaults.model.',
        'member_defaults.model is required (or must be recoverable from .minds/llm.yaml).',
      );
    }

    if (configuredDefaultResponder && !team.getMember(configuredDefaultResponder)) {
      addIssue(
        'default_responder/unknown',
        'Invalid .minds/team.yaml: default_responder does not match any member.',
        `default_responder '${configuredDefaultResponder}' does not exist in team members.`,
      );
    }

    // Validate provider/model bindings (models must exist under the selected provider's models list).
    // Keep publishing Problems without crashing Team.load(), but strict parsing above may still omit
    // specific broken members.
    await validateResolvedProviderModelBindings(team, md);
    await validateMemberToolsetBindings(team, md);
    validateRoutingCardShapeWarnings(team, md);

    finalizeProblems();
    return team;
  }

  async function applyBootstrapMemberDefaults(md: Team.Member): Promise<void> {
    if (md.provider && md.model) return;

    const llmCfg = await LlmConfig.load();
    const providerEntries = Object.entries(llmCfg.providers);

    const tryPickProvider = (key: string): void => {
      if (!md.provider) md.setProvider(key);

      const providerKey = md.provider;
      if (!providerKey) return;
      const modelKeys = Object.keys(llmCfg.providers[providerKey]?.models ?? {});
      if (!md.model && modelKeys.length > 0) md.setModel(modelKeys[0]);
    };

    // Prefer a provider with an available API key env var.
    for (const [key, providerConfig] of providerEntries) {
      if (process.env[providerConfig.apiKeyEnvVar]) {
        tryPickProvider(key);
        break;
      }
    }

    // Fall back to the first configured provider.
    if (!md.provider && providerEntries.length > 0) {
      tryPickProvider(providerEntries[0][0]);
    }

    // If provider is set but model is missing, try to pick a model for that provider.
    if (md.provider && !md.model) {
      tryPickProvider(md.provider);
    }
  }

  function enforceShadowMemberDefaults(fuxi: Team.Member, pangu: Team.Member): void {
    // fuxi: always hidden + always has team_mgmt available
    fuxi.setHidden(true);
    const fuxiToolsets = fuxi.toolsets ? [...fuxi.toolsets] : [];
    const withoutExclude = fuxiToolsets.filter((t) => t !== '!team_mgmt');
    if (!withoutExclude.includes('team_mgmt')) withoutExclude.unshift('team_mgmt');
    fuxi.setToolsets(withoutExclude);

    // pangu: always hidden + never has team_mgmt + never reads/writes .minds/**
    pangu.setHidden(true);
    const panguToolsets = pangu.toolsets ? [...pangu.toolsets] : [];
    const withoutMgmt = panguToolsets.filter((t) => t !== 'team_mgmt');
    if (!withoutMgmt.includes('!team_mgmt')) withoutMgmt.push('!team_mgmt');
    if (!withoutMgmt.includes('*')) withoutMgmt.unshift('*');
    pangu.setToolsets(withoutMgmt);

    const mindsScope = '.minds/**';
    const panguNoRead = pangu.no_read_dirs ? [...pangu.no_read_dirs] : [];
    if (!panguNoRead.includes(mindsScope)) panguNoRead.push(mindsScope);
    pangu.setNoReadDirs(panguNoRead);

    const panguNoWrite = pangu.no_write_dirs ? [...pangu.no_write_dirs] : [];
    if (!panguNoWrite.includes(mindsScope)) panguNoWrite.push(mindsScope);
    pangu.setNoWriteDirs(panguNoWrite);
  }

  function hasOwnKey(obj: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function requireDefined<T>(value: T | undefined, at: string): T {
    if (value === undefined) {
      throw new Error(`Invalid ${at}: value required (got ${describeValueType(value)})`);
    }
    return value;
  }

  type TeamYamlIssue = {
    id: string;
    message: string;
    errorText: string;
    severity: 'error' | 'warning';
  };

  function isRecordValue(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  export const TEAM_YAML_ROOT_KEYS = [
    'member_defaults',
    'default_responder',
    'shell_specialists',
    'members',
  ] as const;
  export const TEAM_YAML_MEMBER_KEYS = [
    'name',
    // Cross-app teammate reference (design draft): members.<id>.from + (use|import)
    // These are currently validated (best-effort) but not executed as real cross-app semantics.
    'from',
    'use',
    'import',
    'provider',
    'model',
    'gofor',
    'nogo',
    'toolsets',
    'tools',
    'model_params',
    'fbr-effort',
    'fbr_effort',
    'fbr_model_params',
    'diligence-push-max',
    'diligence_push_max',
    'read_dirs',
    'write_dirs',
    'no_read_dirs',
    'no_write_dirs',
    'read_file_ext_names',
    'write_file_ext_names',
    'no_read_file_ext_names',
    'no_write_file_ext_names',
    'icon',
    'streaming',
    'hidden',
  ] as const;

  export const TEAM_YAML_MODEL_PARAMS_ROOT_KEYS = [
    'max_tokens',
    'json_response',
    'general',
    'codex',
    'openai',
    'anthropic',
  ] as const;
  export const TEAM_YAML_MODEL_PARAMS_GENERAL_KEYS = ['max_tokens'] as const;
  export const TEAM_YAML_MODEL_PARAMS_OPENAI_KEYS = [
    'temperature',
    'max_tokens',
    'service_tier',
    'top_p',
    'reasoning_effort',
    'reasoning_summary',
    'verbosity',
    'parallel_tool_calls',
    'safety_identifier',
    'text_format',
    'text_format_json_schema_name',
    'text_format_json_schema',
    'text_format_json_schema_strict',
    'web_search_tool',
    'web_search_context_size',
    'web_search_allowed_domains',
    'web_search_include_sources',
  ] as const;
  export const TEAM_YAML_MODEL_PARAMS_CODEX_KEYS = [
    'temperature',
    'max_tokens',
    'service_tier',
    'top_p',
    'reasoning_effort',
    'reasoning_summary',
    'verbosity',
    'parallel_tool_calls',
    'web_search',
    'json_response',
  ] as const;
  export const TEAM_YAML_MODEL_PARAMS_ANTHROPIC_KEYS = [
    'temperature',
    'max_tokens',
    'top_p',
    'top_k',
    'stop_sequences',
    'reasoning_split',
    'json_response',
  ] as const;

  function listUnknownKeys(obj: Record<string, unknown>, allowedKeys: readonly string[]): string[] {
    const allowed = new Set(allowedKeys);
    const unknown: string[] = [];
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) unknown.push(k);
    }
    unknown.sort((a, b) => a.localeCompare(b));
    return unknown;
  }

  function buildUnknownFieldErrorText(
    at: string,
    unknownKeys: readonly string[],
    hints: Record<string, string>,
  ): string {
    const lines: string[] = [];
    for (const k of unknownKeys) {
      const hint = hints[k];
      lines.push(hint ? `- ${at}.${k}: unknown field. ${hint}` : `- ${at}.${k}: unknown field.`);
    }
    return lines.join('\n');
  }

  function validateCommonModelParamMisplacements(
    pushIssue: (id: string, message: string, errorText: string) => void,
    idPrefix: string,
    atPrefix: string,
    memberObj: Record<string, unknown>,
  ): void {
    const hintsAtMember: Record<string, string> = {
      reasoning_effort: `Did you mean \`${atPrefix}.model_params.codex.reasoning_effort\` (preferred for provider: codex) or \`${atPrefix}.model_params.openai.reasoning_effort\`? (not supported at ${atPrefix} root)`,
      reasoning_summary: `Did you mean \`${atPrefix}.model_params.codex.reasoning_summary\` (preferred for provider: codex) or \`${atPrefix}.model_params.openai.reasoning_summary\`? (not supported at ${atPrefix} root)`,
      verbosity: `Did you mean \`${atPrefix}.model_params.codex.verbosity\` (preferred for provider: codex) or \`${atPrefix}.model_params.openai.verbosity\`? (not supported at ${atPrefix} root)`,
      parallel_tool_calls: `Did you mean \`${atPrefix}.model_params.codex.parallel_tool_calls\` (preferred for provider: codex) or \`${atPrefix}.model_params.openai.parallel_tool_calls\`? (not supported at ${atPrefix} root)`,
      web_search: `Did you mean \`${atPrefix}.model_params.codex.web_search\`? (not supported at ${atPrefix} root)`,
      web_search_tool: `Did you mean \`${atPrefix}.model_params.openai.web_search_tool\`? (not supported at ${atPrefix} root)`,
      json_response: `Did you mean \`${atPrefix}.model_params.json_response\` (provider-agnostic), or provider-specific \`${atPrefix}.model_params.codex.json_response\` / \`${atPrefix}.model_params.anthropic.json_response\`?`,
      text_format: `Did you mean \`${atPrefix}.model_params.openai.text_format\`? (not supported at ${atPrefix} root)`,
    };

    const unknownAtMember = listUnknownKeys(memberObj, TEAM_YAML_MEMBER_KEYS);
    if (unknownAtMember.length > 0) {
      pushIssue(
        `${idPrefix}/unknown_fields`,
        `Invalid .minds/team.yaml: ${atPrefix} contains unknown fields.`,
        buildUnknownFieldErrorText(atPrefix, unknownAtMember, hintsAtMember),
      );
    }

    const validateOptionalModelParamsField = (
      field: 'model_params' | 'fbr_model_params',
      issuePrefix: string,
    ): void => {
      if (!Object.prototype.hasOwnProperty.call(memberObj, field)) return;
      const rawModelParams = memberObj[field];
      if (rawModelParams === undefined) return;
      if (!isRecordValue(rawModelParams)) {
        // Type errors are handled by parseMemberOverrides; keep this check focused on schema/placement.
        return;
      }

      const modelParamsAt = `${atPrefix}.${field}`;
      const hintsAtModelParams: Record<string, string> = {
        reasoning_effort: `Did you mean \`${modelParamsAt}.codex.reasoning_effort\` (preferred for provider: codex) or \`${modelParamsAt}.openai.reasoning_effort\`?`,
        reasoning_summary: `Did you mean \`${modelParamsAt}.codex.reasoning_summary\` (preferred for provider: codex) or \`${modelParamsAt}.openai.reasoning_summary\`?`,
        verbosity: `Did you mean \`${modelParamsAt}.codex.verbosity\` (preferred for provider: codex) or \`${modelParamsAt}.openai.verbosity\`?`,
        parallel_tool_calls: `Did you mean \`${modelParamsAt}.codex.parallel_tool_calls\` (preferred for provider: codex) or \`${modelParamsAt}.openai.parallel_tool_calls\`?`,
        web_search: `Did you mean \`${modelParamsAt}.codex.web_search\`?`,
        web_search_tool: `Did you mean \`${modelParamsAt}.openai.web_search_tool\`?`,
        service_tier: `Did you mean \`${modelParamsAt}.codex.service_tier\` (preferred for provider: codex) or \`${modelParamsAt}.openai.service_tier\`?`,
        temperature: `Did you mean \`${modelParamsAt}.codex.temperature\` / \`${modelParamsAt}.openai.temperature\` (or \`${modelParamsAt}.anthropic.temperature\`)?`,
        top_p: `Did you mean \`${modelParamsAt}.codex.top_p\` / \`${modelParamsAt}.openai.top_p\` (or \`${modelParamsAt}.anthropic.top_p\`)?`,
        max_tokens: `Did you mean \`${modelParamsAt}.max_tokens\` / \`${modelParamsAt}.general.max_tokens\` (provider-agnostic), or \`${modelParamsAt}.codex.max_tokens\` / \`${modelParamsAt}.openai.max_tokens\` / \`${modelParamsAt}.anthropic.max_tokens\`?`,
      };

      const unknownAtModelParams = listUnknownKeys(
        rawModelParams,
        TEAM_YAML_MODEL_PARAMS_ROOT_KEYS,
      );
      if (unknownAtModelParams.length > 0) {
        pushIssue(
          `${idPrefix}/${issuePrefix}/unknown_fields`,
          `Invalid .minds/team.yaml: ${modelParamsAt} contains unknown fields.`,
          buildUnknownFieldErrorText(modelParamsAt, unknownAtModelParams, hintsAtModelParams),
        );
      }

      const rawCodex = rawModelParams.codex;
      if (rawCodex !== undefined && isRecordValue(rawCodex)) {
        const unknownAtCodex = listUnknownKeys(rawCodex, TEAM_YAML_MODEL_PARAMS_CODEX_KEYS);
        if (unknownAtCodex.length > 0) {
          pushIssue(
            `${idPrefix}/${issuePrefix}/codex/unknown_fields`,
            `Invalid .minds/team.yaml: ${modelParamsAt}.codex contains unknown fields.`,
            buildUnknownFieldErrorText(`${modelParamsAt}.codex`, unknownAtCodex, {}),
          );
        }
      }

      const rawGeneral = rawModelParams.general;
      if (rawGeneral !== undefined && isRecordValue(rawGeneral)) {
        const unknownAtGeneral = listUnknownKeys(rawGeneral, TEAM_YAML_MODEL_PARAMS_GENERAL_KEYS);
        if (unknownAtGeneral.length > 0) {
          pushIssue(
            `${idPrefix}/${issuePrefix}/general/unknown_fields`,
            `Invalid .minds/team.yaml: ${modelParamsAt}.general contains unknown fields.`,
            buildUnknownFieldErrorText(`${modelParamsAt}.general`, unknownAtGeneral, {}),
          );
        }
      }

      const rawOpenai = rawModelParams.openai;
      if (rawOpenai !== undefined && isRecordValue(rawOpenai)) {
        const unknownAtOpenai = listUnknownKeys(rawOpenai, TEAM_YAML_MODEL_PARAMS_OPENAI_KEYS);
        if (unknownAtOpenai.length > 0) {
          pushIssue(
            `${idPrefix}/${issuePrefix}/openai/unknown_fields`,
            `Invalid .minds/team.yaml: ${modelParamsAt}.openai contains unknown fields.`,
            buildUnknownFieldErrorText(`${modelParamsAt}.openai`, unknownAtOpenai, {}),
          );
        }
      }

      const rawAnthropic = rawModelParams.anthropic;
      if (rawAnthropic !== undefined && isRecordValue(rawAnthropic)) {
        const unknownAtAnthropic = listUnknownKeys(
          rawAnthropic,
          TEAM_YAML_MODEL_PARAMS_ANTHROPIC_KEYS,
        );
        if (unknownAtAnthropic.length > 0) {
          pushIssue(
            `${idPrefix}/${issuePrefix}/anthropic/unknown_fields`,
            `Invalid .minds/team.yaml: ${modelParamsAt}.anthropic contains unknown fields.`,
            buildUnknownFieldErrorText(`${modelParamsAt}.anthropic`, unknownAtAnthropic, {}),
          );
        }
      }
    };

    validateOptionalModelParamsField('model_params', 'model_params');
    validateOptionalModelParamsField('fbr_model_params', 'fbr_model_params');
  }

  function sanitizeProblemIdSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function asErrorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  type MemberOverrides = {
    name?: string;
    provider?: string;
    model?: string;
    gofor?: string | string[] | Record<string, string>;
    nogo?: string | string[] | Record<string, string>;
    toolsets?: string[];
    tools?: string[];
    model_params?: ModelParams;
    fbr_effort?: number;
    fbr_model_params?: ModelParams;
    diligence_push_max?: number;
    read_dirs?: string[];
    write_dirs?: string[];
    no_read_dirs?: string[];
    no_write_dirs?: string[];
    read_file_ext_names?: string[];
    write_file_ext_names?: string[];
    no_read_file_ext_names?: string[];
    no_write_file_ext_names?: string[];
    icon?: string;
    streaming?: boolean;
    hidden?: boolean;
  };

  function normalizePatternToken(raw: string): string {
    return raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function isForbiddenBuiltinAllowListPattern(raw: string): boolean {
    const token = normalizePatternToken(raw);
    // `.minds/**` is reserved rtws state: general file tools must not access it.
    if (/(^|\/)\.minds(\/|$)/.test(token)) return true;
    // `*.tsk/**` is encapsulated Taskdoc state: general file tools must not access it.
    if (/\.tsk(\/|$)/.test(token)) return true;
    return false;
  }

  function sanitizeAllowListsForBuiltinScopes(
    pushIssue: (id: string, message: string, errorText: string) => void,
    idPrefix: string,
    atPrefix: string,
    overrides: MemberOverrides,
  ): void {
    const sanitizeList = (field: 'read_dirs' | 'write_dirs'): void => {
      const patterns = overrides[field];
      if (!patterns || patterns.length === 0) return;
      const forbidden = patterns.filter((p) => isForbiddenBuiltinAllowListPattern(p));
      if (forbidden.length === 0) return;

      overrides[field] = patterns.filter((p) => !isForbiddenBuiltinAllowListPattern(p));
      pushIssue(
        `${idPrefix}/${field}/forbidden_builtin_scopes`,
        `Invalid .minds/team.yaml: ${atPrefix}.${field} contains forbidden built-in scopes. These entries are ignored.`,
        forbidden
          .map(
            (p) =>
              `- ${atPrefix}.${field}: pattern '${p}' is forbidden (built-in hard deny for .minds/** and *.tsk/**).`,
          )
          .join('\n'),
      );
    };

    sanitizeList('read_dirs');
    sanitizeList('write_dirs');
  }

  function normalizeSoftOptionalMemberFields(
    pushIssue: (
      id: string,
      message: string,
      errorText: string,
      severity?: 'error' | 'warning',
    ) => void,
    idPrefix: string,
    atPrefix: string,
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
    let normalized: Record<string, unknown> | undefined;

    const getCurrent = (): Record<string, unknown> => normalized ?? raw;
    const ensureNormalized = (): Record<string, unknown> => {
      if (normalized === undefined) normalized = { ...raw };
      return normalized;
    };
    const dropField = (field: string): void => {
      const current = getCurrent();
      if (!hasOwnKey(current, field)) return;
      delete ensureNormalized()[field];
    };
    const warnNullField = (field: string): void => {
      pushIssue(
        `${idPrefix}/${sanitizeProblemIdSegment(field)}/null_ignored`,
        `Warning in .minds/team.yaml: ${atPrefix}.${field} is null and will be ignored.`,
        `${atPrefix}.${field} uses YAML null. Dominds treats this as "unset" and ignores it; delete the field or provide a valid value if you want it to take effect.`,
        'warning',
      );
    };
    const warnInvalidField = (field: string, errorText: string): void => {
      pushIssue(
        `${idPrefix}/${sanitizeProblemIdSegment(field)}/invalid_ignored`,
        `Warning in .minds/team.yaml: ${atPrefix}.${field} is invalid and will be ignored.`,
        `${errorText}\nThis field is optional for loading the member. Dominds ignores the invalid value and keeps the member usable; fix or delete it.`,
        'warning',
      );
    };
    const warnAliasConflict = (
      preferredField: 'fbr-effort' | 'diligence-push-max',
      ignoredField: 'fbr_effort' | 'diligence_push_max',
    ): void => {
      pushIssue(
        `${idPrefix}/${sanitizeProblemIdSegment(preferredField)}/alias_conflict_ignored`,
        `Warning in .minds/team.yaml: ${atPrefix} sets both ${preferredField} and ${ignoredField}; ${ignoredField} will be ignored.`,
        `Both ${atPrefix}.${preferredField} and ${atPrefix}.${ignoredField} are set. Dominds keeps ${atPrefix}.${preferredField} and ignores ${atPrefix}.${ignoredField}; remove one for clarity.`,
        'warning',
      );
    };
    const validateFbrEffort = (value: unknown, at: string): void => {
      const effort = requireDefined(asOptionalNumber(value, at), at);
      if (!Number.isInteger(effort)) {
        throw new Error(`Invalid ${at}: expected an integer (got ${effort}).`);
      }
      if (effort < 0) {
        throw new Error(`Invalid ${at}: expected >= 0 (got ${effort}).`);
      }
      if (effort > 100) {
        throw new Error(`Invalid ${at}: expected <= 100 (got ${effort}).`);
      }
    };
    const validateOptionalField = (
      field: string,
      validate: (value: unknown, at: string) => void,
    ): void => {
      const current = getCurrent();
      if (!hasOwnKey(current, field)) return;
      const value = current[field];
      if (value === null) {
        dropField(field);
        warnNullField(field);
        return;
      }
      try {
        validate(value, `${atPrefix}.${field}`);
      } catch (err: unknown) {
        dropField(field);
        warnInvalidField(field, asErrorText(err));
      }
    };

    if (hasOwnKey(getCurrent(), 'fbr-effort') && hasOwnKey(getCurrent(), 'fbr_effort')) {
      dropField('fbr_effort');
      warnAliasConflict('fbr-effort', 'fbr_effort');
    }
    if (
      hasOwnKey(getCurrent(), 'diligence-push-max') &&
      hasOwnKey(getCurrent(), 'diligence_push_max')
    ) {
      dropField('diligence_push_max');
      warnAliasConflict('diligence-push-max', 'diligence_push_max');
    }

    validateOptionalField('name', (value, at) => {
      requireDefined(asOptionalString(value, at), at);
    });
    validateOptionalField('gofor', (value, at) => {
      requireDefined(asOptionalGofor(value, at), at);
    });
    validateOptionalField('nogo', (value, at) => {
      requireDefined(asOptionalGofor(value, at), at);
    });
    validateOptionalField('toolsets', (value, at) => {
      requireDefined(asOptionalStringArray(value, at), at);
    });
    validateOptionalField('tools', (value, at) => {
      requireDefined(asOptionalStringArray(value, at), at);
    });
    validateOptionalField('model_params', (value, at) => {
      requireDefined(asOptionalModelParams(value, at), at);
    });
    validateOptionalField('fbr-effort', validateFbrEffort);
    validateOptionalField('fbr_effort', validateFbrEffort);
    validateOptionalField('fbr_model_params', (value, at) => {
      requireDefined(asOptionalModelParams(value, at), at);
    });
    validateOptionalField('diligence-push-max', (value, at) => {
      requireDefined(asOptionalNumber(value, at), at);
    });
    validateOptionalField('diligence_push_max', (value, at) => {
      requireDefined(asOptionalNumber(value, at), at);
    });
    validateOptionalField('icon', (value, at) => {
      requireDefined(asOptionalString(value, at), at);
    });
    validateOptionalField('streaming', (value, at) => {
      requireDefined(asOptionalBoolean(value, at), at);
    });
    validateOptionalField('hidden', (value, at) => {
      requireDefined(asOptionalBoolean(value, at), at);
    });

    return normalized ?? raw;
  }

  function parseMemberOverrides(
    rv: Record<string, unknown>,
    at: string,
  ): { kind: 'ok'; overrides: MemberOverrides } | { kind: 'error'; errorTexts: string[] } {
    const overrides: MemberOverrides = {};
    const errors: string[] = [];

    if (hasOwnKey(rv, 'name')) {
      try {
        overrides.name = requireDefined(asOptionalString(rv['name'], `${at}.name`), `${at}.name`);
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'provider')) {
      try {
        overrides.provider = requireDefined(
          asOptionalString(rv['provider'], `${at}.provider`),
          `${at}.provider`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'model')) {
      try {
        overrides.model = requireDefined(
          asOptionalString(rv['model'], `${at}.model`),
          `${at}.model`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'gofor')) {
      try {
        overrides.gofor = requireDefined(
          asOptionalGofor(rv['gofor'], `${at}.gofor`),
          `${at}.gofor`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'nogo')) {
      try {
        overrides.nogo = requireDefined(asOptionalGofor(rv['nogo'], `${at}.nogo`), `${at}.nogo`);
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'toolsets')) {
      try {
        overrides.toolsets = requireDefined(
          asOptionalStringArray(rv['toolsets'], `${at}.toolsets`),
          `${at}.toolsets`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'tools')) {
      try {
        overrides.tools = requireDefined(
          asOptionalStringArray(rv['tools'], `${at}.tools`),
          `${at}.tools`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'model_params')) {
      try {
        overrides.model_params = requireDefined(
          asOptionalModelParams(rv['model_params'], `${at}.model_params`),
          `${at}.model_params`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    const hasFbrEffortDash = hasOwnKey(rv, 'fbr-effort');
    const hasFbrEffortUnderscore = hasOwnKey(rv, 'fbr_effort');
    if (hasFbrEffortDash && hasFbrEffortUnderscore) {
      errors.push(
        `Invalid ${at}: both fbr-effort and fbr_effort are set; please use only fbr-effort.`,
      );
    } else if (hasFbrEffortDash) {
      try {
        const effort = requireDefined(
          asOptionalNumber(rv['fbr-effort'], `${at}.fbr-effort`),
          `${at}.fbr-effort`,
        );
        if (!Number.isInteger(effort)) {
          throw new Error(`Invalid ${at}.fbr-effort: expected an integer (got ${effort}).`);
        }
        if (effort < 0) {
          throw new Error(`Invalid ${at}.fbr-effort: expected >= 0 (got ${effort}).`);
        }
        if (effort > 100) {
          throw new Error(`Invalid ${at}.fbr-effort: expected <= 100 (got ${effort}).`);
        }
        overrides.fbr_effort = effort;
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    } else if (hasFbrEffortUnderscore) {
      try {
        const effort = requireDefined(
          asOptionalNumber(rv['fbr_effort'], `${at}.fbr_effort`),
          `${at}.fbr_effort`,
        );
        if (!Number.isInteger(effort)) {
          throw new Error(`Invalid ${at}.fbr_effort: expected an integer (got ${effort}).`);
        }
        if (effort < 0) {
          throw new Error(`Invalid ${at}.fbr_effort: expected >= 0 (got ${effort}).`);
        }
        if (effort > 100) {
          throw new Error(`Invalid ${at}.fbr_effort: expected <= 100 (got ${effort}).`);
        }
        overrides.fbr_effort = effort;
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'fbr_model_params')) {
      try {
        overrides.fbr_model_params = requireDefined(
          asOptionalModelParams(rv['fbr_model_params'], `${at}.fbr_model_params`),
          `${at}.fbr_model_params`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    const hasDiligencePushMaxDash = hasOwnKey(rv, 'diligence-push-max');
    const hasDiligencePushMaxUnderscore = hasOwnKey(rv, 'diligence_push_max');
    if (hasDiligencePushMaxDash && hasDiligencePushMaxUnderscore) {
      errors.push(
        `Invalid ${at}: both diligence-push-max and diligence_push_max are set; please use only diligence-push-max.`,
      );
    } else if (hasDiligencePushMaxDash) {
      try {
        overrides.diligence_push_max = requireDefined(
          asOptionalNumber(rv['diligence-push-max'], `${at}.diligence-push-max`),
          `${at}.diligence-push-max`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    } else if (hasDiligencePushMaxUnderscore) {
      try {
        overrides.diligence_push_max = requireDefined(
          asOptionalNumber(rv['diligence_push_max'], `${at}.diligence_push_max`),
          `${at}.diligence_push_max`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'read_dirs')) {
      try {
        overrides.read_dirs = requireDefined(
          asOptionalStringArray(rv['read_dirs'], `${at}.read_dirs`),
          `${at}.read_dirs`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'write_dirs')) {
      try {
        overrides.write_dirs = requireDefined(
          asOptionalStringArray(rv['write_dirs'], `${at}.write_dirs`),
          `${at}.write_dirs`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'no_read_dirs')) {
      try {
        overrides.no_read_dirs = requireDefined(
          asOptionalStringArray(rv['no_read_dirs'], `${at}.no_read_dirs`),
          `${at}.no_read_dirs`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'no_write_dirs')) {
      try {
        overrides.no_write_dirs = requireDefined(
          asOptionalStringArray(rv['no_write_dirs'], `${at}.no_write_dirs`),
          `${at}.no_write_dirs`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'read_file_ext_names')) {
      try {
        overrides.read_file_ext_names = requireDefined(
          asOptionalStringArray(rv['read_file_ext_names'], `${at}.read_file_ext_names`),
          `${at}.read_file_ext_names`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'write_file_ext_names')) {
      try {
        overrides.write_file_ext_names = requireDefined(
          asOptionalStringArray(rv['write_file_ext_names'], `${at}.write_file_ext_names`),
          `${at}.write_file_ext_names`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'no_read_file_ext_names')) {
      try {
        overrides.no_read_file_ext_names = requireDefined(
          asOptionalStringArray(rv['no_read_file_ext_names'], `${at}.no_read_file_ext_names`),
          `${at}.no_read_file_ext_names`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'no_write_file_ext_names')) {
      try {
        overrides.no_write_file_ext_names = requireDefined(
          asOptionalStringArray(rv['no_write_file_ext_names'], `${at}.no_write_file_ext_names`),
          `${at}.no_write_file_ext_names`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'icon')) {
      try {
        overrides.icon = requireDefined(asOptionalString(rv['icon'], `${at}.icon`), `${at}.icon`);
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'streaming')) {
      try {
        overrides.streaming = requireDefined(
          asOptionalBoolean(rv['streaming'], `${at}.streaming`),
          `${at}.streaming`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'hidden')) {
      try {
        overrides.hidden = requireDefined(
          asOptionalBoolean(rv['hidden'], `${at}.hidden`),
          `${at}.hidden`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }

    if (errors.length > 0) return { kind: 'error', errorTexts: errors };
    return { kind: 'ok', overrides };
  }

  function applyOverrides(member: Team.Member, overrides: MemberOverrides): void {
    if (overrides.name !== undefined) member.setName(overrides.name);
    if (overrides.provider !== undefined) member.setProvider(overrides.provider);
    if (overrides.model !== undefined) member.setModel(overrides.model);
    if (overrides.gofor !== undefined) member.setGofor(overrides.gofor);
    if (overrides.nogo !== undefined) member.setNogo(overrides.nogo);
    if (overrides.toolsets !== undefined) member.setToolsets(overrides.toolsets);
    if (overrides.tools !== undefined) member.setTools(overrides.tools);
    if (overrides.model_params !== undefined) member.setModelParams(overrides.model_params);
    if (overrides.fbr_effort !== undefined) member.setFbrEffort(overrides.fbr_effort);
    if (overrides.fbr_model_params !== undefined)
      member.setFbrModelParams(overrides.fbr_model_params);
    if (overrides.diligence_push_max !== undefined)
      member.setDiligencePushMax(overrides.diligence_push_max);
    if (overrides.read_dirs !== undefined) member.setReadDirs(overrides.read_dirs);
    if (overrides.write_dirs !== undefined) member.setWriteDirs(overrides.write_dirs);
    if (overrides.no_read_dirs !== undefined) member.setNoReadDirs(overrides.no_read_dirs);
    if (overrides.no_write_dirs !== undefined) member.setNoWriteDirs(overrides.no_write_dirs);
    if (overrides.read_file_ext_names !== undefined)
      member.setReadFileExtNames(overrides.read_file_ext_names);
    if (overrides.write_file_ext_names !== undefined)
      member.setWriteFileExtNames(overrides.write_file_ext_names);
    if (overrides.no_read_file_ext_names !== undefined)
      member.setNoReadFileExtNames(overrides.no_read_file_ext_names);
    if (overrides.no_write_file_ext_names !== undefined)
      member.setNoWriteFileExtNames(overrides.no_write_file_ext_names);
    if (overrides.icon !== undefined) member.setIcon(overrides.icon);
    if (overrides.streaming !== undefined) member.setStreaming(overrides.streaming);
    if (overrides.hidden !== undefined) member.setHidden(overrides.hidden);
  }

  function parseTeamYamlObject(
    obj: unknown,
    md: Team.Member,
    shadow: { fuxi: Team.Member; pangu: Team.Member },
    deps: { appTeammates: ReadonlyArray<AppTeammatesSnippet> },
  ): { team: Team; issues: TeamYamlIssue[] } {
    const issues: TeamYamlIssue[] = [];
    const pushIssue = (
      id: string,
      message: string,
      errorText: string,
      severity: 'error' | 'warning' = 'error',
    ): void => {
      issues.push({ id, message, errorText, severity });
    };

    const appMembersByAppId = new Map<string, Record<string, unknown>>();
    for (const snip of deps.appTeammates) {
      appMembersByAppId.set(snip.appId, snip.members);
    }

    const teamObj: Record<string, unknown> = (() => {
      if (isRecordValue(obj)) return obj;
      pushIssue(
        'root',
        'Invalid .minds/team.yaml: expected an object at root.',
        `Invalid team config: expected an object (got ${describeValueType(obj)})`,
      );
      return {};
    })();

    const unknownRootKeys = listUnknownKeys(teamObj, TEAM_YAML_ROOT_KEYS);
    if (unknownRootKeys.length > 0) {
      pushIssue(
        'root/unknown_fields',
        'Invalid .minds/team.yaml: unknown top-level fields.',
        buildUnknownFieldErrorText('root', unknownRootKeys, {}),
      );
    }

    // member_defaults
    const rawMemberDefaults = teamObj.member_defaults;
    if (rawMemberDefaults !== undefined) {
      if (!isRecordValue(rawMemberDefaults)) {
        pushIssue(
          'member_defaults',
          'Invalid .minds/team.yaml: member_defaults must be an object.',
          `Invalid member_defaults: expected an object (got ${describeValueType(rawMemberDefaults)})`,
        );
      } else {
        const normalizedMemberDefaults = normalizeSoftOptionalMemberFields(
          pushIssue,
          'member_defaults',
          'member_defaults',
          rawMemberDefaults,
        );
        validateCommonModelParamMisplacements(
          pushIssue,
          'member_defaults',
          'member_defaults',
          normalizedMemberDefaults,
        );
        const parsedMd = parseMemberOverrides(normalizedMemberDefaults, 'member_defaults');
        if (parsedMd.kind === 'ok') {
          sanitizeAllowListsForBuiltinScopes(
            pushIssue,
            'member_defaults',
            'member_defaults',
            parsedMd.overrides,
          );
          applyOverrides(md, parsedMd.overrides);
        } else {
          pushIssue(
            'member_defaults',
            'Invalid .minds/team.yaml: member_defaults has invalid fields.',
            parsedMd.errorTexts.join('\n'),
          );
        }
      }
    }
    // default_responder
    let defResp: string | undefined;
    if (teamObj.default_responder !== undefined) {
      try {
        defResp = asOptionalString(teamObj.default_responder, 'default_responder');
      } catch (err: unknown) {
        pushIssue(
          'default_responder/type',
          'Invalid .minds/team.yaml: default_responder must be a string.',
          asErrorText(err),
        );
      }
    }

    // shell_specialists
    let shellSpecialists: string[] = [];
    if (teamObj.shell_specialists !== undefined) {
      const v = teamObj.shell_specialists;
      if (v === null) {
        shellSpecialists = [];
      } else {
        try {
          const parsed = requireDefined(
            asOptionalStringOrStringArray(v, 'shell_specialists'),
            'shell_specialists',
          );
          // Normalize: drop empties and de-dupe while preserving order.
          const seen = new Set<string>();
          shellSpecialists = [];
          for (const id of parsed) {
            const trimmed = id.trim();
            if (trimmed === '') continue;
            if (seen.has(trimmed)) continue;
            seen.add(trimmed);
            shellSpecialists.push(trimmed);
          }
        } catch (err: unknown) {
          pushIssue(
            'shell_specialists/type',
            'Invalid .minds/team.yaml: shell_specialists must be string|string[] or null.',
            asErrorText(err),
          );
        }
      }
    }
    const membersRec: Record<string, Team.Member> = {};
    const rawMembers = teamObj.members;
    const membersObj: Record<string, unknown> = (() => {
      if (rawMembers === undefined) return {};
      if (isRecordValue(rawMembers)) return rawMembers;
      pushIssue(
        'members',
        'Invalid .minds/team.yaml: members must be an object.',
        `Invalid members: expected an object (got ${describeValueType(rawMembers)})`,
      );
      return {};
    })();

    for (const [id, raw] of Object.entries(membersObj)) {
      const memberAt = `members.${id}`;
      const idSeg = sanitizeProblemIdSegment(id);

      if (!isRecordValue(raw)) {
        pushIssue(
          `members/${idSeg}`,
          `Invalid .minds/team.yaml: ${memberAt} must be an object.`,
          `Invalid ${memberAt}: expected an object (got ${describeValueType(raw)})`,
        );
        continue;
      }

      // Cross-app teammate reference (v0): members.<id>.from + (use|import).
      // Surface Problems without crashing Team.load(); unresolved references keep loading other
      // members, but this member can still be omitted later if strict fields remain invalid.
      const effectiveRaw: Record<string, unknown> = (() => {
        const memberObj = raw;
        const hasFrom = hasOwnKey(memberObj, 'from');
        const hasUse = hasOwnKey(memberObj, 'use');
        const hasImport = hasOwnKey(memberObj, 'import');
        const fromRaw = hasFrom ? memberObj['from'] : undefined;
        const useRaw = hasUse ? memberObj['use'] : undefined;
        const importRaw = hasImport ? memberObj['import'] : undefined;

        // Problem id should stay short and stable: it is a UI address, not a stack trace.
        // This validator runs on the effective rtws `.minds/team.yaml` object.
        const definingScopeSeg = 'rtws';
        const memberPrefix = `members/${definingScopeSeg}/${idSeg}`;

        if (hasUse && hasImport) {
          pushIssue(
            `${memberPrefix}/use_and_import_conflict`,
            `Invalid .minds/team.yaml: ${memberAt} cannot specify both 'use' and 'import'.`,
            `Both ${memberAt}.use and ${memberAt}.import are present; remove one.`,
          );
          return memberObj;
        }

        if ((hasUse || hasImport) && !hasFrom) {
          pushIssue(
            `${memberPrefix}/from/missing`,
            `Invalid .minds/team.yaml: ${memberAt} uses cross-app member reference but is missing 'from'.`,
            `Either remove ${memberAt}.use/${memberAt}.import, or add ${memberAt}.from: <dep-app-id>.`,
          );
          return memberObj;
        }

        if (!hasFrom) return memberObj;

        if (typeof fromRaw !== 'string' || fromRaw.trim() === '') {
          pushIssue(
            `${memberPrefix}/from/invalid`,
            `Invalid .minds/team.yaml: ${memberAt}.from must be a non-empty string.`,
            `Invalid ${memberAt}.from: expected non-empty string (got ${describeValueType(fromRaw)})`,
          );
          return memberObj;
        }

        // `from`-only is accepted (v0 no-op): treat it as a local member definition.
        if (!hasUse && !hasImport) return memberObj;

        const refKind: 'use' | 'import' = hasUse ? 'use' : 'import';
        const refRaw = hasUse ? useRaw : importRaw;
        if (typeof refRaw !== 'string' || refRaw.trim() === '') {
          pushIssue(
            `${memberPrefix}/${refKind}/invalid`,
            `Invalid .minds/team.yaml: ${memberAt}.${refKind} must be a non-empty string.`,
            `Invalid ${memberAt}.${refKind}: expected non-empty string (got ${describeValueType(refRaw)})`,
          );
          return memberObj;
        }

        const fromAppId = fromRaw.trim();
        const refMemberId = refRaw.trim();
        const appMembers = appMembersByAppId.get(fromAppId);
        if (!appMembers) {
          pushIssue(
            `${memberPrefix}/from/unresolved_app`,
            `Invalid .minds/team.yaml: ${memberAt}.from refers to an app that is not enabled.`,
            `App '${fromAppId}' is not enabled (or does not export teammates YAML).`,
          );
          return memberObj;
        }

        const sourceRaw = appMembers[refMemberId];
        if (sourceRaw === undefined) {
          pushIssue(
            `${memberPrefix}/${refKind}/unresolved_member`,
            `Invalid .minds/team.yaml: ${memberAt}.${refKind} refers to a missing member in app '${fromAppId}'.`,
            `App '${fromAppId}' does not export member id '${refMemberId}'.`,
          );
          return memberObj;
        }
        if (!isRecordValue(sourceRaw)) {
          pushIssue(
            `${memberPrefix}/${refKind}/invalid_member`,
            `Invalid app teammates YAML: member '${refMemberId}' must be an object (app '${fromAppId}').`,
            `Expected app member '${fromAppId}.${refMemberId}' to be an object (got ${describeValueType(sourceRaw)}).`,
          );
          return memberObj;
        }

        const merged: Record<string, unknown> = { ...sourceRaw };
        for (const [k, v] of Object.entries(memberObj)) {
          if (k === 'from' || k === 'use' || k === 'import') continue;
          merged[k] = v;
        }
        return merged;
      })();
      const normalizedEffectiveRaw = normalizeSoftOptionalMemberFields(
        pushIssue,
        `members/${idSeg}`,
        memberAt,
        effectiveRaw,
      );

      validateCommonModelParamMisplacements(
        pushIssue,
        `members/${idSeg}`,
        memberAt,
        normalizedEffectiveRaw,
      );

      const parsedMember = parseMemberOverrides(normalizedEffectiveRaw, memberAt);
      if (parsedMember.kind === 'error') {
        pushIssue(
          `members/${idSeg}`,
          `Invalid .minds/team.yaml: ${memberAt} has invalid fields.`,
          parsedMember.errorTexts.join('\n'),
        );
        if (id === 'fuxi' || id === 'pangu') {
          // Shadow members are always present; ignore overrides on invalid config.
          const shadowMember = id === 'fuxi' ? shadow.fuxi : shadow.pangu;
          Object.setPrototypeOf(shadowMember, md);
          membersRec[id] = shadowMember;
        }
        continue;
      }

      sanitizeAllowListsForBuiltinScopes(
        pushIssue,
        `members/${idSeg}`,
        memberAt,
        parsedMember.overrides,
      );

      if (id === 'fuxi' || id === 'pangu') {
        const shadowMember = id === 'fuxi' ? shadow.fuxi : shadow.pangu;
        applyOverrides(shadowMember, parsedMember.overrides);
        Object.setPrototypeOf(shadowMember, md);
        membersRec[id] = shadowMember;
        continue;
      }

      const m = new Team.Member({ id, name: id });
      applyOverrides(m, parsedMember.overrides);
      Object.setPrototypeOf(m, md);
      membersRec[id] = m;
    }

    return {
      team: new Team({
        memberDefaults: md,
        defaultResponder: defResp,
        shellSpecialists,
        members: membersRec,
      }),
      issues,
    };
  }

  function asRecord(value: unknown, at: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Invalid ${at}: expected an object (got ${describeValueType(value)})`);
    }
    return value as Record<string, unknown>;
  }

  function asString(value: unknown, at: string): string {
    if (typeof value !== 'string') {
      throw new Error(`Invalid ${at}: expected a string (got ${describeValueType(value)})`);
    }
    return value;
  }

  function asOptionalString(value: unknown, at: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new Error(`Invalid ${at}: expected a string (got ${describeValueType(value)})`);
    }
    return value;
  }

  function asOptionalBoolean(value: unknown, at: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      throw new Error(`Invalid ${at}: expected a boolean (got ${describeValueType(value)})`);
    }
    return value;
  }

  function asOptionalNumber(value: unknown, at: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Invalid ${at}: expected a number (got ${describeValueType(value)})`);
    }
    return value;
  }

  function asOptionalStringArray(value: unknown, at: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new Error(`Invalid ${at}: expected string[] (got ${describeValueType(value)})`);
    }
    return value;
  }

  function describeValueType(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';

    if (Array.isArray(value)) {
      if (value.length === 0) return 'unknown[]';

      const elementTypes = new Set<string>();
      for (const v of value) {
        if (v === undefined) elementTypes.add('undefined');
        else if (v === null) elementTypes.add('null');
        else if (Array.isArray(v)) elementTypes.add('unknown[]');
        else elementTypes.add(typeof v);
      }

      const t = Array.from(elementTypes).sort();
      if (t.length === 1) return `${t[0]}[]`;
      return `(${t.join('|')})[]`;
    }

    return typeof value;
  }

  function asOptionalStringOrStringArray(value: unknown, at: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return [value];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value;
    }
    throw new Error(`Invalid ${at}: expected string|string[] (got ${describeValueType(value)})`);
  }

  function asOptionalGofor(
    value: unknown,
    at: string,
  ): string | string[] | Record<string, string> | undefined {
    if (value === undefined) return undefined;

    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const normalized: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        if (typeof item === 'string') {
          normalized.push(item);
          continue;
        }
        if (isRecordValue(item)) {
          const entries = Object.entries(item);
          if (entries.length !== 1) {
            throw new Error(
              `Invalid ${at}[${i}]: expected string or single-entry object (got ${describeValueType(item)})`,
            );
          }
          const [k, v] = entries[0];
          if (typeof v !== 'string') {
            throw new Error(
              `Invalid ${at}[${i}].${k}: expected string (got ${describeValueType(v)})`,
            );
          }
          normalized.push(`${k}: ${v}`);
          continue;
        }
        throw new Error(
          `Invalid ${at}[${i}]: expected string or single-entry object (got ${describeValueType(item)})`,
        );
      }
      return normalized;
    }

    if (isRecordValue(value)) {
      const obj = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string') {
          throw new Error(`Invalid ${at}.${k}: expected string (got ${describeValueType(v)})`);
        }
      }
      return obj as Record<string, string>;
    }

    throw new Error(
      `Invalid ${at}: expected string|string[]|Record<string,string> (got ${describeValueType(value)})`,
    );
  }

  function asOptionalStop(value: unknown, at: string): string | string[] | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;
    throw new Error(`Invalid ${at}: expected string|string[] (got ${describeValueType(value)})`);
  }

  function asOptionalLogitBias(value: unknown, at: string): Record<string, number> | undefined {
    if (value === undefined) return undefined;
    const obj = asRecord(value, at);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'number') {
        throw new Error(`Invalid ${at}.${k}: expected a number (got ${describeValueType(v)})`);
      }
    }
    return obj as Record<string, number>;
  }

  function asOptionalModelParams(value: unknown, at: string): ModelParams | undefined {
    if (value === undefined) return undefined;
    const obj = asRecord(value, at);

    const validateCodexParams = (params: Record<string, unknown>, at2: string): void => {
      asOptionalNumber(params.temperature, `${at2}.temperature`);
      asOptionalNumber(params.max_tokens, `${at2}.max_tokens`);
      asOptionalNumber(params.top_p, `${at2}.top_p`);
      asOptionalBoolean(params.parallel_tool_calls, `${at2}.parallel_tool_calls`);
      asOptionalBoolean(params.json_response, `${at2}.json_response`);
      const serviceTier = params.service_tier;
      if (
        serviceTier !== undefined &&
        serviceTier !== 'auto' &&
        serviceTier !== 'default' &&
        serviceTier !== 'flex' &&
        serviceTier !== 'scale' &&
        serviceTier !== 'priority'
      ) {
        throw new Error(
          `Invalid ${at2}.service_tier: expected auto|default|flex|scale|priority (got ${describeValueType(
            serviceTier,
          )})`,
        );
      }

      const reasoningEffort = params.reasoning_effort;
      if (
        reasoningEffort !== undefined &&
        reasoningEffort !== 'none' &&
        reasoningEffort !== 'minimal' &&
        reasoningEffort !== 'low' &&
        reasoningEffort !== 'medium' &&
        reasoningEffort !== 'high' &&
        reasoningEffort !== 'xhigh'
      ) {
        throw new Error(
          `Invalid ${at2}.reasoning_effort: expected none|minimal|low|medium|high|xhigh (got ${describeValueType(
            reasoningEffort,
          )})`,
        );
      }

      const reasoningSummary = params.reasoning_summary;
      if (
        reasoningSummary !== undefined &&
        reasoningSummary !== 'auto' &&
        reasoningSummary !== 'concise' &&
        reasoningSummary !== 'detailed' &&
        reasoningSummary !== 'none'
      ) {
        throw new Error(
          `Invalid ${at2}.reasoning_summary: expected auto|concise|detailed|none (got ${describeValueType(
            reasoningSummary,
          )})`,
        );
      }

      const verbosity = params.verbosity;
      if (
        verbosity !== undefined &&
        verbosity !== 'low' &&
        verbosity !== 'medium' &&
        verbosity !== 'high'
      ) {
        throw new Error(
          `Invalid ${at2}.verbosity: expected low|medium|high (got ${describeValueType(
            verbosity,
          )})`,
        );
      }

      const webSearch = params.web_search;
      if (
        webSearch !== undefined &&
        webSearch !== 'disabled' &&
        webSearch !== 'cached' &&
        webSearch !== 'live'
      ) {
        throw new Error(
          `Invalid ${at2}.web_search: expected disabled|cached|live (got ${describeValueType(
            webSearch,
          )})`,
        );
      }
    };

    const validateOpenAiParams = (params: Record<string, unknown>, at2: string): void => {
      asOptionalNumber(params.temperature, `${at2}.temperature`);
      asOptionalNumber(params.max_tokens, `${at2}.max_tokens`);
      asOptionalNumber(params.top_p, `${at2}.top_p`);
      asOptionalBoolean(params.parallel_tool_calls, `${at2}.parallel_tool_calls`);
      asOptionalString(params.safety_identifier, `${at2}.safety_identifier`);
      asOptionalString(params.text_format_json_schema_name, `${at2}.text_format_json_schema_name`);
      asOptionalString(params.text_format_json_schema, `${at2}.text_format_json_schema`);
      asOptionalBoolean(
        params.text_format_json_schema_strict,
        `${at2}.text_format_json_schema_strict`,
      );
      asOptionalBoolean(params.web_search_tool, `${at2}.web_search_tool`);
      asOptionalStringArray(params.web_search_allowed_domains, `${at2}.web_search_allowed_domains`);
      asOptionalBoolean(params.web_search_include_sources, `${at2}.web_search_include_sources`);

      const serviceTier = params.service_tier;
      if (
        serviceTier !== undefined &&
        serviceTier !== 'auto' &&
        serviceTier !== 'default' &&
        serviceTier !== 'flex' &&
        serviceTier !== 'scale' &&
        serviceTier !== 'priority'
      ) {
        throw new Error(
          `Invalid ${at2}.service_tier: expected auto|default|flex|scale|priority (got ${describeValueType(
            serviceTier,
          )})`,
        );
      }

      const reasoningEffort = params.reasoning_effort;
      if (
        reasoningEffort !== undefined &&
        reasoningEffort !== 'none' &&
        reasoningEffort !== 'minimal' &&
        reasoningEffort !== 'low' &&
        reasoningEffort !== 'medium' &&
        reasoningEffort !== 'high' &&
        reasoningEffort !== 'xhigh'
      ) {
        throw new Error(
          `Invalid ${at2}.reasoning_effort: expected none|minimal|low|medium|high|xhigh (got ${describeValueType(
            reasoningEffort,
          )})`,
        );
      }

      const reasoningSummary = params.reasoning_summary;
      if (
        reasoningSummary !== undefined &&
        reasoningSummary !== 'auto' &&
        reasoningSummary !== 'concise' &&
        reasoningSummary !== 'detailed' &&
        reasoningSummary !== 'none'
      ) {
        throw new Error(
          `Invalid ${at2}.reasoning_summary: expected auto|concise|detailed|none (got ${describeValueType(
            reasoningSummary,
          )})`,
        );
      }

      const verbosity = params.verbosity;
      if (
        verbosity !== undefined &&
        verbosity !== 'low' &&
        verbosity !== 'medium' &&
        verbosity !== 'high'
      ) {
        throw new Error(
          `Invalid ${at2}.verbosity: expected low|medium|high (got ${describeValueType(
            verbosity,
          )})`,
        );
      }

      const textFormat = params.text_format;
      if (
        textFormat !== undefined &&
        textFormat !== 'text' &&
        textFormat !== 'json_object' &&
        textFormat !== 'json_schema'
      ) {
        throw new Error(
          `Invalid ${at2}.text_format: expected text|json_object|json_schema (got ${describeValueType(
            textFormat,
          )})`,
        );
      }

      const webSearchContextSize = params.web_search_context_size;
      if (
        webSearchContextSize !== undefined &&
        webSearchContextSize !== 'low' &&
        webSearchContextSize !== 'medium' &&
        webSearchContextSize !== 'high'
      ) {
        throw new Error(
          `Invalid ${at2}.web_search_context_size: expected low|medium|high (got ${describeValueType(
            webSearchContextSize,
          )})`,
        );
      }

      const hasJsonSchemaDetails =
        params.text_format_json_schema_name !== undefined ||
        params.text_format_json_schema !== undefined ||
        params.text_format_json_schema_strict !== undefined;
      if (textFormat === 'json_schema') {
        if (params.text_format_json_schema_name === undefined) {
          throw new Error(
            `Invalid ${at2}: ${at2}.text_format=json_schema requires ${at2}.text_format_json_schema_name.`,
          );
        }
        if (params.text_format_json_schema === undefined) {
          throw new Error(
            `Invalid ${at2}: ${at2}.text_format=json_schema requires ${at2}.text_format_json_schema.`,
          );
        }
      } else if (hasJsonSchemaDetails) {
        throw new Error(
          `Invalid ${at2}: text_format_json_schema_* fields require ${at2}.text_format=json_schema.`,
        );
      }
    };

    const codex = obj.codex === undefined ? undefined : asRecord(obj.codex, `${at}.codex`);
    const openai = obj.openai === undefined ? undefined : asRecord(obj.openai, `${at}.openai`);
    const anthropic =
      obj.anthropic === undefined ? undefined : asRecord(obj.anthropic, `${at}.anthropic`);
    const general = obj.general === undefined ? undefined : asRecord(obj.general, `${at}.general`);

    if (codex) validateCodexParams(codex, `${at}.codex`);
    if (openai) validateOpenAiParams(openai, `${at}.openai`);

    if (anthropic) {
      asOptionalNumber(anthropic.temperature, `${at}.anthropic.temperature`);
      asOptionalNumber(anthropic.max_tokens, `${at}.anthropic.max_tokens`);
      asOptionalNumber(anthropic.top_p, `${at}.anthropic.top_p`);
      asOptionalNumber(anthropic.top_k, `${at}.anthropic.top_k`);
      asOptionalStringArray(anthropic.stop_sequences, `${at}.anthropic.stop_sequences`);
      asOptionalBoolean(anthropic.reasoning_split, `${at}.anthropic.reasoning_split`);
      asOptionalBoolean(anthropic.json_response, `${at}.anthropic.json_response`);
    }

    asOptionalNumber(obj.max_tokens, `${at}.max_tokens`);
    asOptionalBoolean(obj.json_response, `${at}.json_response`);
    if (general) {
      asOptionalNumber(general.max_tokens, `${at}.general.max_tokens`);
    }

    const topLevelMaxTokens = obj.max_tokens;
    const generalMaxTokens = general ? general.max_tokens : undefined;
    if (topLevelMaxTokens !== undefined && generalMaxTokens !== undefined) {
      throw new Error(
        `Invalid ${at}: do not set both ${at}.max_tokens and ${at}.general.max_tokens.`,
      );
    }

    const out: ModelParams = {};
    const effectiveMaxTokens = (topLevelMaxTokens ?? generalMaxTokens) as number | undefined;
    if (effectiveMaxTokens !== undefined) out.max_tokens = effectiveMaxTokens;
    if (obj.json_response !== undefined) out.json_response = obj.json_response as boolean;
    if (codex) out.codex = codex as CodexModelParams;
    if (openai) out.openai = openai as OpenAiModelParams;
    if (anthropic) out.anthropic = anthropic as ModelParams['anthropic'];
    return out;
  }
}
