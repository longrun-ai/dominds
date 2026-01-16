/**
 * Module: tools/mem
 *
 * Memory management texting tools for personal and shared memory under `.minds/memory`.
 * Add, drop, replace, clear operations with access control.
 */
import fs from 'fs';
import path from 'path';
import { getAccessDeniedMessage, hasWriteAccess } from '../access-control';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { formatToolActionResult } from '../shared/i18n/tool-result-messages';
import type { Team } from '../team';
import { TextingTool, TextingToolCallResult } from '../tool';

function env(content: string): ChatMessage[] {
  return [{ type: 'environment_msg', role: 'user', content }] satisfies ChatMessage[];
}

function ok(result?: string): TextingToolCallResult {
  return { status: 'completed', result };
}

function fail(result: string): TextingToolCallResult {
  return { status: 'failed', result, messages: env(result) };
}

function getMemoryPath(caller: Team.Member, filePath: string, isShared: boolean = false): string {
  // Prevent path traversal by rejecting paths with '..'
  if (filePath.includes('..')) {
    throw new Error('Path traversal not allowed in memory paths');
  }

  const mindsDir = '.minds/memory';
  if (isShared) {
    return path.join(mindsDir, 'team_shared', filePath);
  } else {
    return path.join(mindsDir, 'individual', caller.id, filePath);
  }
}

export const addMemoryTool: TextingTool = {
  type: 'texter',
  name: 'add_memory',
  backfeeding: false,
  usageDescription: `I can add new memory content to my personal memory store.
Usage: @add_memory <relative-file-path.md>
<memory content in body>

Examples:
  @add_memory notes/project-insights.md
  # Project Insights
  Key findings from today's work...
  
  @add_memory tasks/current-focus.md
  ## Current Focus Areas
  - Feature implementation
  - Bug fixes`,
  usageDescriptionI18n: {
    en: `I can add new memory content to my personal memory store.
Usage: @add_memory <relative-file-path.md>
<memory content in body>

Examples:
  @add_memory notes/project-insights.md
  # Project Insights
  Key findings from today's work...
  
  @add_memory tasks/current-focus.md
  ## Current Focus Areas
  - Feature implementation
  - Bug fixes`,
    zh: `我可以将新的记忆内容写入个人记忆库。
用法：@add_memory <relative-file-path.md>
<正文中提供记忆内容>

示例：
  @add_memory notes/project-insights.md
  # Project Insights
  Key findings from today's work...
  
  @add_memory tasks/current-focus.md
  ## Current Focus Areas
  - Feature implementation
  - Bug fixes`,
  },
  async call(dlg: Dialog, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const trimmed = headLine.trim();

    if (!trimmed.startsWith('@add_memory')) {
      return fail('Error: Invalid format. Use @add_memory <relative-file-path>');
    }

    const afterToolName = trimmed.slice('@add_memory'.length).trim();
    if (!afterToolName) {
      return fail('Error: File path is required.');
    }

    const filePath = afterToolName.split(/\s+/)[0];
    if (!filePath) {
      return fail('Error: File path is required.');
    }

    if (!inputBody) {
      return fail('Error: Memory content is required in the body.');
    }

    const memoryPath = getMemoryPath(caller, filePath);

    if (!hasWriteAccess(caller, memoryPath)) {
      return fail(getAccessDeniedMessage('write', memoryPath));
    }

    const fullPath = path.resolve(process.cwd(), memoryPath);

    if (fs.existsSync(fullPath)) {
      return fail(
        `Error: Memory file '${filePath}' already exists. Use @replace_memory to update it.`,
      );
    }

    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, inputBody, 'utf8');

    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'added'));
  },
};

