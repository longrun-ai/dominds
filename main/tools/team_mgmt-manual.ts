import type { TeamMgmtGuideTopicKey } from '@longrun-ai/kernel';
import { getTeamMgmtGuideTopicTitle, isTeamMgmtGuideTopicKey } from '@longrun-ai/kernel';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

import {
  renderBuiltinDefaults,
  renderEnvManual,
  renderMemberProperties,
  renderMindsManual,
  renderModelParamsManual,
  renderPermissionsManual,
  renderPrimingManual,
  renderSkillsManual,
  renderTeamManual,
  renderToolsets,
  renderTroubleshooting,
} from './team_mgmt';
import { renderMcpManual } from './team_mgmt-mcp-manual';

type ManualTopic = TeamMgmtGuideTopicKey;

function fmtHeader(title: string): string {
  return `# ${title}\n`;
}

function fmtList(items: string[]): string {
  return (
    items
      .filter((s) => s.trim() !== '')
      .map((s) => `- ${s}`)
      .join('\n') + '\n'
  );
}

function parseTeamMgmtGuideTopics(topicsRaw: readonly string[]): ManualTopic[] {
  const topics: ManualTopic[] = [];
  for (const token0 of topicsRaw) {
    const token = token0.trim().startsWith('!') ? token0.trim().slice(1) : token0.trim();
    if (token === '') continue;
    if (isTeamMgmtGuideTopicKey(token)) {
      topics.push(token);
      continue;
    }
    throw new Error(`Unknown topic: ${token0}`);
  }
  return topics;
}

