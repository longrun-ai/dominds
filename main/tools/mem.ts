/**
 * Module: tools/mem
 *
 * Memory management tools for personal and shared memory under `.minds/memory`.
 * Add, drop, replace, clear operations with strict path validation.
 */
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import fs from 'fs';
import path from 'path';
import { formatToolActionResult } from '../runtime/tool-result-messages';
import { getWorkLanguage } from '../runtime/work-language';
import type { Team } from '../team';
import type { FuncTool, ToolArguments, ToolCallOutput } from '../tool';
import { toolFailure, toolSuccess } from '../tool';

type MemoryPathResult =
  | Readonly<{ kind: 'ok'; rel: string }>
  | Readonly<{ kind: 'invalid_path'; message: string }>;

function getMemoryPath(params: {
  language: LanguageCode;
  caller: Team.Member;
  filePath: string;
  isShared?: boolean;
}): MemoryPathResult {
  if (path.isAbsolute(params.filePath)) {
    return {
      kind: 'invalid_path',
      message:
        params.language === 'zh'
          ? '❌ **错误**\n\n记忆路径必须是相对路径（不允许以 `/` 开头）。'
          : '❌ **Error**\n\nMemory paths must be relative (absolute paths are not allowed).',
    };
  }

  // Prevent path traversal by rejecting paths with '..'
  if (params.filePath.includes('..')) {
    return {
      kind: 'invalid_path',
      message:
        params.language === 'zh'
          ? '❌ **错误**\n\n记忆路径不允许包含 `..`（禁止路径穿越）。'
          : '❌ **Error**\n\nPath traversal is not allowed in memory paths (`..` is forbidden).',
    };
  }

  const mindsDir = '.minds/memory';
  const isShared = params.isShared === true;

  // Personal memory is automatically namespaced by caller.id on disk.
  // Reject patterns like "<your-id>/..." to prevent confusing nested directories.
  if (
    !isShared &&
    (params.filePath === params.caller.id || params.filePath.startsWith(`${params.caller.id}/`))
  ) {
    return {
      kind: 'invalid_path',
      message:
        params.language === 'zh'
          ? `❌ **错误**\n\n个人记忆路径（path）不应包含你的成员 id（\`${params.caller.id}\`）。系统会自动按当前智能体隔离个人记忆，请直接写 \`project/todo\` 这类路径。`
          : `❌ **Error**\n\nPersonal memory path (path) must not include your member id (\`${params.caller.id}\`). Dominds already isolates personal memory by agent; use a path like \`project/todo\`.`,
    };
  }

  const rel = isShared
    ? path.join(mindsDir, 'team_shared', params.filePath)
    : path.join(mindsDir, 'individual', params.caller.id, params.filePath);

  return { kind: 'ok', rel };
}

export const addPersonalMemoryTool: FuncTool = {
  type: 'func',
  name: 'add_personal_memory',
  description: 'Add a new memory file to the personal memory store (private to the current agent).',
  descriptionI18n: {
    en: 'Add a new memory file to the personal memory store (private to the current agent).',
    zh: '向个人记忆库新增一个记忆文件（仅当前智能体可见）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'Relative path inside your personal memory store.' },
      content: { type: 'string', description: 'Memory content (written as-is).' },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const pathValue = args['path'];
    const contentValue = args['content'];
    const filePath = typeof pathValue === 'string' ? pathValue.trim() : '';
    const content = typeof contentValue === 'string' ? contentValue : '';
    if (!filePath) {
      return toolFailure(
        language === 'zh' ? '错误：需要提供文件路径。' : 'Error: File path is required.',
      );
    }
    if (content.length === 0) {
      return toolFailure(
        language === 'zh'
          ? '错误：需要提供记忆内容（content）。'
          : 'Error: Memory content is required (content).',
      );
    }

    const memoryPath = getMemoryPath({ language, caller, filePath });
    if (memoryPath.kind === 'invalid_path') {
      return toolFailure(memoryPath.message);
    }

    const fullPath = path.resolve(process.cwd(), memoryPath.rel);

    if (fs.existsSync(fullPath)) {
      return toolFailure(
        language === 'zh'
          ? `错误：记忆文件 '${filePath}' 已存在。请使用 replace_personal_memory 更新它。`
          : `Error: Memory file '${filePath}' already exists. Use replace_personal_memory to update it.`,
      );
    }

    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');

    return formatToolActionResult(language, 'added');
  },
};