export const dropMemoryTool: TextingTool = {
  type: 'texter',
  name: 'drop_memory',
  backfeeding: false,
  usageDescription: `I can remove a memory file from my personal memory store.
Usage: @drop_memory <relative-file-path.md>

Examples:
  @drop_memory notes/old-ideas.md
  @drop_memory tasks/completed-task.md`,
  usageDescriptionI18n: {
    en: `I can remove a memory file from my personal memory store.
Usage: @drop_memory <relative-file-path.md>

Examples:
  @drop_memory notes/old-ideas.md
  @drop_memory tasks/completed-task.md`,
    zh: `我可以从个人记忆库中删除一个记忆文件。
用法：@drop_memory <relative-file-path.md>

示例：
  @drop_memory notes/old-ideas.md
  @drop_memory tasks/completed-task.md`,
  },
  async call(dlg: Dialog, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const trimmed = headLine.trim();

    if (!trimmed.startsWith('@drop_memory')) {
      return fail('Error: Invalid format. Use @drop_memory <relative-file-path>');
    }

    const afterToolName = trimmed.slice('@drop_memory'.length).trim();
    if (!afterToolName) {
      return fail('Error: File path is required.');
    }

    const filePath = afterToolName.split(/\s+/)[0];
    if (!filePath) {
      return fail('Error: File path is required.');
    }

    const memoryPath = getMemoryPath(caller, filePath);

    if (!hasWriteAccess(caller, memoryPath)) {
      return fail(getAccessDeniedMessage('write', memoryPath));
    }

    const fullPath = path.resolve(process.cwd(), memoryPath);

    if (!fs.existsSync(fullPath)) {
      return fail(`Error: Memory file '${filePath}' does not exist.`);
    }

    fs.unlinkSync(fullPath);

    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'deleted'));
  },
};

export const replaceMemoryTool: TextingTool = {
  type: 'texter',
  name: 'replace_memory',
  backfeeding: false,
  usageDescription: `I can replace the content of an existing memory file in my personal memory store.
Usage: @replace_memory <relative-file-path.md>
<new memory content in body>

Examples:
  @replace_memory notes/project-status.md
  # Updated Project Status
  Current progress and next steps...`,
  usageDescriptionI18n: {
    en: `I can replace the content of an existing memory file in my personal memory store.
Usage: @replace_memory <relative-file-path.md>
<new memory content in body>

Examples:
  @replace_memory notes/project-status.md
  # Updated Project Status
  Current progress and next steps...`,
    zh: `我可以替换个人记忆库中某个已存在记忆文件的内容。
用法：@replace_memory <relative-file-path.md>
<正文中提供新的记忆内容>

示例：
  @replace_memory notes/project-status.md
  # Updated Project Status
  Current progress and next steps...`,
  },
  async call(dlg: Dialog, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const trimmed = headLine.trim();

    if (!trimmed.startsWith('@replace_memory')) {
      return fail('Error: Invalid format. Use @replace_memory <relative-file-path>');
    }

    const afterToolName = trimmed.slice('@replace_memory'.length).trim();
    if (!afterToolName) {
      return fail('Error: File path is required.');
    }

    const filePath = afterToolName.split(/\s+/)[0];
    if (!filePath) {
      return fail('Error: File path is required.');
    }

    if (!inputBody) {
      return fail('Error: Memory content is required in the body.');
    }

    const memoryPath = getMemoryPath(caller, filePath);

    if (!hasWriteAccess(caller, memoryPath)) {
      return fail(getAccessDeniedMessage('write', memoryPath));
    }

    const fullPath = path.resolve(process.cwd(), memoryPath);

    if (!fs.existsSync(fullPath)) {
      return fail(`Error: Memory file '${filePath}' does not exist. Use @add_memory to create it.`);
    }

    fs.writeFileSync(fullPath, inputBody, 'utf8');

    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'updated'));
  },
};

export const clearMemoryTool: TextingTool = {
  type: 'texter',
  name: 'clear_memory',
  backfeeding: false,
  usageDescription: `I can clear all memory files from my personal memory store.
Usage: @clear_memory

This will remove all files in my personal memory directory.`,
  usageDescriptionI18n: {
    en: `I can clear all memory files from my personal memory store.
Usage: @clear_memory

This will remove all files in my personal memory directory.`,
    zh: `我可以清空个人记忆库中的所有记忆文件。
用法：@clear_memory

这会删除个人记忆目录下的所有文件。`,
  },
  async call(dlg: Dialog, caller, _headLine, _inputBody): Promise<TextingToolCallResult> {
    const memoryDir = path.join('.minds/memory/individual', caller.id);

    if (!hasWriteAccess(caller, memoryDir)) {
      return fail(getAccessDeniedMessage('write', memoryDir));
    }

    const fullPath = path.resolve(process.cwd(), memoryDir);

    if (!fs.existsSync(fullPath)) {
      return fail('No personal memory to clear.');
    }

    fs.rmSync(fullPath, { recursive: true, force: true });
    fs.mkdirSync(fullPath, { recursive: true });

    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'cleared'));
  },
};