export async function renderTeamMgmtGuideContent(
  language: LanguageCode,
  topicsRaw: readonly string[] = [],
): Promise<string> {
  const topics = parseTeamMgmtGuideTopics(topicsRaw);
  const msgPrefix =
    language === 'zh'
      ? `（生成时间：${formatUnifiedTimestamp(new Date())}）\n\n`
      : `(Generated: ${formatUnifiedTimestamp(new Date())})\n\n`;

  const renderIndex = (): string => {
    const topicTitle = (key: TeamMgmtGuideTopicKey): string =>
      getTeamMgmtGuideTopicTitle(language, key);
    if (language === 'zh') {
      return (
        fmtHeader('Team Management Manual') +
        msgPrefix +
        fmtList([
          `\`man({ "toolsetId": "team_mgmt", "topics": ["topics"] })\`：${topicTitle('topics')}（你在这里）`,
          '新手最常见流程：先 `team_mgmt_list_providers({})` / `team_mgmt_list_models({ provider_pattern: "*", model_pattern: "*" })` 确认 provider/model keys → 再写 `.minds/team.yaml` → 再写 `.minds/team/<id>/persona.*.md` → 再跑 `team_mgmt_check_provider({ provider_key: "<providerKey>", model: "", all_models: false, live: false })`。',
          '',
          `\`man({ "toolsetId": "team_mgmt", "topics": ["team"] })\`：${topicTitle('team')} — .minds/team.yaml（团队花名册、工具集、目录权限入口）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["minds"] })\`：${topicTitle('minds')} — .minds/team/<id>/*（persona/knowhow/pitfalls 资产怎么写）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["skills"] })\`：${topicTitle('skills')} — .minds/skills/*（公开 skill 格式迁移、字段映射、app 化边界）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["priming"] })\`：${topicTitle('priming')} — .minds/priming/*（启动脚本如何编写、维护与复用）`,
          '`启动脚本修改后建议立即运行：`team_mgmt_validate_priming_scripts({})`',
          `\`man({ "toolsetId": "team_mgmt", "topics": ["env"] })\`：${topicTitle('env')} — .minds/env.*.md（运行环境提示：在团队介绍之前注入）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["permissions"] })\`：${topicTitle('permissions')} — 目录+扩展名权限（*_dirs/no_*_dirs/*_file_ext_names/no_*_file_ext_names 语义与冲突规则）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["toolsets"] })\`：${topicTitle('toolsets')} — toolsets 列表（当前已注册 toolsets；常见三种授权模式）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["llm"] })\`：${topicTitle('llm')} — .minds/llm.yaml（provider key 如何定义/引用；env var 安全边界）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })\`：${topicTitle('mcp')} — .minds/mcp.yaml（MCP serverId→toolset；热重载与租用；可复制最小模板）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["troubleshooting"] })\`：${topicTitle('troubleshooting')} — 按症状定位；优先 list_providers/list_models → check_provider`,
          '',
          `\`man({ "toolsetId": "team_mgmt", "topics": ["team","member-properties"] })\`：${topicTitle('team')} + ${topicTitle('member-properties')} — 成员字段表（members.<id> 字段参考）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["llm","builtin-defaults"] })\`：${topicTitle('llm')} + ${topicTitle('builtin-defaults')} — 内置 defaults 摘要（内置 provider/model 概览与合并语义）`,
          `\`man({ "toolsetId": "team_mgmt", "topics": ["llm","model-params"] })\`：${topicTitle('llm')} + ${topicTitle('model-params')} — 模型参数参考（model_params / model_param_options）`,
        ])
      );
    }
    return (
      fmtHeader('Team Management Manual') +
      msgPrefix +
      fmtList([
        `\`man({ "toolsetId": "team_mgmt", "topics": ["topics"] })\`: ${topicTitle('topics')} (you are here)`,
        'Common starter flow: run `team_mgmt_list_providers({})` / `team_mgmt_list_models({ provider_pattern: "*", model_pattern: "*" })` to confirm provider/model keys → write `.minds/team.yaml` → write `.minds/team/<id>/persona.*.md` → run `team_mgmt_check_provider({ provider_key: "<providerKey>", model: "", all_models: false, live: false })`. ',
        '',
        `\`man({ "toolsetId": "team_mgmt", "topics": ["team"] })\`: ${topicTitle('team')} — .minds/team.yaml (roster/toolsets/permissions entrypoint)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["minds"] })\`: ${topicTitle('minds')} — .minds/team/<id>/* (persona/knowhow/pitfalls assets)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["skills"] })\`: ${topicTitle('skills')} — .minds/skills/* (public skill migration, field mapping, app boundary)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["priming"] })\`: ${topicTitle('priming')} — .minds/priming/* (how to author, maintain, and reuse startup scripts)`,
        'After editing startup scripts, run: `team_mgmt_validate_priming_scripts({})`.',
        `\`man({ "toolsetId": "team_mgmt", "topics": ["env"] })\`: ${topicTitle('env')} — .minds/env.*.md (runtime intro injected before Team Directory)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["permissions"] })\`: ${topicTitle('permissions')} — directory + extension permissions (semantics + conflict rules)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["toolsets"] })\`: ${topicTitle('toolsets')} — toolsets list (registered toolsets + common patterns)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["llm"] })\`: ${topicTitle('llm')} — .minds/llm.yaml (provider keys, env var boundaries)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })\`: ${topicTitle('mcp')} — .minds/mcp.yaml (serverId→toolset, hot reload, leasing, minimal templates)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["troubleshooting"] })\`: ${topicTitle('troubleshooting')} — symptom → steps; start with list_providers/list_models, then check_provider`,
        '',
        `\`man({ "toolsetId": "team_mgmt", "topics": ["team","member-properties"] })\`: ${topicTitle('team')} + ${topicTitle('member-properties')} — member field reference (members.<id>)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["llm","builtin-defaults"] })\`: ${topicTitle('llm')} + ${topicTitle('builtin-defaults')} — built-in defaults summary (what/when/merge behavior)`,
        `\`man({ "toolsetId": "team_mgmt", "topics": ["llm","model-params"] })\`: ${topicTitle('llm')} + ${topicTitle('model-params')} — \`model_params\` and \`model_param_options\` reference`,
      ])
    );
  };

  const want = (t: ManualTopic): boolean => topics.includes(t);

  if (topics.length === 0) {
    return renderIndex();
  }
  if (want('topics')) {
    return renderIndex();
  }
  if (want('team') && want('member-properties')) {
    return renderMemberProperties(language);
  }
  if (want('team')) {
    return renderTeamManual(language);
  }
  if (want('llm') && want('builtin-defaults')) {
    return await renderBuiltinDefaults(language);
  }
  if (want('llm') && want('model-params')) {
    return await renderModelParamsManual(language);
  }
  if (want('llm')) {
    return language === 'zh'
      ? fmtHeader('.minds/llm.yaml') +
          fmtList([
            '定义 provider key → model 映射（用于 `.minds/team.yaml` 的 `member_defaults.provider` / `members.<id>.provider` 引用）。',
            '快速自检：用 `team_mgmt_list_providers({})` 列出内置/rtws provider keys、env var 是否配置；用 `team_mgmt_list_models({ source: "effective", provider_pattern: "*", model_pattern: "*" })` 列出“合并后”的模型与 `model_param_options`。',
            '最小示例：\n```yaml\nproviders:\n  my_provider:\n    apiKeyEnvVar: MY_PROVIDER_API_KEY\n    models:\n      my_model: { name: "my-model-id" }\n```\n然后在 `.minds/team.yaml` 里引用 `provider: my_provider` / `model: my_model`。',
            '覆盖/合并语义：`.minds/llm.yaml` 会在内置 defaults 之上做覆盖（以当前实现为准）；定义一个 provider key 并不意味着“禁用其他内置 provider”。',
            '不要在文件里存 API key，使用环境变量（apiKeyEnvVar）。',
            'member_defaults.provider/model 需要引用这里的 key。',
            '`model_param_options` 可选：用于记录该 provider 支持的 `.minds/team.yaml model_params` 选项（文档用途）。',
            '`apiQuirks` 可选：写在 `providers.<providerKey>.apiQuirks`，类型是 `string|string[]`；需要多个 quirk 时用数组，例如 `apiQuirks: [same-context-empty-response]`。它是 provider 级 transport / 网关兼容开关，用来描述“这个供应商/网关的 API 有非标准行为”，不是 `.minds/team.yaml` 的成员参数，也不是 `model_params`。',
            '使用原则：只有在你确认某个上游网关确实偏离了标准协议，而且 Dominds 已为这个偏差实现了命名 quirk 时才配置；不要把它当作随意调参入口。当前实现里，未知 quirk 值通常不会报错，但也不会带来任何效果。',
            '当前已知示例：OpenAI Responses 包装层支持 `apiQuirks: xcode.best`（或数组里包含它），用于识别 vendor keepalive、处理 xcode.best 特有的失败模式，以及把网关返回的 HTML 版 502 Bad Gateway 错误页和 `500 auth_unavailable: no auth available` 这类基础设施失败归类为 conservative 策略重试。OpenAI-compatible Chat Completions 包装层支持 `apiQuirks: same-context-empty-response`，用于“同一对话 generation 上下文连续返回 empty response”时先做少量临时重试；支持 `apiQuirks: volcengine-invalid-parameter-aggressive-retry`，用于火山方舟 Coding Plan 偶发 `400 InvalidParameter` 但同 payload 可重放成功的场景，将其归类为 aggressive 策略重试；支持内置 `kimi-code` provider 使用的 `apiQuirks: kimi-code`，用于 Kimi Code 专用 User-Agent（`KimiCLI/Dominds/<version>`）、`prompt_cache_key` 和 `thinking`/`reasoning_effort` 请求整形；也支持 `apiQuirks: minimax-reasoning-details`，用于 MiniMax OpenAI-compatible `/v1` 默认启用 `reasoning_split: true`，并跨轮完整保留 `reasoning_details`。最小示例：\n```yaml\nproviders:\n  my_gateway:\n    apiType: openai-compatible\n    baseUrl: https://example.invalid/v1\n    apiKeyEnvVar: MY_GATEWAY_API_KEY\n    apiQuirks: same-context-empty-response\n    models:\n      my_model: { name: "upstream-model-id" }\n```',
            '边界提醒：`apiQuirks` 只影响实现里显式消费它的 provider/generator。就当前实现看，OpenAI Responses 与 OpenAI-compatible 路径会读取它；不要假设所有 `apiType` 都支持或需要它。若配置后行为仍异常，应继续检查上游网关文档、抓流事件类型，并结合 `team_mgmt_check_provider(...)` / 运行日志排查。',
          ])
      : fmtHeader('.minds/llm.yaml') +
          fmtList([
            'Defines provider keys → model keys (referenced by `.minds/team.yaml` via `member_defaults.provider` / `members.<id>.provider`).',
            'Quick checks: use `team_mgmt_list_providers({})` to list built-in/rtws providers + env-var readiness; use `team_mgmt_list_models({ source: "effective", provider_pattern: "*", model_pattern: "*" })` to list merged models and `model_param_options`.',
            'Minimal example:\n```yaml\nproviders:\n  my_provider:\n    apiKeyEnvVar: MY_PROVIDER_API_KEY\n    models:\n      my_model: { name: "my-model-id" }\n```\nThen reference `provider: my_provider` and `model: my_model` in `.minds/team.yaml`.',
            'Merge/override: `.minds/llm.yaml` overrides built-in defaults (per current implementation); defining one provider does not imply disabling other built-in providers.',
            'Do not store API keys in the file; use env vars via apiKeyEnvVar.',
            'member_defaults.provider/model must reference these keys.',
            'Optional: `model_param_options` documents `.minds/team.yaml model_params` knobs (documentation only).',
            '`apiQuirks` is optional under `providers.<providerKey>.apiQuirks`, with type `string|string[]`; use an array for multiple quirks, for example `apiQuirks: [same-context-empty-response]`. It is a provider-level transport / gateway compatibility switch for non-standard upstream API behavior. It is not a `.minds/team.yaml` member field and not part of `model_params`.',
            'Use it only when you have confirmed that an upstream gateway deviates from the expected protocol and Dominds has an explicitly named quirk for that deviation. Do not treat it as a generic tuning field. In the current implementation, unknown quirk values are usually ignored rather than rejected, so a typo may silently do nothing.',
            'Known current example: the OpenAI Responses wrapper supports `apiQuirks: xcode.best` (or an array containing it) for vendor keepalive recognition, xcode.best-specific failures, and gateway-returned HTML 502 Bad Gateway plus `500 auth_unavailable: no auth available` infrastructure failures. The OpenAI-compatible Chat Completions wrapper supports `apiQuirks: same-context-empty-response` for repeated empty responses in the same dialog generation context; `apiQuirks: volcengine-invalid-parameter-aggressive-retry` for Volcano Ark Coding Plan transient `400 InvalidParameter` failures where the same payload can succeed on replay, classified as aggressive retry; `apiQuirks: kimi-code` for the built-in Kimi Code provider request shaping: `KimiCLI/Dominds/<version>` User-Agent, `prompt_cache_key`, and `thinking`/`reasoning_effort`; and `apiQuirks: minimax-reasoning-details` for MiniMax OpenAI-compatible `/v1`, enabling `reasoning_split: true` by default and preserving `reasoning_details` across turns. Minimal example:\n```yaml\nproviders:\n  my_gateway:\n    apiType: openai-compatible\n    baseUrl: https://example.invalid/v1\n    apiKeyEnvVar: MY_GATEWAY_API_KEY\n    apiQuirks: same-context-empty-response\n    models:\n      my_model: { name: "upstream-model-id" }\n```',
            'Boundary reminder: `apiQuirks` only affects providers/generators that explicitly read it in code. In the current implementation, the OpenAI Responses and OpenAI-compatible paths consume it; do not assume every `apiType` supports or needs it. If behavior is still wrong after setting it, continue with upstream gateway docs, raw stream event inspection, and `team_mgmt_check_provider(...)` / runtime logs.',
          ]);
  }
  if (want('mcp')) {
    return await renderMcpManual(language);
  }
  if (want('minds')) {
    return renderMindsManual(language);
  }
  if (want('skills')) {
    return renderSkillsManual(language);
  }
  if (want('priming')) {
    return renderPrimingManual(language);
  }
  if (want('env')) {
    return renderEnvManual(language);
  }
  if (want('permissions')) {
    return renderPermissionsManual(language);
  }
  if (want('toolsets')) {
    return await renderToolsets(language);
  }
  if (want('troubleshooting')) {
    return renderTroubleshooting(language);
  }

  return renderIndex();
}