export const dropPersonalMemoryTool: FuncTool = {
  type: 'func',
  name: 'drop_personal_memory',
  description:
    'Remove a memory file from the personal memory store (private to the current agent).',
  descriptionI18n: {
    en: 'Remove a memory file from the personal memory store (private to the current agent).',
    zh: '从个人记忆库删除一个记忆文件（仅当前智能体可见）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Relative path inside your personal memory store.' },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const pathValue = args['path'];
    const filePath = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!filePath) {
      return toolFailure(
        language === 'zh' ? '错误：需要提供文件路径。' : 'Error: File path is required.',
      );
    }

    const memoryPath = getMemoryPath({ language, caller, filePath });
    if (memoryPath.kind === 'invalid_path') {
      return toolFailure(memoryPath.message);
    }

    const fullPath = path.resolve(process.cwd(), memoryPath.rel);

    if (!fs.existsSync(fullPath)) {
      return toolFailure(
        language === 'zh'
          ? `错误：记忆文件 '${filePath}' 不存在。`
          : `Error: Memory file '${filePath}' does not exist.`,
      );
    }

    fs.unlinkSync(fullPath);

    return formatToolActionResult(language, 'deleted');
  },
};

export const replacePersonalMemoryTool: FuncTool = {
  type: 'func',
  name: 'replace_personal_memory',
  description:
    'Replace the content of an existing memory file in the personal memory store (private to the current agent).',
  descriptionI18n: {
    en: 'Replace the content of an existing memory file in the personal memory store (private to the current agent).',
    zh: '替换个人记忆库中已存在记忆文件的内容（仅当前智能体可见）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'Relative path inside your personal memory store.' },
      content: { type: 'string', description: 'New memory content (written as-is).' },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const pathValue = args['path'];
    const contentValue = args['content'];
    const filePath = typeof pathValue === 'string' ? pathValue.trim() : '';
    const content = typeof contentValue === 'string' ? contentValue : '';
    if (!filePath) {
      return toolFailure(
        language === 'zh' ? '错误：需要提供文件路径。' : 'Error: File path is required.',
      );
    }
    if (content.length === 0) {
      return toolFailure(
        language === 'zh'
          ? '错误：需要提供记忆内容（content）。'
          : 'Error: Memory content is required (content).',
      );
    }

    const memoryPath = getMemoryPath({ language, caller, filePath });
    if (memoryPath.kind === 'invalid_path') {
      return toolFailure(memoryPath.message);
    }

    const fullPath = path.resolve(process.cwd(), memoryPath.rel);

    if (!fs.existsSync(fullPath)) {
      return toolFailure(
        language === 'zh'
          ? `错误：记忆文件 '${filePath}' 不存在。请使用 add_personal_memory 创建它。`
          : `Error: Memory file '${filePath}' does not exist. Use add_personal_memory to create it.`,
      );
    }

    fs.writeFileSync(fullPath, content, 'utf8');

    return formatToolActionResult(language, 'updated');
  },
};

export const clearPersonalMemoryTool: FuncTool = {
  type: 'func',
  name: 'clear_personal_memory',
  description:
    'Clear all memory files from the personal memory store (private to the current agent).',
  descriptionI18n: {
    en: 'Clear all memory files from the personal memory store (private to the current agent).',
    zh: '清空个人记忆库中的所有记忆文件（仅当前智能体可见）。',
  },
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  argsValidation: 'dominds',
  async call(_dlg, caller, _args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const memoryDir = path.join('.minds/memory/individual', caller.id);

    const fullPath = path.resolve(process.cwd(), memoryDir);

    if (!fs.existsSync(fullPath)) {
      return toolSuccess(
        language === 'zh' ? '没有可清空的个人记忆。' : 'No personal memory to clear.',
      );
    }

    fs.rmSync(fullPath, { recursive: true, force: true });
    fs.mkdirSync(fullPath, { recursive: true });

    return formatToolActionResult(language, 'cleared');
  },
};

export const addSharedMemoryTool: FuncTool = {
  type: 'func',
  name: 'add_team_memory',
  description: 'Add a new memory file to the shared team memory store.',
  descriptionI18n: {
    en: 'Add a new memory file to the shared team memory store.',
    zh: '向团队共享记忆库新增一个记忆文件。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'Relative path inside the shared team memory store.' },
      content: { type: 'string', description: 'Shared memory content (written as-is).' },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const pathValue = args['path'];
    const contentValue = args['content'];
    const filePath = typeof pathValue === 'string' ? pathValue.trim() : '';
    const content = typeof contentValue === 'string' ? contentValue : '';
    if (!filePath) {
      return toolFailure(
        language === 'zh' ? '错误：需要提供文件路径。' : 'Error: File path is required.',
      );
    }
    if (content.length === 0) {
      return toolFailure(
        language === 'zh'
          ? '错误：需要提供共享记忆内容（content）。'
          : 'Error: Shared memory content is required (content).',
      );
    }

    const memoryPath = getMemoryPath({ language, caller, filePath, isShared: true });
    if (memoryPath.kind === 'invalid_path') {
      return toolFailure(memoryPath.message);
    }

    const fullPath = path.resolve(process.cwd(), memoryPath.rel);

    if (fs.existsSync(fullPath)) {
      return toolFailure(
        language === 'zh'
          ? `错误：共享记忆文件 '${filePath}' 已存在。请使用 replace_team_memory 更新它。`
          : `Error: Shared memory file '${filePath}' already exists. Use replace_team_memory to update it.`,
      );
    }

    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');

    return formatToolActionResult(language, 'added');
  },
};