export const addSharedMemoryTool: TextingTool = {
  type: 'texter',
  name: 'add_team_memory',
  backfeeding: false,
  usageDescription: `I can add new content to the shared memory store accessible by all team members.
Usage: @add_team_memory <relative-file-path.md>
<shared memory content in body>

Examples:
  @add_team_memory project/requirements.md
  # Project Requirements
  Core requirements for the project...
  
  @add_team_memory team/decisions.md
  ## Team Decisions
  Important decisions made by the team...`,
  usageDescriptionI18n: {
    en: `I can add new content to the shared memory store accessible by all team members.
Usage: @add_team_memory <relative-file-path.md>
<shared memory content in body>

Examples:
  @add_team_memory project/requirements.md
  # Project Requirements
  Core requirements for the project...
  
  @add_team_memory team/decisions.md
  ## Team Decisions
  Important decisions made by the team...`,
    zh: `我可以向所有团队成员可访问的共享记忆库添加新内容。
用法：@add_team_memory <relative-file-path.md>
<正文中提供共享记忆内容>

示例：
  @add_team_memory project/requirements.md
  # Project Requirements
  Core requirements for the project...
  
  @add_team_memory team/decisions.md
  ## Team Decisions
  Important decisions made by the team...`,
  },
  async call(dlg: Dialog, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const trimmed = headLine.trim();

    if (!trimmed.startsWith('@add_team_memory')) {
      return fail('Error: Invalid format. Use @add_team_memory <relative-file-path>');
    }

    const afterToolName = trimmed.slice('@add_team_memory'.length).trim();
    if (!afterToolName) {
      return fail('Error: File path is required.');
    }

    const filePath = afterToolName.split(/\s+/)[0];
    if (!filePath) {
      return fail('Error: File path is required.');
    }

    if (!inputBody) {
      return fail('Error: Shared memory content is required in the body.');
    }

    const memoryPath = getMemoryPath(caller, filePath, true);

    if (!hasWriteAccess(caller, memoryPath)) {
      return fail(getAccessDeniedMessage('write', memoryPath));
    }

    const fullPath = path.resolve(process.cwd(), memoryPath);

    if (fs.existsSync(fullPath)) {
      return fail(
        `Error: Shared memory file '${filePath}' already exists. Use @replace_team_memory to update it.`,
      );
    }

    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, inputBody, 'utf8');

    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'added'));
  },
};

export const dropSharedMemoryTool: TextingTool = {
  type: 'texter',
  name: 'drop_team_memory',
  backfeeding: false,
  usageDescription: `I can remove a file from the shared memory store.
Usage: @drop_team_memory <relative-file-path.md>

Examples:
  @drop_team_memory project/old-requirements.md
  @drop_team_memory team/outdated-decisions.md`,
  usageDescriptionI18n: {
    en: `I can remove a file from the shared memory store.
Usage: @drop_team_memory <relative-file-path.md>

Examples:
  @drop_team_memory project/old-requirements.md
  @drop_team_memory team/outdated-decisions.md`,
    zh: `我可以从共享记忆库中删除一个文件。
用法：@drop_team_memory <relative-file-path.md>

示例：
  @drop_team_memory project/old-requirements.md
  @drop_team_memory team/outdated-decisions.md`,
  },
  async call(dlg: Dialog, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const trimmed = headLine.trim();

    if (!trimmed.startsWith('@drop_team_memory')) {
      return fail('Error: Invalid format. Use @drop_team_memory <relative-file-path>');
    }

    const afterToolName = trimmed.slice('@drop_team_memory'.length).trim();
    if (!afterToolName) {
      return fail('Error: File path is required.');
    }

    const filePath = afterToolName.split(/\s+/)[0];
    if (!filePath) {
      return fail('Error: File path is required.');
    }

    const memoryPath = getMemoryPath(caller, filePath, true);

    if (!hasWriteAccess(caller, memoryPath)) {
      return fail(getAccessDeniedMessage('write', memoryPath));
    }

    const fullPath = path.resolve(process.cwd(), memoryPath);

    if (!fs.existsSync(fullPath)) {
      return fail(`Error: Shared memory file '${filePath}' does not exist.`);
    }

    fs.unlinkSync(fullPath);

    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'deleted'));
  },
};

