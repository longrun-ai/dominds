import type { LanguageCode } from '../shared/types/language';

export function defaultPersonaText(language: LanguageCode): string {
  return language === 'zh' ? '你是一个乐于助人的助手。' : 'You are a helpful assistant.';
}

export function noneText(language: LanguageCode): string {
  return language === 'zh' ? '无。' : 'None.';
}

export function noTextingToolsText(language: LanguageCode): string {
  return language === 'zh' ? '没有可用的诉请工具。' : 'No tellask tools available.';
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