export const dropSharedMemoryTool: FuncTool = {
  type: 'func',
  name: 'drop_team_memory',
  description: 'Remove a memory file from the shared team memory store.',
  descriptionI18n: {
    en: 'Remove a memory file from the shared team memory store.',
    zh: '从团队共享记忆库删除一个记忆文件。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Relative path inside the shared team memory store.' },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const pathValue = args['path'];
    const filePath = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!filePath) {
      return toolFailure(
        language === 'zh' ? '错误：需要提供文件路径。' : 'Error: File path is required.',
      );
    }

    const memoryPath = getMemoryPath({ language, caller, filePath, isShared: true });
    if (memoryPath.kind === 'invalid_path') {
      return toolFailure(memoryPath.message);
    }

    const fullPath = path.resolve(process.cwd(), memoryPath.rel);

    if (!fs.existsSync(fullPath)) {
      return toolFailure(
        language === 'zh'
          ? `错误：共享记忆文件 '${filePath}' 不存在。`
          : `Error: Shared memory file '${filePath}' does not exist.`,
      );
    }

    fs.unlinkSync(fullPath);

    return formatToolActionResult(language, 'deleted');
  },
};

export const replaceSharedMemoryTool: FuncTool = {
  type: 'func',
  name: 'replace_team_memory',
  description: 'Replace the content of an existing memory file in the shared team memory store.',
  descriptionI18n: {
    en: 'Replace the content of an existing memory file in the shared team memory store.',
    zh: '替换团队共享记忆库中已存在记忆文件的内容。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'Relative path inside the shared team memory store.' },
      content: { type: 'string', description: 'New shared memory content (written as-is).' },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const pathValue = args['path'];
    const contentValue = args['content'];
    const filePath = typeof pathValue === 'string' ? pathValue.trim() : '';
    const content = typeof contentValue === 'string' ? contentValue : '';
    if (!filePath) {
      return toolFailure(
        language === 'zh' ? '错误：需要提供文件路径。' : 'Error: File path is required.',
      );
    }
    if (content.length === 0) {
      return toolFailure(
        language === 'zh'
          ? '错误：需要提供共享记忆内容（content）。'
          : 'Error: Shared memory content is required (content).',
      );
    }

    const memoryPath = getMemoryPath({ language, caller, filePath, isShared: true });
    if (memoryPath.kind === 'invalid_path') {
      return toolFailure(memoryPath.message);
    }

    const fullPath = path.resolve(process.cwd(), memoryPath.rel);

    if (!fs.existsSync(fullPath)) {
      return toolFailure(
        language === 'zh'
          ? `错误：共享记忆文件 '${filePath}' 不存在。请使用 add_team_memory 创建它。`
          : `Error: Shared memory file '${filePath}' does not exist. Use add_team_memory to create it.`,
      );
    }

    fs.writeFileSync(fullPath, content, 'utf8');

    return formatToolActionResult(language, 'updated');
  },
};

export const clearSharedMemoryTool: FuncTool = {
  type: 'func',
  name: 'clear_team_memory',
  description: 'Clear all files from the shared team memory store.',
  descriptionI18n: {
    en: 'Clear all files from the shared team memory store.',
    zh: '清空团队共享记忆库中的所有文件。',
  },
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  argsValidation: 'dominds',
  async call(_dlg, _caller, _args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const memoryDir = '.minds/memory/team_shared';

    const fullPath = path.resolve(process.cwd(), memoryDir);

    if (!fs.existsSync(fullPath)) {
      return toolSuccess(
        language === 'zh' ? '没有可清空的共享记忆。' : 'No shared memory to clear.',
      );
    }

    fs.rmSync(fullPath, { recursive: true, force: true });
    fs.mkdirSync(fullPath, { recursive: true });

    return formatToolActionResult(language, 'cleared');
  },
};
