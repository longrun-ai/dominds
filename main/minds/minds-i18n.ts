import type { LanguageCode } from '../shared/types/language';

export function defaultPersonaText(language: LanguageCode): string {
  return language === 'zh' ? '你是一个乐于助人的助手。' : 'You are a helpful assistant.';
}

export function noneText(language: LanguageCode): string {
  return language === 'zh' ? '无。' : 'None.';
}

export function noneRequiredFieldsText(language: LanguageCode): string {
  return language === 'zh' ? '无' : 'None';
}

export function funcToolUsageLabels(language: LanguageCode): {
  toolLabel: string;
  invocationLabel: string;
  invocationBody: string;
  requiredLabel: string;
  parametersLabel: string;
} {
  if (language === 'zh') {
    return {
      toolLabel: '函数工具',
      invocationLabel: '调用方式',
      invocationBody: '原生函数工具调用（严格 JSON 参数）',
      requiredLabel: '必填字段',
      parametersLabel: '参数',
    };
  }

  return {
    toolLabel: 'Function Tool',
    invocationLabel: 'Invocation',
    invocationBody: 'native function calling with strict JSON arguments',
    requiredLabel: 'Required fields',
    parametersLabel: 'Parameters',
  };
}

export function funcToolRulesText(language: LanguageCode): string {
  return language === 'zh'
    ? `\n- 对所有函数工具一律使用原生 function-calling；不要尝试用诉请行（例如 \`!?@name\`）调用它们。\n- 参数必须是严格 JSON：与 schema 精确匹配，包含所有 required 字段，不允许额外字段。`
    : `\n- Use native function-calling for all function tools listed; do not attempt tellask lines (e.g., \`!?@name\`) for these.\n- Provide strict JSON arguments that match the tool schema exactly; include all required fields; no extra fields.`;
}

export function taskdocCanonicalCopy(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      '**Taskdoc 封装与访问限制**',
      '',
      '- 任何 `.tsk/` 目录及其子路径（`**/*.tsk/**`）都是封装状态：禁止使用任何通用文件工具读取/写入/列目录（例如 `read_file` / `write_file` / `list_dir` 等）。',
      '- 更新 Taskdoc 只能使用函数工具 `change_mind`（按分段整段替换）。',
      '',
      '**Taskdoc 自动注入规则（系统提示）**',
      '',
      '- 系统提示会把“有效 Taskdoc”自动注入到模型上下文中。',
      '- 一定会注入顶层三段：`goals.md`、`constraints.md`、`progress.md`（按此顺序）。',
      '- 可选注入 `bearinmind/`（仅固定白名单，最多 6 个文件）：`contracts.md`、`acceptance.md`、`grants.md`、`runbook.md`、`decisions.md`、`risks.md`。',
      '- 若存在 `bearinmind/` 注入块，它会以 `## Bear In Mind` 出现在 `## Constraints` 与 `## Progress` 之间，并按以上固定顺序拼接。',
      '- 除此之外，`.tsk/` 内任何其他目录/文件都不会被自动注入。',
    ].join('\n');
  }

  return [
    '**Taskdoc encapsulation & access restrictions**',
    '',
    '- Any `.tsk/` directory and its subpaths (`**/*.tsk/**`) are encapsulated state: general file tools MUST NOT read/write/list them (e.g. `read_file` / `write_file` / `list_dir`).',
    '- Taskdoc updates MUST go through the function tool `change_mind` (whole-section replace).',
    '',
    '**Taskdoc auto-injection rules (system prompt)**',
    '',
    '- The system prompt auto-injects the “effective Taskdoc” into the model context.',
    '- It always injects the three top-level sections in order: `goals.md`, `constraints.md`, `progress.md`.',
    '- It may also inject `bearinmind/` (fixed whitelist only; max 6 files): `contracts.md`, `acceptance.md`, `grants.md`, `runbook.md`, `decisions.md`, `risks.md`.',
    '- If present, the injected block appears as `## Bear In Mind` between `## Constraints` and `## Progress`, and the files are concatenated in the fixed order above.',
    '- No other directories/files inside `.tsk/` are auto-injected.',
  ].join('\n');
}

export function memoryPreambleLabels(language: LanguageCode): {
  pathLabel: string;
  lastModifiedLabel: string;
  sizeLabel: string;
  wordsLabel: string;
  bytesUnit: string;
  manageWithLabel: string;
} {
  if (language === 'zh') {
    return {
      pathLabel: '路径',
      lastModifiedLabel: '最后修改',
      sizeLabel: '大小',
      wordsLabel: '词数',
      bytesUnit: '字节',
      manageWithLabel: '可用工具',
    };
  }

  return {
    pathLabel: 'Path',
    lastModifiedLabel: 'Last modified',
    sizeLabel: 'Size',
    wordsLabel: 'Words',
    bytesUnit: 'bytes',
    manageWithLabel: 'Manage with',
  };
}

export function sharedScopeLabel(language: LanguageCode): string {
  return language === 'zh' ? '团队共享记忆' : 'Team Shared Memory';
}

export function personalScopeLabel(language: LanguageCode, agentId: string): string {
  return language === 'zh' ? `个人记忆 (@${agentId})` : `Personal Memory (@${agentId})`;
}

export function memoriesSummaryTitle(language: LanguageCode): string {
  return language === 'zh' ? '## 记忆摘要\n' : '## Memories Summary\n';
}

export function memoriesSummarySectionShared(language: LanguageCode): string {
  return language === 'zh' ? '### 共享' : '### Shared';
}

export function memoriesSummarySectionPersonal(language: LanguageCode): string {
  return language === 'zh' ? '### 个人\n' : '### Personal\n';
}

export function memoriesSummaryLineShared(language: LanguageCode, path: string): string {
  return language === 'zh' ? `- 共享: ${path}` : `- Shared: ${path}`;
}

export function memoriesSummaryLinePersonal(language: LanguageCode, path: string): string {
  return language === 'zh' ? `- 个人: ${path}` : `- Personal: ${path}`;
}

export function sharedMemoriesHeader(language: LanguageCode): string {
  return language === 'zh' ? '## 共享记忆' : '## Shared Memories';
}

export function personalMemoriesHeader(language: LanguageCode): string {
  return language === 'zh' ? '## 个人记忆\n' : '## Personal Memories\n';
}