export const replaceSharedMemoryTool: TextingTool = {
  type: 'texter',
  name: 'replace_team_memory',
  backfeeding: false,
  usageDescription: `I can replace the content of an existing shared memory file.
Usage: @replace_team_memory <relative-file-path.md>
<new shared memory content in body>

Examples:
  @replace_team_memory project/requirements.md
  # Updated Project Requirements
  Revised requirements based on feedback...`,
  usageDescriptionI18n: {
    en: `I can replace the content of an existing shared memory file.
Usage: @replace_team_memory <relative-file-path.md>
<new shared memory content in body>

Examples:
  @replace_team_memory project/requirements.md
  # Updated Project Requirements
  Revised requirements based on feedback...`,
    zh: `我可以替换共享记忆库中某个已存在记忆文件的内容。
用法：@replace_team_memory <relative-file-path.md>
<正文中提供新的共享记忆内容>

示例：
  @replace_team_memory project/requirements.md
  # Updated Project Requirements
  Revised requirements based on feedback...`,
  },
  async call(dlg: Dialog, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const trimmed = headLine.trim();

    if (!trimmed.startsWith('@replace_team_memory')) {
      return fail('Error: Invalid format. Use @replace_team_memory <relative-file-path>');
    }

    const afterToolName = trimmed.slice('@replace_team_memory'.length).trim();
    if (!afterToolName) {
      return fail('Error: File path is required.');
    }

    const filePath = afterToolName.split(/\s+/)[0];
    if (!filePath) {
      return fail('Error: File path is required.');
    }

    if (!inputBody) {
      return fail('Error: Shared memory content is required in the body.');
    }

    const memoryPath = getMemoryPath(caller, filePath, true);

    if (!hasWriteAccess(caller, memoryPath)) {
      return fail(getAccessDeniedMessage('write', memoryPath));
    }

    const fullPath = path.resolve(process.cwd(), memoryPath);

    if (!fs.existsSync(fullPath)) {
      return fail(
        `Error: Shared memory file '${filePath}' does not exist. Use @add_team_memory to create it.`,
      );
    }

    fs.writeFileSync(fullPath, inputBody, 'utf8');

    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'updated'));
  },
};

export const clearSharedMemoryTool: TextingTool = {
  type: 'texter',
  name: 'clear_team_memory',
  backfeeding: false,
  usageDescription: `I can clear all files from the shared memory store.
Usage: @clear_team_memory

This will remove all files in the shared memory directory.`,
  usageDescriptionI18n: {
    en: `I can clear all files from the shared memory store.
Usage: @clear_team_memory

This will remove all files in the shared memory directory.`,
    zh: `我可以清空共享记忆库中的所有文件。
用法：@clear_team_memory

这会删除共享记忆目录下的所有文件。`,
  },
  async call(dlg: Dialog, caller, _headLine, _inputBody): Promise<TextingToolCallResult> {
    const memoryDir = '.minds/memory/team_shared';

    if (!hasWriteAccess(caller, memoryDir)) {
      return fail(getAccessDeniedMessage('write', memoryDir));
    }

    const fullPath = path.resolve(process.cwd(), memoryDir);

    if (!fs.existsSync(fullPath)) {
      return fail('No shared memory to clear.');
    }

    fs.rmSync(fullPath, { recursive: true, force: true });
    fs.mkdirSync(fullPath, { recursive: true });

    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'cleared'));
  },
};
