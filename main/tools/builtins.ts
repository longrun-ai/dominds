/**
 * Module: tools/builtins
 *
 * Registers built-in tools, toolsets, and reminder owners.
 *
 * Entry points (server/cli) must import this module once to populate registries.
 */

import { contextHealthReminderOwner } from './context-health';
import {
  addReminderTool,
  changeMindTool,
  clearMindTool,
  deleteReminderTool,
  updateReminderTool,
} from './ctrl';
import { envGetTool, envSetTool, envUnsetTool } from './env';
import { listDirTool, mkDirTool, moveDirTool, moveFileTool, rmDirTool, rmFileTool } from './fs';
import { mcpLeaseReminderOwner, mcpReleaseTool, mcpRestartTool } from './mcp';
import {
  addMemoryTool,
  addSharedMemoryTool,
  clearMemoryTool,
  clearSharedMemoryTool,
  dropMemoryTool,
  dropSharedMemoryTool,
  replaceMemoryTool,
  replaceSharedMemoryTool,
} from './mem';
import { getDaemonOutputTool, shellCmdReminderOwner, shellCmdTool, stopDaemonTool } from './os';
import { registerReminderOwner, registerTool, registerToolset, setToolsetMeta } from './registry';
import {
  ripgrepCountTool,
  ripgrepFilesTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
  ripgrepSnippetsTool,
} from './ripgrep';
import { teamMgmtTools } from './team-mgmt';
import {
  appendFileTool,
  applyFileModificationTool,
  insertAfterTool,
  insertBeforeTool,
  overwriteFileTool,
  planFileModificationTool,
  readFileTool,
  replaceBlockTool,
  replaceFileContentsTool,
} from './txt';

registerTool(listDirTool);
registerTool(rmDirTool);
registerTool(rmFileTool);
registerTool(mkDirTool);
registerTool(moveFileTool);
registerTool(moveDirTool);
registerTool(readFileTool);
registerTool(overwriteFileTool);
registerTool(replaceFileContentsTool);
registerTool(planFileModificationTool);
registerTool(applyFileModificationTool);
registerTool(appendFileTool);
registerTool(insertAfterTool);
registerTool(insertBeforeTool);
registerTool(replaceBlockTool);

// Ripgrep tools
registerTool(ripgrepFilesTool);
registerTool(ripgrepSnippetsTool);
registerTool(ripgrepCountTool);
registerTool(ripgrepFixedTool);
registerTool(ripgrepSearchTool);

// OS tools
registerTool(shellCmdTool);
registerTool(stopDaemonTool);
registerTool(getDaemonOutputTool);

// Env tools (local testing)
registerTool(envGetTool);
registerTool(envSetTool);
registerTool(envUnsetTool);

// MCP tools (local testing/ops)
registerTool(mcpRestartTool);
registerTool(mcpReleaseTool);

// Memory tools
registerTool(addMemoryTool);
registerTool(dropMemoryTool);
registerTool(replaceMemoryTool);
registerTool(clearMemoryTool);
registerTool(addSharedMemoryTool);
registerTool(dropSharedMemoryTool);
registerTool(replaceSharedMemoryTool);
registerTool(clearSharedMemoryTool);

// Control tools
registerTool(addReminderTool);
registerTool(deleteReminderTool);
registerTool(updateReminderTool);
registerTool(clearMindTool);
registerTool(changeMindTool);

// Team management tools (scoped to `.minds/**`)
for (const tool of teamMgmtTools) {
  registerTool(tool);
}

// Register well-known toolsets
registerToolset('memory', [addMemoryTool, dropMemoryTool, replaceMemoryTool, clearMemoryTool]);
setToolsetMeta('memory', {
  descriptionI18n: { en: 'Personal memory tools', zh: '个人记忆工具' },
});
registerToolset('team_memory', [
  addSharedMemoryTool,
  dropSharedMemoryTool,
  replaceSharedMemoryTool,
  clearSharedMemoryTool,
]);
setToolsetMeta('team_memory', {
  descriptionI18n: { en: 'Shared team memory tools', zh: '团队共享记忆工具' },
});
registerToolset('control', [
  addReminderTool,
  deleteReminderTool,
  updateReminderTool,
  clearMindTool,
  changeMindTool,
]);
setToolsetMeta('control', {
  descriptionI18n: { en: 'Dialog control tools', zh: '对话控制工具' },
});
registerToolset('os', [
  shellCmdTool,
  stopDaemonTool,
  getDaemonOutputTool,
  envGetTool,
  envSetTool,
  envUnsetTool,
]);
setToolsetMeta('os', {
  descriptionI18n: { en: 'Shell and process tools', zh: '命令行与进程工具' },
});
registerToolset('mcp_admin', [
  mcpRestartTool,
  mcpReleaseTool,
  envGetTool,
  envSetTool,
  envUnsetTool,
]);
setToolsetMeta('mcp_admin', {
  descriptionI18n: { en: 'MCP administration tools', zh: 'MCP 管理工具' },
});
registerToolset('ws_read', [
  listDirTool,
  readFileTool,
  ripgrepFilesTool,
  ripgrepSnippetsTool,
  ripgrepCountTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
]);
setToolsetMeta('ws_read', {
  descriptionI18n: { en: 'Workspace read-only tools', zh: '工作区只读工具' },
});
registerToolset('ws_mod', [
  listDirTool,
  rmDirTool,
  rmFileTool,
  mkDirTool,
  moveFileTool,
  moveDirTool,
  readFileTool,
  overwriteFileTool,
  replaceFileContentsTool,
  appendFileTool,
  insertAfterTool,
  insertBeforeTool,
  replaceBlockTool,
  planFileModificationTool,
  applyFileModificationTool,
  ripgrepFilesTool,
  ripgrepSnippetsTool,
  ripgrepCountTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
]);
setToolsetMeta('ws_mod', {
  descriptionI18n: { en: 'Workspace read/write tools', zh: '工作区读写工具' },
});
registerToolset('team-mgmt', [...teamMgmtTools]);
setToolsetMeta('team-mgmt', {
  descriptionI18n: { en: 'Team management tools', zh: '团队管理工具' },
});

// Register ReminderOwners
registerReminderOwner(shellCmdReminderOwner);
registerReminderOwner(contextHealthReminderOwner);
registerReminderOwner(mcpLeaseReminderOwner);
